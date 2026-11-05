/*
Copyright (C) 2022, 2023 Intel Corporation
SPDX-License-Identifier: MIT
*/
// High-level TCF client helpers built on top of AbstractTCFClient
// - Adds RunControl and Breakpoints event handling
// - Implements common commands for RunControl, Breakpoints, StackTrace, Expressions, Symbols
// - debugProvider.ts uses TCFClient to implement the DAP debug adapter functionality
import { AbstractTCFClient } from "./tcf";
import { BreakpointData, BreakpointStatus, InstanceStatusData, asBreakpointData, asBreakpointStatus } from "./tcf/breakpoints";
import { CreateExpressionsCommand, DisposeExpressionsCommand, EvaluateExpressionsCommand, EvaluateResult, GetChildrenExpressionCommand, GetContextExpressionsCommand } from "./tcf/expressions";
import { MapToSourceLineNumbersCommand, TCFCodeAreaLineNumbers } from "./tcf/linenumbers";
import { GetMemoryCommand } from "./tcf/memory";
import { asNullableTCFContextData, asTCFContextData, ContextSuspendedData, GetChildrenRunControlCommand, GetContextRunControlCommand, GetStateRunControlCommand, parseContextSuspended, TCFContextData, TCFStateData } from "./tcf/runcontrol";
import { GetChildrenRangeStackTraceCommand, GetChildrenStackTraceCommand, GetContextStackTraceCommand, TCFContextDataStackTrace } from "./tcf/stacktrace";
import { FindByAddrSymbolsCommand, GetContextSymbolsCommand, TCFSymbolClass, TCFSymbolContextData, TCFTypeClass } from "./tcf/symbols";
import { ContextResetCapability, GetCapabilitiesContextResetCommand, ResetContextResetCommand } from "./tcf/contextreset";
import { TCFErrorCodes } from "./tcf/error";
import { asArray, asNullableArray, asString, asStringArray, CancellationFunction, EMPTY_BUFFER, InterruptedError, parseResponse, responseLengthAbout, SimpleCommand, TCFPartialResultError } from "./tcf/tcfutils";
import { DefaultVariableHelper } from "./variables/helper";
import { SymbolRawValueProvider } from "./variables/symbol";
import { ClientVariable, FixedNameProvider, RawValueProvider, SymbolNameProvider } from "./variables/types";
import { InspectionCheck, InspectionVariableHelper, validateVariableSize } from "./variables/inspection";
import { LocalInspectionError } from "./variables/inspectionDiagnostics";
import { CoreRegisterReader } from "./coreRegisters";
import * as validateBreakpointData from './tcf/validators/validate-BreakpointData';

class EvaluatedRawValueProvider implements RawValueProvider {
    constructor(private readonly rawValue: Buffer, private readonly bigEndian: boolean, private readonly size?: number) {
    }

    async value(): Promise<Buffer | undefined> {
        return decodeEvaluatedValue(this.rawValue, this.size);
    }

    isBigEndian(): boolean {
        return this.bigEndian;
    }
}

function tryDecodeBase64Text(text: string): Buffer | undefined {
    const normalized = text.trim();
    if (normalized === '' || normalized.length % 4 !== 0) {
        return undefined;
    }
    if (!/^[A-Za-z0-9+/]+={0,2}$/.test(normalized)) {
        return undefined;
    }
    try {
        const decoded = Buffer.from(normalized, 'base64');
        if (decoded.length === 0 && normalized !== '') {
            return undefined;
        }
        if (decoded.toString('base64') !== normalized) {
            return undefined;
        }
        return decoded;
    } catch {
        return undefined;
    }
}

function decodeEvaluatedValue(rawValue: Buffer, size?: number): Buffer {
    if (rawValue.length === 0 || rawValue.length === size) {
        return rawValue;
    }
    const text = rawValue.toString('utf8').trim();
    if (text !== '') {
        if (text.startsWith('"') && text.endsWith('"')) {
            try {
                const parsed = JSON.parse(text);
                if (typeof parsed === 'string') {
                    const decoded = tryDecodeBase64Text(parsed);
                    if (decoded) {
                        return decoded;
                    }
                }
            } catch {
                // fall back to raw bytes
            }
        }
        const decoded = tryDecodeBase64Text(text);
        if (decoded) {
            return decoded;
        }
    }
    return rawValue;
}

