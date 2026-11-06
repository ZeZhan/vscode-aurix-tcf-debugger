import { FindByNameSymbolsCommand, GetContextSymbolsCommand, TCFSymbolClass, TCFSymbolContextData, TCFTypeClass } from '../tcf/symbols';
import { SimpleCommand } from '../tcf/tcfutils';
import { validateVariableSize } from './inspection';
import { SYM_FLAG_EXTERNAL } from './symbol';
import { resolveVariableTypeName } from './typeName';

export function isIncompleteExternalArray(type: TCFSymbolContextData, symbol: TCFSymbolContextData): boolean {
	return type.TypeClass === TCFTypeClass.array && type.Size === 0 && type.Length === 0 &&
		symbol.Class === TCFSymbolClass.reference && symbol.TypeClass === TCFTypeClass.array &&
		symbol.Size === 0 && !!((symbol.Flags ?? 0) & SYM_FLAG_EXTERNAL);
}

export async function resolveArrayDefinition(
	contextId: string, declarationType: TCFSymbolContextData, declaration: TCFSymbolContextData,
	send: <T>(command: SimpleCommand<T>) => Promise<T>
): Promise<{ type: TCFSymbolContextData; symbol: TCFSymbolContextData }> {
	const address = declaration.Address;
	if (!isIncompleteExternalArray(declarationType, declaration) || declarationType.Class !== TCFSymbolClass.type ||
		declaration.TypeID !== declarationType.ID || !declaration.Name || !/^[A-Za-z_][A-Za-z_0-9]*$/.test(declaration.Name) ||
		address === undefined || !Number.isSafeInteger(address) || address < 0 || address > 0xffffffff) {
		throw new Error('Cannot resolve incomplete array: invalid declaration identity or storage.');
	}
	const cache = new Map<string, TCFSymbolContextData>([[declaration.ID, declaration], [declarationType.ID, declarationType]]);
	let reads = 0;
	const read = async (id: string): Promise<TCFSymbolContextData> => {
		if (!id || id.length > 4096) { throw new Error('Cannot resolve incomplete array: invalid symbol ID.'); }
		const cached = cache.get(id);
		if (cached) { return cached; }
		if (++reads > 128) { throw new Error('Cannot resolve incomplete array: metadata lookup limit exceeded.'); }
		const result = await send(new GetContextSymbolsCommand(id));
		if (result.ID !== id) { throw new Error('Cannot resolve incomplete array: returned symbol identity mismatch.'); }
		cache.set(id, result);
		return result;
	};
	const elementSignature = async (array: TCFSymbolContextData) => {
		if (array.Class !== TCFSymbolClass.type || array.TypeClass !== TCFTypeClass.array || !array.BaseTypeID) {
			throw new Error('Cannot resolve incomplete array: missing array element metadata.');
		}
		const element = await read(array.BaseTypeID);
		if (element.Class !== TCFSymbolClass.type ||
			![TCFTypeClass.integer, TCFTypeClass.cardinal, TCFTypeClass.real].includes(element.TypeClass ?? TCFTypeClass.unknown) ||
			![1, 2, 4, 8].includes(element.Size ?? 0)) {
			throw new Error('Cannot resolve incomplete array: only matching primitive element types are supported.');
		}
		const name = await resolveVariableTypeName(element, async id => {
			const next = await read(id);
			if (next.TypeClass !== element.TypeClass || next.Size !== element.Size) {
				throw new Error('Cannot resolve incomplete array: inconsistent element type wrapper.');
			}
			return next;
		});
		if (!name) { throw new Error('Cannot resolve incomplete array: element type name is unavailable.'); }
		return { name, size: element.Size, kind: element.TypeClass, qualifiers: (element.Flags ?? 0) & 0x30 };
	};
	const expected = await elementSignature(declarationType);
	const ids = await send(new FindByNameSymbolsCommand(contextId, declaration.Name));
	if (!ids?.length || ids.length > 64 || new Set(ids).size !== ids.length) {
		throw new Error('Cannot resolve incomplete array: missing, duplicate or excessive global candidates.');
	}
	let definition: { type: TCFSymbolContextData; symbol: TCFSymbolContextData } | undefined;
	for (const id of ids) {
		const symbol = await read(id);
		if (symbol.Name !== declaration.Name) { throw new Error('Cannot resolve incomplete array: global symbol name mismatch.'); }
		// Ignore other storage, incomplete declarations and untyped linker symbols.
		if (symbol.Class !== TCFSymbolClass.reference || !((symbol.Flags ?? 0) & SYM_FLAG_EXTERNAL) ||
			symbol.Address !== address || symbol.Size === 0 || !symbol.TypeID || symbol.TypeClass === TCFTypeClass.unknown) { continue; }
		const type = await read(symbol.TypeID);
		const actual = await elementSignature(type);
		const size = validateVariableSize(type.Size);
		if (symbol.TypeClass !== TCFTypeClass.array || symbol.Size !== size ||
			!Number.isSafeInteger(type.Length) || type.Length === undefined || type.Length < 1 ||
			actual.size === undefined || actual.size * type.Length !== size || address + size > 0x100000000 ||
			JSON.stringify(actual) !== JSON.stringify(expected) ||
			((type.Flags ?? 0) & 0x3030) !== ((declarationType.Flags ?? 0) & 0x3030) ||
			((symbol.Flags ?? 0) & 0x3000) !== ((declaration.Flags ?? 0) & 0x3000)) {
			throw new Error('Cannot resolve incomplete array: definition type or storage extent conflicts with the declaration.');
		}
		if (definition) { throw new Error('Cannot resolve incomplete array: multiple complete definitions are ambiguous.'); }
		definition = { type, symbol };
	}
	if (!definition) { throw new Error('Cannot resolve incomplete array: no matching complete global definition.'); }
	return definition;
}
