import { DefaultVariableHelper } from './helper';
import { ClientVariable, FixedNameProvider, NameProvider, RawValueProvider } from './types';
import { GetChildrenSymbolsCommand, GetContextSymbolsCommand, TCFSymbolContextData, TCFTypeClass } from '../tcf/symbols';
import { SimpleCommand } from '../tcf/tcfutils';

export const MAX_VARIABLE_BYTES = 4096;
export type InspectionCheck = () => void;

export function validateVariableSize(size: number | undefined): number {
	if (!Number.isSafeInteger(size) || size === undefined || size < 1 || size > MAX_VARIABLE_BYTES) {
		throw new Error(`Variable size is missing or outside 1..${MAX_VARIABLE_BYTES} bytes.`);
	}
	return size;
}

export class InspectionVariableHelper extends DefaultVariableHelper {
	constructor(private readonly send: <T>(command: SimpleCommand<T>) => Promise<T>, private readonly check: InspectionCheck) { super(); }
	override async sendCommand<T>(command: SimpleCommand<T>): Promise<T> {
		this.check();
		if (command.service() !== 'Symbols') { throw new Error('Variable expansion cannot read memory, registers or evaluate expressions.'); }
		const result = await this.send(command);
		this.check();
		return result;
	}
	override log(message: string): void { throw new Error(message); }
	withCheck(check: InspectionCheck): InspectionVariableHelper { return new InspectionVariableHelper(this.send, check); }
	override createVariable(type: TCFSymbolContextData, symbol: TCFSymbolContextData | undefined, name: NameProvider, value: RawValueProvider): ClientVariable | undefined {
		const scalar = super.createVariable(type, symbol, name, value);
		return scalar ? new InspectedVariable(scalar, symbol, this) : undefined;
	}
}

// MCP expands only bytes already obtained for a variable. In particular, pointers are
// displayed as addresses, never dereferenced, and composite summaries never recurse.
export class InspectedVariable implements ClientVariable {
	readonly type: TCFSymbolContextData;
	constructor(private readonly variable: ClientVariable, private readonly symbol: TCFSymbolContextData | undefined,
		private readonly helper: InspectionVariableHelper) { this.type = variable.type; }
	name() { return this.variable.name(); }
	value() { return this.variable.value(); }
	isBigEndian() { return this.variable.isBigEndian(); }
	isRegister() { return this.variable.isRegister(); }
	get expandable(): boolean { return this.type.TypeClass === TCFTypeClass.array || this.type.TypeClass === TCFTypeClass.composite; }
	async displayValue(): Promise<string> {
		if (this.expandable) { return this.type.TypeClass === TCFTypeClass.array ? '[...]' : '{...}'; }
		if (this.type.TypeClass === TCFTypeClass.enumeration) {
			const bytes = await this.value();
			if (!bytes?.length) { throw new Error('Enum value unavailable.'); }
			return `0x${bytes.toString('hex')} (raw bytes)`;
		}
		if ((this.type.TypeClass === TCFTypeClass.integer || this.type.TypeClass === TCFTypeClass.cardinal) &&
			!/\bchar\b/i.test(this.type.Name ?? '')) {
			const bytes = await this.value();
			if (bytes?.length === 1) {
				return String(this.type.TypeClass === TCFTypeClass.integer ? bytes.readInt8() : bytes.readUInt8());
			}
		}
		const value = await this.variable.displayValue();
		if (value === undefined) { throw new Error('Variable value unavailable; not an empty value.'); }
		return value;
	}
	async getChildren(): Promise<ClientVariable[]> { throw new Error('MCP variable expansion requires an explicit page.'); }
	async page(start: number, count: number, check: InspectionCheck): Promise<{ variables: InspectedVariable[]; total: number }> {
		const helper = this.helper.withCheck(check);
		let fields: { type: TCFSymbolContextData; symbol?: TCFSymbolContextData; name: string; offset: number; size: number }[];
		let total: number;
		if (this.type.TypeClass === TCFTypeClass.array) {
			total = this.type.Length ?? -1;
			const size = validateVariableSize(this.type.Size);
			if (!Number.isSafeInteger(total) || total < 1 || !this.type.BaseTypeID || size % total !== 0) { throw new Error('Array layout is unavailable.'); }
			const elementSize = size / total;
			const type = await helper.sendCommand(new GetContextSymbolsCommand(this.type.BaseTypeID));
			if (type.Size !== elementSize) { throw new Error('Array element size does not match its layout.'); }
			fields = Array.from({ length: Math.max(0, Math.min(count, total - start)) }, (_, index) => ({
				type, name: `[${start + index}]`, offset: (start + index) * elementSize, size: elementSize,
			}));
		} else if (this.type.TypeClass === TCFTypeClass.composite) {
			const ids = await helper.sendCommand(new GetChildrenSymbolsCommand(this.symbol?.ID ?? this.type.ID)) ?? [];
			if (ids.length > 4096) { throw new Error('Composite metadata exceeds 4096 fields.'); }
			total = ids.length;
			fields = [];
			for (const id of ids.slice(start, start + count)) {
				const symbol = await helper.sendCommand(new GetContextSymbolsCommand(id));
				if (!symbol.TypeID || !symbol.Name || !Number.isSafeInteger(symbol.Offset) || symbol.Offset === undefined || symbol.Offset < 0 ||
					'BitSize' in symbol || 'BitOffset' in symbol || 'BitStride' in symbol) {
					throw new Error('Composite field layout is unavailable.');
				}
				const type = await helper.sendCommand(new GetContextSymbolsCommand(symbol.TypeID));
				const size = validateVariableSize(symbol.Size);
				if (type.Size !== size) { throw new Error('Bitfields or mismatched field layouts are not supported.'); }
				fields.push({ type, symbol, name: symbol.Name, offset: symbol.Offset, size });
			}
		} else { throw new Error('This variable is not expandable. Pointer dereferencing is not exposed.'); }
		const bytes = await this.value();
		if (!bytes) { throw new Error('Parent variable bytes are unavailable.'); }
		const variables = fields.map(field => {
			if (field.offset + field.size > bytes.length) { throw new Error('Field exceeds the available parent value.'); }
			const value: RawValueProvider = {
				value: async () => bytes.subarray(field.offset, field.offset + field.size),
				isBigEndian: () => this.isBigEndian(),
			};
			const child = helper.createVariable(field.type, field.symbol, new FixedNameProvider(field.name), value);
			if (!(child instanceof InspectedVariable)) { throw new Error(`Unsupported field type for ${field.name}.`); }
			return child;
		});
		return { variables, total };
	}
}