function isExecutionContextRunningError(e: any): boolean {
    if (!e) {
        return false;
    }
    if (Array.isArray(e)) {
        return e.some(isExecutionContextRunningError);
    }
    const code = (e as any).Code;
    if (code === TCFErrorCodes.IS_RUNNING) {
        return true;
    }
    const format = (e as any).Format;
    return typeof format === 'string' && format.includes('Execution context is running');
}

export const DEFAULT_SEND_COMMAND_CHUNK_SIZE = 10;

function decodeBitfieldValue(result: EvaluateResult, type: TCFSymbolContextData): Buffer {
    const properties = result.properties;
    const piece = properties?.Pieces?.[0];
    const size = validateVariableSize(type.Size);
    if (![1, 2, 4, 8].includes(size) || !properties || properties.Pieces?.length !== 1 || !piece ||
        !Number.isSafeInteger(piece.BitSize) || piece.BitSize === undefined || piece.BitSize < 1 || piece.BitSize > size * 8 ||
        (piece.BitOffs !== undefined && (!Number.isSafeInteger(piece.BitOffs) || piece.BitOffs < 0)) ||
        (piece.Size !== undefined && piece.Size !== size) ||
        (type.TypeClass !== TCFTypeClass.integer && type.TypeClass !== TCFTypeClass.cardinal) ||
        (properties.Class !== undefined && properties.Class !== type.TypeClass) ||
        properties.ImplicitPointer || properties.BitStride || properties.BinaryScale || properties.DecimalScale) {
        throw new Error('Unsupported bitfield value layout; expected one unscaled integer bit piece.');
    }
    const bytes = decodeEvaluatedValue(result.value, size);
    if (bytes.length !== size) {
        throw new Error(`Incomplete bitfield value: expected ${size} bytes.`);
    }
    // BitOffs describes storage, not the returned bytes: the Agent already extracts/sign-extends the value.
    return bytes;
}

export abstract class TCFClient extends AbstractTCFClient {

    private _threadsCache: { info: TCFContextData; state: TCFStateData }[] | undefined;
    private _threadsCacheTime: number = 0;
    private _threadsCachePromise: Promise<{ info: TCFContextData; state: TCFStateData }[]> | undefined;
    private threadsGeneration = 0;
    private static readonly THREADS_CACHE_TTL_MS = 500;

    async getResetCapabilities(): Promise<ContextResetCapability[]> {
        const caps = await this.sendCommand(new GetCapabilitiesContextResetCommand());
        return Array.isArray(caps) ? caps : [];
    }

    async reset(contextId: string, type: string, suspendAfterReset: boolean = true): Promise<void> {
        this.invalidateThreads();
        try {
            await this.sendCommand(new ResetContextResetCommand(contextId, type, suspendAfterReset));
        } finally {
            this.invalidateThreads();
        }
    }

    async getVariables(): Promise<ClientVariable[]> {
        let result: ClientVariable[] = [];
        const runControlContexts = await this.loadRunControlChildren(null);
        for (const ctx of runControlContexts) {
            const ctxVariables = await this.getContextVariables(ctx);
            result = result.concat(ctxVariables);
        }
        return result;
    }

    async getContextVariables(ctx: string): Promise<ClientVariable[]> {
        let result: ClientVariable[] = [];
        try {
            const stacks = await this.sendCommand(new GetChildrenStackTraceCommand(ctx)) || [];
            for (const stack of stacks) {
                const stackVariables = await this.getStackVariables(ctx, stack);
                result = result.concat(stackVariables);
            }
        } catch (e) {
            if (!isExecutionContextRunningError(e)) {
                this.console.error("Get children stacktrace error " + JSON.stringify(e));
            }
        }
        return result;
    }

    async getStackVariables(ctx: string, stack: string): Promise<ClientVariable[]> {
        let result: ClientVariable[] = [];
        try {
            const varNames = await this.sendCommand(new GetChildrenExpressionCommand(stack));
            for (const varName of varNames) {
                const v = await this.getExpressionIDVariable(ctx, stack, varName);
                if (!v) {
                    continue;
                }
                result.push(v);
            }
        } catch (e) {
            if (!isExecutionContextRunningError(e)) {
                this.console.error("Get children expression error " + JSON.stringify(e));
            }
        }
        return result;
    }

