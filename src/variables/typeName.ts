import { TCFSymbolClass, TCFSymbolContextData, TCFTypeClass } from '../tcf/symbols';
import { SYM_FLAG_TYPEDEF } from './symbol';

export async function resolveVariableTypeName(
	type: TCFSymbolContextData | undefined,
	readType: (id: string) => Promise<TCFSymbolContextData>
): Promise<string | undefined> {
	if (!type) { return undefined; }
	const visited = new Set<string>();
	let declaration = '';
	let current = type;
	for (let depth = 0; depth < 16; depth++) {
		if (current.Class !== TCFSymbolClass.type || !current.ID || visited.has(current.ID)) {
			throw new Error('Cannot resolve variable type: invalid or cyclic type metadata.');
		}
		visited.add(current.ID);
		const name = current.Name?.trim();
		if (name) {
			// A function signature cannot be reconstructed from a display name alone.
			if (declaration && current.TypeClass === TCFTypeClass.function && !((current.Flags ?? 0) & SYM_FLAG_TYPEDEF)) {
				return undefined;
			}
			return name + (declaration ? (declaration.startsWith('[') ? '' : ' ') + declaration : '');
		}
		let next: string | undefined;
		if (current.TypeID && current.TypeID !== current.ID) {
			// Qualified types can be unnamed wrappers around the original typedef.
			next = current.TypeID;
		} else if (current.TypeClass === TCFTypeClass.array && current.BaseTypeID) {
			if (current.Length !== undefined && (!Number.isSafeInteger(current.Length) || current.Length < 0)) {
				throw new Error('Cannot resolve variable type: invalid array length.');
			}
			declaration = (declaration.startsWith('*') ? `(${declaration})` : declaration) + `[${current.Length ?? ''}]`;
			next = current.BaseTypeID;
		} else if (current.TypeClass === TCFTypeClass.pointer && current.BaseTypeID) {
			declaration = '*' + declaration;
			next = current.BaseTypeID;
		} else {
			return undefined;
		}
		if (depth === 15) { throw new Error('Cannot resolve variable type: metadata exceeds 16 type nodes.'); }
		current = await readType(next);
		if (current.ID !== next) { throw new Error('Cannot resolve variable type: returned symbol identity does not match the requested type.'); }
	}
	throw new Error('Cannot resolve variable type: metadata exceeds 16 type nodes.');
}