    private async evaluateVariable(varName: string, strict = false): Promise<EvaluateResult | undefined> {
        let value;
        try {
            value = await this.sendCommand(new EvaluateExpressionsCommand(varName));
        } catch (e) {
            if (e instanceof TCFPartialResultError) {
                const partial = e as TCFPartialResultError<EvaluateResult>;
                //Such partial data was seen:
                // {"result":{"value":{"type":"Buffer","data":[110,117,108,108]},"properties":null}}
                //thus, ignoring partial results without .properties
                const hasBitPieces = partial.result.properties?.Pieces?.some(piece => piece.BitSize !== undefined);
                if (!strict && !hasBitPieces && partial.result.properties !== null) {
                    value = partial.result;
                    //TODO: besides the (partial) value, we should also signal in the final result that *it is a partial value*
                    // then the UI could display it differently
                }
            }
            if (!value) {
                this.console.error("Evaluate expression error " + JSON.stringify(e)); //Eval error?
                throw e;
            }
        }

        return value;
    }

    async getExpressionIDVariable(ctx: string, stack: string, varName: string, displayName?: string, inspection?: InspectionCheck): Promise<ClientVariable | undefined> {
        let inspectedSize: number | undefined;
        let inspectedSymbol: TCFSymbolContextData | undefined;
        if (inspection) {
            inspection();
            const metadata = await this.sendCommand(new GetContextExpressionsCommand(varName));
            inspection();
            const unavailable = (code: string, message: string, symbol?: TCFSymbolContextData) =>
                new LocalInspectionError(code, message, ctx, stack, varName, metadata, symbol);
            if (!metadata) {
                throw unavailable('LOCAL_CONTEXT_MISSING', 'Expressions.getContext returned no local metadata.');
            }
            if (metadata.ID !== varName) {
                throw unavailable('LOCAL_CONTEXT_ID_MISMATCH', 'Local expression ID does not match the requested discovered local.');
            }
            if (metadata.HasFuncCall === true) {
                throw unavailable('LOCAL_FUNCTION_CALL', 'Local metadata reports a function call; evaluation is blocked.');
            }
            if (!metadata.SymbolID) {
                throw unavailable('LOCAL_SYMBOL_MISSING', 'Local expression metadata has no SymbolID; storage safety cannot be checked.');
            }
            if (metadata.ParentID !== undefined && metadata.ParentID !== stack && metadata.ParentID !== ctx) {
                throw unavailable('LOCAL_PARENT_MISMATCH', 'Local expression ParentID is neither the requested stack nor the selected core.');
            }
            // TCF ${ID} denotes a symbol, not a user-supplied expression or VS Code substitution.
            const directSymbol = metadata.Expression === '${' + metadata.SymbolID + '}' &&
                !/[{}\x00-\x1f\x7f]/.test(metadata.SymbolID);
            if (metadata.Expression !== undefined && !/^[A-Za-z_]\w*$/.test(metadata.Expression) && !directSymbol) {
                throw unavailable('LOCAL_EXPRESSION_UNSUPPORTED', 'Local Expression is neither a plain identifier nor an exact ${SymbolID} reference; evaluation is blocked.');
            }
            try { inspectedSize = validateVariableSize(metadata.Size); }
            catch (error) { throw unavailable('LOCAL_SIZE_UNSUPPORTED', error instanceof Error ? error.message : String(error)); }
            const symbol = await this.sendCommand(new GetContextSymbolsCommand(metadata.SymbolID));
            inspection();
            if (symbol.ID !== metadata.SymbolID) {
                throw unavailable('LOCAL_SYMBOL_ID_MISMATCH', 'Local symbol identity does not match expression metadata.', symbol);
            }
            if (symbol.Size !== undefined && symbol.Size !== inspectedSize) {
                throw unavailable('LOCAL_SYMBOL_SIZE_MISMATCH', 'Local symbol size does not match expression metadata.', symbol);
            }
            if (symbol.Class !== TCFSymbolClass.reference && symbol.Class !== TCFSymbolClass.value) {
                throw unavailable('LOCAL_SYMBOL_CLASS_UNSUPPORTED', 'MCP locals must identify a value or storage symbol.', symbol);
            }
            inspectedSymbol = symbol;
            if (symbol.Address !== undefined && (!Number.isSafeInteger(symbol.Address) || symbol.Address < 0 ||
                symbol.Address + inspectedSize > 0xf0000000)) {
                throw unavailable('LOCAL_ADDRESS_UNSAFE', 'Peripheral/SFR or invalid variable address is not readable through MCP.', symbol);
            }
            if (symbol.Address === undefined && symbol.Value === undefined && symbol.Register === undefined) {
                throw unavailable('LOCAL_LOCATION_UNKNOWN', 'Local storage location is unavailable; read safety cannot be checked.', symbol);
            }
            if (symbol.Register !== undefined) {
                const registers = await new CoreRegisterReader(c => this.sendCommand(c)).list(ctx, inspection);
                if (!registers.some(register => register.id === symbol.Register && register.allowed)) {
                    throw unavailable('LOCAL_REGISTER_UNSAFE', 'Local register storage is not an allowed CORE register.', symbol);
                }
            }
        }
        inspection?.();
        const evaluated = await this.evaluateVariable(varName, inspection !== undefined);
        inspection?.();
        if (!evaluated?.properties) {
            throw new Error(`Cannot display expression ${displayName || varName}: missing value properties`);
        }
        const expressionContext = evaluated.properties.Type ? undefined :
            await this.sendCommand(new GetContextExpressionsCommand(varName));
        const typeID = evaluated.properties.Type || expressionContext?.Type;
        if (inspection && evaluated.properties.Symbol && evaluated.properties.Symbol !== inspectedSymbol?.ID) {
            throw new Error('Evaluated local symbol changed during inspection.');
        }
        const symbolID = evaluated.properties.Symbol ?? inspectedSymbol?.ID;

        this.console.received(`Value ${varName} ${JSON.stringify(evaluated.properties)}`);

        const self = this;
        const helper = inspection ? new InspectionVariableHelper(c => self.sendCommand(c), inspection) : new class extends DefaultVariableHelper {
            log(message: string): void {
                self.console.log(message);
            }
            sendCommand<T>(c: SimpleCommand<T>): Promise<T> {
                return self.sendCommand(c);
            }
            createBitfieldValue(parent: TCFSymbolContextData, field: TCFSymbolContextData, type: TCFSymbolContextData): RawValueProvider {
                let pending: Promise<Buffer> | undefined;
                let bigEndian = false;
                return {
                    value: () => pending ??= (async () => {
                        validateVariableSize(type.Size);
                        if (parent.Class !== TCFSymbolClass.reference || !parent.ID || /[{}\x00-\x1f\x7f]/.test(parent.ID) ||
                            !field.Name || !/^[A-Za-z_][A-Za-z_0-9]*$/.test(field.Name)) {
                            throw new Error('Invalid bitfield parent symbol identity or member name.');
                        }
                        // A member symbol's location is relative to its object, not independently evaluable.
                        const expression = '(${' + parent.ID + '}).' + field.Name;
                        const id = await self.sendCommand(new CreateExpressionsCommand(stack || ctx, null, expression));
                        try {
                            const evaluated = await self.evaluateVariable(id, true);
                            if (!evaluated) { throw new Error('Bitfield evaluation returned no value.'); }
                            const bytes = decodeBitfieldValue(evaluated, type);
                            bigEndian = evaluated.properties?.BigEndian === true;
                            return bytes;
                        } finally {
                            await self.sendCommand(new DisposeExpressionsCommand(id));
                        }
                    })(),
                    isBigEndian: () => bigEndian,
                };
            }
            async readPointerMemory(address: number, size: number): Promise<Buffer> {
                validateVariableSize(size);
                if (!Number.isSafeInteger(address) || address < 0 || !Number.isSafeInteger(address + size)) {
                    throw new Error('Pointer target address range cannot be represented safely by TCF.');
                }
                const result = await self.sendCommand(new GetMemoryCommand(ctx, address, 1, size));
                if (result.errorAddresses?.length) {
                    throw new Error('Pointer target memory contains unreadable bytes.');
                }
                const bytes = tryDecodeBase64Text(result.base64);
                if (!bytes || bytes.length !== size) {
                    throw new Error(`Pointer target memory did not return the expected ${size} bytes.`);
                }
                return bytes;
            }
        }();

        let typeDetails: TCFSymbolContextData;
        if (typeID) {
            typeDetails = await this.sendCommand(new GetContextSymbolsCommand(typeID));
        } else {
            const typeClass = evaluated.properties.Class ?? expressionContext?.Class;
            const bytes = decodeEvaluatedValue(evaluated.value, expressionContext?.Size);
            const scalar = typeClass === TCFTypeClass.integer || typeClass === TCFTypeClass.cardinal ||
                typeClass === TCFTypeClass.real;
            const validWidth = typeClass === TCFTypeClass.real ? [4, 8].includes(bytes.length) :
                [1, 2, 4, 8].includes(bytes.length);
            if (!scalar || !validWidth ||
                (expressionContext?.Size !== undefined && expressionContext.Size !== bytes.length) ||
                evaluated.properties.ImplicitPointer || evaluated.properties.Pieces?.length ||
                evaluated.properties.BitStride || evaluated.properties.BinaryScale || evaluated.properties.DecimalScale) {
                throw new Error(`Cannot display expression ${displayName || varName}: unsupported scalar metadata or value width (class=${typeClass}, bytes=${bytes.length})`);
            }
            // Class describes a value type, not a symbol class. No symbol Type ID is required for scalars.
            // Do not infer a character type from a one-byte arithmetic result.
            // eslint-disable-next-line @typescript-eslint/naming-convention -- TCF metadata names.
            typeDetails = { ID: varName, Class: TCFSymbolClass.type, TypeClass: typeClass };
        }
        let symbolDetails;
        let nameProvider = new FixedNameProvider(displayName || varName);
        let valueProvider: RawValueProvider = new EvaluatedRawValueProvider(
            evaluated.value, evaluated.properties.BigEndian ?? false, expressionContext?.Size ?? typeDetails.Size);
        const bitfieldValue = evaluated.properties.Pieces?.some(piece => piece.BitSize !== undefined)
            ? decodeBitfieldValue(evaluated, typeDetails) : undefined;
        if (bitfieldValue) {
            valueProvider = { value: async () => bitfieldValue, isBigEndian: () => evaluated.properties?.BigEndian === true };
        }

        if (symbolID) {
            symbolDetails = inspectedSymbol ?? await this.sendCommand(new GetContextSymbolsCommand(symbolID));
            this.console.received(`Got variable ${symbolDetails.Name}`);
            nameProvider = new SymbolNameProvider(symbolDetails);
            if (!inspection && !bitfieldValue) { valueProvider = new SymbolRawValueProvider(symbolDetails, ctx, helper, helper /* as Logger */); }

            if (typeDetails.TypeClass !== symbolDetails.TypeClass) {
                //shouldn't happen?
                console.log(`Different typeclass? For ${varName} ${JSON.stringify(evaluated.properties)} ${JSON.stringify(typeDetails)} ${JSON.stringify(symbolDetails)}`);
            }
        } else if (!displayName) {
            try {
                const expressionContext = await this.sendCommand(new GetContextExpressionsCommand(varName));
                const expressionName = expressionContext?.Expression?.trim();
                if (expressionName) {
                    nameProvider = new FixedNameProvider(expressionName);
                }
            } catch {
                // keep fallback name
            }
        }

        if (inspection) {
            inspection();
            const bytes = decodeEvaluatedValue(evaluated.value, inspectedSize);
            if (bytes.length !== inspectedSize || (typeDetails.Size !== undefined && typeDetails.Size !== inspectedSize) ||
                evaluated.properties.ImplicitPointer || evaluated.properties.Pieces?.length ||
                evaluated.properties.BitStride || evaluated.properties.BinaryScale || evaluated.properties.DecimalScale) {
                throw new Error('Local value is incomplete or uses an unsupported layout.');
            }
            // Expansion retains this captured value, never SymbolRawValueProvider's implicit Memory.get.
            valueProvider = { value: async () => bytes, isBigEndian: () => evaluated.properties?.BigEndian === true };
        }
        return helper.createVariable(typeDetails, symbolDetails, nameProvider, valueProvider);
    }

    private invalidateThreads(): void {
        this.threadsGeneration++;
        this._threadsCache = undefined;
        this._threadsCachePromise = undefined;
    }

    override disconnect(): void {
        this.invalidateThreads();
        super.disconnect();
    }

    async getThreads(refresh = false): Promise<{ info: TCFContextData; state: TCFStateData }[]> {
        if (refresh) {
            this.invalidateThreads();
        }
        const now = Date.now();
        // Return cached result if still fresh (avoids flooding agent with tree walks).
        if (this._threadsCache && (now - this._threadsCacheTime) < TCFClient.THREADS_CACHE_TTL_MS) {
            return this._threadsCache;
        }
        // Coalesce concurrent calls: if a fetch is already in flight, share its promise.
        if (this._threadsCachePromise) {
            const generation = this.threadsGeneration;
            const result = await this._threadsCachePromise;
            return generation === this.threadsGeneration ? result : this.getThreads();
        }
        const generation = this.threadsGeneration;
        const pending = this._fetchThreads();
        this._threadsCachePromise = pending;
        try {
            const result = await pending;
            if (generation !== this.threadsGeneration) {
                return this.getThreads();
            }
            this._threadsCache = result;
            this._threadsCacheTime = Date.now();
            return result;
        } finally {
            if (this._threadsCachePromise === pending) {
                this._threadsCachePromise = undefined;
            }
        }
    }

    private async _fetchThreads() {
        const contexts = await this.loadRunControlChildren(null);
        const results = [];
        for (const context of contexts) {
            const info: TCFContextData | null = await this.sendCommand(new GetContextRunControlCommand(context));
            if (info?.HasState) {
                const state: TCFStateData = await this.sendCommand(new GetStateRunControlCommand(context));
                results.push({ info, state });
            }
        }

        return results;
    }

    static async doEvery<I, O>(n: number, a: I[], f: (x: I[]) => Promise<O>): Promise<O[]> {
        let r = [];
        for (let i = 0; i < a.length; i += n) {
            let slice: I[] = a.slice(i, i + n);
            let o: O = await f(slice);

            r.push(o);
        }

        return r;
    }

    async sendChunkedCommand<I, O>(a: I[], f: (slice: I[]) => SimpleCommand<O[]>, n: number = DEFAULT_SEND_COMMAND_CHUNK_SIZE): Promise<O[]> {
        return (await TCFClient.doEvery(n, a, x => this.sendCommand(f(x))))
            .flat();
    }

    async getStackTrace(contextID: string, cancellationToken: CancellationFunction, stackTraceDepth: number = -1): Promise<{
        context: TCFContextDataStackTrace;
        mapToSource: TCFCodeAreaLineNumbers | undefined;
    }[]> {
        let stackFrames: string[] = [];
        if (stackTraceDepth === -1) {
            stackFrames = await this.sendCommand(new GetChildrenStackTraceCommand(contextID)) || [];
        } else {
            stackFrames = await this.sendCommand(new GetChildrenRangeStackTraceCommand(contextID, stackTraceDepth)) || [];
        }
        
        let stackFramesContexts: TCFContextDataStackTrace[] = await this.sendChunkedCommand(stackFrames, x => new GetContextStackTraceCommand(x));
        let result = [];

        outerfor:
        for (const stackFrameContext of stackFramesContexts) {
            if (cancellationToken()) {
                throw new InterruptedError("Cancelled");
            }
            if (stackFrameContext?.CodeArea) {
                const sourceLine = stackFrameContext?.CodeArea;
                if (sourceLine?.File && sourceLine?.SLine) {
                    result.push({ context: stackFrameContext, mapToSource: sourceLine });
                    //TODO: Note we are breaking early. It is possible we still need to get the symbol info to update the context Name (since this goes to the UI?)
                    continue outerfor;
                }
            }
            if (stackFrameContext?.IP) {
                try {
                    const symbol = await this.sendCommand(new FindByAddrSymbolsCommand(contextID, stackFrameContext.IP));
                    if (symbol) {
                        const symbolContext = await this.sendCommand(new GetContextSymbolsCommand(symbol));
                        if (symbolContext) {
                            if (symbolContext.TypeClass === TCFTypeClass.function) {
                                //XXX: hack: let's just replace the returned Name
                                //TODO: Get rid of the above hack and return this info properly... Not even entirely sure what it's supposed to do but presumably we display this Name in the VSCode stacktrace UI
                                if (symbolContext.Name) {
                                    stackFrameContext.Name = symbolContext.Name;
                                }
                            }

                        }
                    }
                } catch (e) {
                    console.log("Error " + JSON.stringify(e));
                }

                    // NOTE: Some agents/toolchains return the "previous" line when querying [IP-1, IP].
                    // Prefer a small forward range from IP, then fall back to the legacy heuristic.
                    const ip = stackFrameContext.IP;
                    const ranges: Array<[number, number]> = [
                        [ip, ip + 1],
                        [Math.max(0, ip - 1), ip],
                    ];
                    const contextCandidates: string[] = [];
                    for (const candidate of [contextID, stackFrameContext.ParentID, stackFrameContext.ProcessID]) {
                        if (candidate && !contextCandidates.includes(candidate)) {
                            contextCandidates.push(candidate);
                        }
                    }
                    for (const ctx of contextCandidates) {
                        for (const [startAddress, endAddress] of ranges) {
                            let sourceLines: TCFCodeAreaLineNumbers[] | null = await this.sendCommand(
                                new MapToSourceLineNumbersCommand(ctx, startAddress, endAddress)
                            );
                            for (const sourceLine of sourceLines || []) {
                                if (sourceLine?.File && sourceLine?.SLine) {
                                    result.push({ context: stackFrameContext, mapToSource: sourceLine });
                                    continue outerfor;
                                }
                            }
                        }
                    }
            }
            if (stackFrameContext?.RP) {
                    const rp = stackFrameContext.RP;
                    const ranges: Array<[number, number]> = [
                        [rp, rp + 1],
                        [Math.max(0, rp - 1), rp],
                    ];
                    const contextCandidates: string[] = [];
                    for (const candidate of [contextID, stackFrameContext.ParentID, stackFrameContext.ProcessID]) {
                        if (candidate && !contextCandidates.includes(candidate)) {
                            contextCandidates.push(candidate);
                        }
                    }
                    for (const ctx of contextCandidates) {
                        for (const [startAddress, endAddress] of ranges) {
                            let sourceLines: TCFCodeAreaLineNumbers[] | null = await this.sendCommand(
                                new MapToSourceLineNumbersCommand(ctx, startAddress, endAddress)
                            );
                            for (const sourceLine of sourceLines || []) {
                                if (sourceLine?.File && sourceLine?.SLine) {
                                    result.push({ context: stackFrameContext, mapToSource: sourceLine });
                                    continue outerfor;
                                }
                            }
                        }
                    }
            }

            //fallback
            result.push({ context: stackFrameContext, mapToSource: undefined });
        }

        if (stackTraceDepth === -1) {
            result.reverse();
        }
        return result;
    }

    /**
     *
     * @param buffers
     * @returns a list of buffers with the first 'error' buffer empty.
     */
    private static noError(buffers: Buffer[]): Buffer[] {
        return [EMPTY_BUFFER, ...buffers] as Buffer[];
    }

    //see https://download.eclipse.org/tools/tcf/tcf-docs/TCF%20Service%20-%20Run%20Control.html#Events
    protected onRunControlEvent(event: string, datas: Buffer[]): void {
        this.invalidateThreads();
        switch (event) {
            case "contextChanged":
            case "contextAdded":
                parseResponse<TCFContextData[] | null>(TCFClient.noError(datas),
                    (results: TCFContextData[] | null) => {
                        if (results === null) {
                            return;
                        }
                        for (const resultData of results) {
                            this.contextInfo[resultData.ID] = resultData;
                        }
                    },
                    (err) => {
                        this.console.log(`Bad contextAdded event: ${JSON.stringify(err)}`);
                    },
                    json => asNullableArray(json, asTCFContextData));
                break;
            case "contextRemoved": //array of context IDs
                parseResponse<string[]>(TCFClient.noError(datas),
                    (removedContextIds) => {
                        for (const id of removedContextIds) {
                            delete this.contextInfo[id];
                        }
                    },
                    (err) => {
                        this.console.log(`Bad contextRemoved event: ${err}`);
                    }, asStringArray);
                break;
            case "contextSuspended":
                const info = parseContextSuspended(datas);
                this.console.received(`Got ${JSON.stringify(info)}`);

                if (info) {
                    this.onRunControlContextSuspended(info);
                } else {
                    this.console.log(`Bad contextSuspended event`);
                }
                break;
            case "contextResumed":
                if (!responseLengthAbout(1, datas)) {
                    this.console.error(`contextResumed response ignored: length unexpected. Should be 1 was ${datas.length}`);
                } else {
                    const contextID = asString(JSON.parse(datas[0].toString()));
                    this.onRunControlContextResumed(contextID);
                }
                break;
            case "containerSuspended": {
                // AURIX agent sometimes emits containerSuspended for core contexts.
                // Some versions include extra JSON fields (datas.length can be > 1), but the first field
                // still identifies the affected context (string or array of strings).
                if (datas.length < 1) {
                    this.console.error(`containerSuspended response ignored: missing payload`);
                    break;
                }
                const v = JSON.parse(datas[0].toString());
                const ids = Array.isArray(v) ? (v as any[]).map(x => asString(x)) : [asString(v)];
                for (const contextID of ids) {
                    this.onRunControlContextSuspended({ id: contextID, pc: 0, reason: 'Suspended', data: null });
                }
                break;
            }
            case "containerResumed": {
                if (datas.length < 1) {
                    this.console.error(`containerResumed response ignored: missing payload`);
                    break;
                }
                const v = JSON.parse(datas[0].toString());
                const ids = Array.isArray(v) ? (v as any[]).map(x => asString(x)) : [asString(v)];
                for (const contextID of ids) {
                    this.onRunControlContextResumed(contextID);
                }
                break;
            }
            case "contextException": //TODO: contextException
            case "contextStateChanged": //TODO: contextStateChanged
            default:
                this.console.log(`Unimplemented RunControl event: ${event}`);
                break;
        }
    }

    protected onRunControlContextSuspended(info: ContextSuspendedData) {
    }

    protected onRunControlContextResumed(contextID: string) {
    }

    protected abstract onBreakpoint(breakpointID: string, status: InstanceStatusData[]): void;
    protected abstract onBreakpointRemoved(breakpointIDs: string[]): void;
    protected abstract onBreakpointAdded(breakpointIDs: string[]): void;
    protected abstract onBreakpointChanged(breakpointIDs: string[]): void;

    protected onBreakpointsEvent(event: string, datas: Buffer[]): void {
        switch (event) {
            case "status":
                //either we have 2 chunks or 3 chunks with the last one empty...
                if (!responseLengthAbout(2, datas)) {
                    this.console.log(`Breakpoint status event data with unknown format`);
                    break;
                }
                const breakpointID = asString(JSON.parse(datas[0].toString()));
                const breakpointStatus = asBreakpointStatus(JSON.parse(datas[1].toString()));

                const goodInstances = (breakpointStatus?.Instances || [])
                    .filter(i => !i?.Error) //ignore breakpoints with errors
                    .filter(i => i?.LocationContext) //ignore those without location context
                    ;

                const hitInstances = goodInstances
                    .filter(i => typeof i?.HitCount === 'number' && i.HitCount > 0);

                if (hitInstances.length > 0) {
                    //{"LocationContext":"P0:SLRT","HitCount":1,"Address":2147488952,"Size":1,"BreakpointType":"Software"}

                    this.console.log("Hit breakpoint " + breakpointID + " at " + JSON.stringify(hitInstances));
                    this.onBreakpoint(breakpointID, hitInstances);
                } else if (goodInstances.length > 0) {
                    this.console.log("Breakpoint status (not hit) " + breakpointID + " at " + JSON.stringify(goodInstances));
                } else {
                    this.console.log(`Eroneous breakpoint ${breakpointID} hit ${datas[1].toString()}`);
                }
                break;
            case "contextAdded":
                const breakpointsAdded = asNullableArray(JSON.parse(datas[0].toString()), asBreakpointData) || [];
                this.onBreakpointAdded(breakpointsAdded.map(b => b.ID));
                break;
            case "contextChanged":
                const breakpointsChanged = asNullableArray(JSON.parse(datas[0].toString()), asBreakpointData) || [];
                this.onBreakpointChanged(breakpointsChanged.map(b => b.ID));
                break;
            case "contextRemoved":
                const breakpointsRemoved = asStringArray(JSON.parse(datas[0].toString()));
                this.onBreakpointRemoved(breakpointsRemoved);
                break;
            default:
                this.console.log(`Unknown Breakpoints event: ${event}`);
                break;
        }
    }

    protected onLocatorEvent(event: string, datas: Buffer[]): void {
        switch (event) {
            case "peerHeartBeat":
                //ignore, so far. in theory we could remember the last timestamp and maybe reconnect if it's stale (or send our own heartbeat)
                break;
            default:
                this.console.log(`Unknown Locator event: ${event}`);
                break;
        }
    }

    //TODO: This design should be changed. Services should register their own event handler somehow then provide a way for the client to be notified...
    protected onEvent(service: string, event: string, datas: Buffer[]): void {
        switch (service) {
            case "RunControl":
                this.onRunControlEvent(event, datas);
                break;
            case "Breakpoints":
                this.onBreakpointsEvent(event, datas);
                break;
            case "Locator":
                this.onLocatorEvent(event, datas);
                break;
            default:
                this.console.log(`Unknown service event: ${service}.${event}`);
                break;
        }
    }
}
