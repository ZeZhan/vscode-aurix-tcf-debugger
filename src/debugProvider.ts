/*
 * Aurix TCF Debug Provider
 *
 * This debug adapter is based on the Intel TCF architecture included in this repo,
 * but adapted to the local project APIs (LifetimeDebugSession + TCFClient).
 * 
 * It implements the Debug Adapter Protocol (DAP) surface for AURIX debugging and bridges requests
 * and events to/from the TCF agent via the TCFClient.
 * Key responsibilities include: breakpoint management, thread/context mapping, stack trace and variable, 
 * disassembly, memory access, multi-core coordination, etc.
 */

import * as path from 'path';
import * as fs from 'fs';
import * as fsPromises from 'fs/promises';
import {
	Breakpoint,
	BreakpointEvent,
	ContinuedEvent,
	Event,
	InvalidatedEvent,
	InitializedEvent,
	OutputEvent,
	Scope,
	Source,
	StackFrame,
	StoppedEvent,
	TerminatedEvent,
	Thread,
	Variable,
} from '@vscode/debugadapter';
import { DebugProtocol } from '@vscode/debugprotocol';
import { LifetimeDebugSession } from './lifetimeDebugSession';
import { TCFClient } from './tcfclient';
import {
	BreakpointData,
	BreakpointType,
	ContextSuspendedData,
	DebugCommandStamper,
	InstanceStatusData,
	NEVER_CANCELLED,
	SmallCommandStamper,
	TCFLogger,
} from './tcf-all';
import { GetChildrenRegistersCommand, GetContextRegistersCommand, GetRegistersCommand } from './tcf/registers';
import { CreateExpressionsCommand } from './tcf/expressions';
import { GetChildrenStackTraceCommand } from './tcf/stacktrace';
import { SetMemoryMapCommand } from './tcf/memorymap';
import { DisassembleDisassemblyCommand, GetCapabilitiesDisassemblyCommand } from './tcf/disassembly';
import { GetMemoryCommand, MemoryErrorAddress, SetMemoryCommand } from './tcf/memory';
import { TCFCodeAreaLineNumbers } from './tcf/linenumbers';
import { GetStatusBreakpointsCommand } from './tcf/breakpoints';
import { isStepOutReturnStop, StepOutTarget } from './stepOutStop';
import { disassemblyWindow } from './disassemblyWindow';
import { BreakpointStopBarrier } from './breakpointStopBarrier';
import { z } from 'zod';
import { CoreRegisterReader } from './coreRegisters';
import { BreakpointInspector, targetAddress } from './breakpointInspection';
import { InspectedVariable } from './variables/inspection';
import { LocalInspectionError } from './variables/inspectionDiagnostics';
import { GetChildrenExpressionCommand } from './tcf/expressions';
import { AddressRange, elfLoadRanges, memoryReadSchema, readableElfRanges, readInspectedMemory } from './memoryInspection';
import { PeripheralProfile, peripheralProfileName, preparedPeripheralProfile, preparedPeripheralCatalog } from './peripheralProfile';
import { NativePeripheralAccess, NativePeripheralWrite } from './nativePeripheralAccess';
import { FullPeripheralReader, PeripheralRegisterReader, peripheralPageSchema } from './peripheralInspection';
import { randomUUID } from 'crypto';
import { GlobalSelection, GlobalVariableInspector, globalLookupSchema } from './variables/globals';

const inspectionOptionsSchema = z.object({
	threadId: z.number().int().positive(), epoch: z.number().int().nonnegative(),
	expiresAt: z.number().int().positive(),
}).strict();
const inspectionPageSchema = z.object({
	start: z.number().int().min(0).max(1000000), count: z.number().int().min(1).max(100),
});

export interface InternalLaunchArguments {
	debugTCFMessages?: boolean;
	commandToken?: 'debug' | 'default';
	debugUIFocus?: boolean;
}

// We intentionally do not strictly validate these args because this extension
// accepts AURIX-specific properties beyond the upstream Intel schema.
export interface AurixTCFLaunchRequestArguments extends DebugProtocol.LaunchRequestArguments {
	host?: string;
	port?: number;
	timeout?: number;
	debugTCFMessages?: boolean;
	debugUIFocus?: boolean;
	breakpointPrefix?: string;
	pathMapper?: string;
	internal?: InternalLaunchArguments;
	stackTraceDepth?: number;
	stopOnEntry?: boolean;
	program?: string;
	resumeOtherCoresOnEntry?: boolean;
	globals?: string[];

	// AURIX extras (accepted; mostly used by agent CLI layer)
	targetDevice?: string;
	core?: number;
	entryFunction?: string;
	svdFile?: string;
	peripheralReadProfile?: 'auto' | 'disabled' | typeof peripheralProfileName;
	__aurixPeripheralNotice?: string;
	workspace?: string;
	flashDownload?: boolean;
	globalAccess?: boolean;
	additionalAgentOptions?: string;

	// Per-core ELF paths (PPU/CDSP/SCR) for multi-core memory mappings
	ppuElfPath?: string;
	cdspElfPaths?: string[];
	scrElfPath?: string;

	// Optional reset behavior (no GUI; can be set in launch.json)
	resetType?: string;
	resetSuspend?: boolean;

	// Mitigation for multi-core "stop storms": delay pause-type stopped events slightly so a breakpoint
	// stopped event can arrive first and become the primary UI context.
	stopStormPauseDelayMs?: number;
	refocusOnWrongContext?: boolean;
	instructionStepping?: boolean;
	liveWatchEnabled?: boolean;
	liveWatchIntervalMs?: number;
}

const DEFAULT_TCF_HOST = 'localhost';
const DEFAULT_TCF_PORT = 1534;
const DEFAULT_BREAKPOINTS_PREFIX = 'aurix-';
const BREAKPOINT_INVALID = -1;
const MEMORY_READ_FALLBACK_MIN_BYTES = 8;
const MEMORY_READ_FALLBACK_MAX_BYTES = 512;
const MEMORY_READ_FALLBACK_CHUNK_BYTES = 4;

enum BreakpointEventReason {
	removed = 'removed',
	changed = 'changed',
}

enum StoppedEventReason {
	breakpoint = 'breakpoint',
	pause = 'pause',
	entry = 'entry',
	step = 'step',
}

class DebugLogger implements TCFLogger {
	private debugTCF = false;
	private prefix = '';

	constructor(private session: LifetimeDebugSession) { }

	setDebugTCFMessages(debugTCF: boolean) {
		this.debugTCF = debugTCF;
	}

	setPrefix(prefix: string) {
		this.prefix = prefix;
	}

	private time(): string {
		const d = new Date();
		return `${d.getHours().toString().padStart(2, '0')}:${d.getMinutes().toString().padStart(2, '0')}:${d.getSeconds().toString().padStart(2, '0')}`;
	}

	received(message: string): void {
		if (this.debugTCF) {
			this.log(message);
		}
	}

	sent(message: string): void {
		if (this.debugTCF) {
			this.log(message);
		}
	}

	log(message: string): void {
		if (this.debugTCF) {
			this.session.sendEvent(new OutputEvent(`${this.prefix}${this.time()} ${message}\n`, 'console'));
		}
	}

	error(message: string): void {
		if (this.debugTCF) {
			this.session.sendEvent(new OutputEvent(`${this.prefix}${this.time()} ${message}\n`, 'stderr'));
		}
	}

	stdout(message: string): void {
		this.session.sendEvent(new OutputEvent(message, 'stdout'));
	}
}

type BreakpointTuple = { id: number; file: string; line: number; verified: boolean };
type InstructionBreakpointTuple = { id: number; address: number; verified: boolean };
type WatchExpressionState = { result: string; liveRefreshable: boolean };

class BreakpointsManager {
	configured = false;
	private counter = 1;
	private byFile = new Map<string, Map<number, BreakpointTuple>>();
	private byId = new Map<number, BreakpointTuple>();

	setConfigured() {
		this.configured = true;
	}

	setVerified(id: number, verified: boolean) {
		const b = this.byId.get(id);
		if (b) {
			b.verified = verified;
		}
	}

	allocateId(): number {
		return this.counter++;
	}

	deleteById(id: number) {
		const b = this.byId.get(id);
		if (!b) {
			return;
		}
		this.byId.delete(id);
		this.byFile.get(b.file)?.delete(b.line);
	}

	updateFile(file: string, lines: number[]): BreakpointTuple[] {
		let map = this.byFile.get(file);
		if (!map) {
			map = new Map();
			this.byFile.set(file, map);
		}

		const nextLines = new Set(lines);
		// Remove deleted lines
		for (const [line, tuple] of Array.from(map.entries())) {
			if (!nextLines.has(line)) {
				map.delete(line);
				this.byId.delete(tuple.id);
			}
		}
		// Add new lines
		for (const line of lines) {
			if (!map.has(line)) {
				const tuple: BreakpointTuple = { id: this.allocateId(), file, line, verified: false };
				map.set(line, tuple);
				this.byId.set(tuple.id, tuple);
			}
		}
		return Array.from(map.values()).sort((a, b) => a.line - b.line);
	}

	getAll(): BreakpointTuple[] {
		return Array.from(this.byId.values());
	}

	getById(id: number): BreakpointTuple | undefined {
		return this.byId.get(id);
	}
}

class InstructionBreakpointsManager {
	private byAddress = new Map<number, InstructionBreakpointTuple>();
	private byId = new Map<number, InstructionBreakpointTuple>();

	setVerified(id: number, verified: boolean) {
		const b = this.byId.get(id);
		if (b) {
			b.verified = verified;
		}
	}

	deleteById(id: number) {
		const b = this.byId.get(id);
		if (!b) {
			return;
		}
		this.byId.delete(id);
		this.byAddress.delete(b.address);
	}

	updateAddresses(addresses: number[], allocateId: () => number): InstructionBreakpointTuple[] {
		const next = new Set(addresses);
		// Remove deleted addresses
		for (const [addr, tuple] of Array.from(this.byAddress.entries())) {
			if (!next.has(addr)) {
				this.byAddress.delete(addr);
				this.byId.delete(tuple.id);
			}
		}
		// Add new addresses
		for (const addr of addresses) {
			if (!this.byAddress.has(addr)) {
				const tuple: InstructionBreakpointTuple = { id: allocateId(), address: addr, verified: false };
				this.byAddress.set(addr, tuple);
				this.byId.set(tuple.id, tuple);
			}
		}
		return Array.from(this.byAddress.values()).sort((a, b) => a.address - b.address);
	}

	getAll(): InstructionBreakpointTuple[] {
		return Array.from(this.byId.values());
	}

	getById(id: number): InstructionBreakpointTuple | undefined {
		return this.byId.get(id);
	}
}

class InspectionStateChangedError extends Error {
	constructor(readonly previousEpoch: number, readonly currentEpoch: number, readonly reason: string) {
		super('Inspection references expired after an execution change.');
	}
}

export class AurixTCFDebugSession extends LifetimeDebugSession {
	private disconnecting = false;
	private memoryDisconnectReported = false;
	private inspectionEpoch = 0;
	private inspectionChangeReason = 'initial state';
	private lastPeripheralCancellationEpoch = -1;
	private inspectionReference = 0;
	private readonly inspectionVariables = new Map<number, { contextId: string; stack?: string; variable?: InspectedVariable }>();
	private readonly inspectionGlobals = new Map<number, GlobalSelection>();
	private inspectionMemoryRanges?: AddressRange[];
	private inspectionPeripheralProfile?: PeripheralProfile;
	private nativePeripherals?: NativePeripheralAccess;
	private peripheralWritesInFlight = 0;
	private mcpPeripheralMode: 'full' | 'legacy' | 'disabled' = 'legacy';
	private readonly peripheralWriteTickets = new Map<string, {
		plan: NativePeripheralWrite; access: NativePeripheralAccess; threadId: number; epoch: number;
		expiresAt: number; consumed: boolean; cancelled: boolean;
	}>();
	private peripheralNotice = 'Peripheral reads are disabled or unavailable for this session; select a matching SVD and relaunch.';

	private async peripheralReader(): Promise<PeripheralRegisterReader | FullPeripheralReader> {
		if (this.mcpPeripheralMode === 'disabled') { throw new Error('MCP peripheral access is disabled for this session.'); }
		if (this.mcpPeripheralMode === 'full' && this.nativePeripherals) { return new FullPeripheralReader(this.nativePeripherals); }
		if (!this.inspectionPeripheralProfile) {
			throw new Error(`${this.peripheralNotice} No Memory.get fallback is allowed.`);
		}
		return new PeripheralRegisterReader(command => this.tcfClient.sendCommand(command), this.inspectionPeripheralProfile, this.nativePeripherals);
	}

	protected override dispatchRequest(request: DebugProtocol.Request): void {
		if (/^(continue|next|stepIn|stepOut|pause|restart|disconnect|terminate|setVariable|setExpression|writeMemory|aurix-tcf\/(reset|halt))$/.test(request.command)) {
			this.invalidateInspection(`DAP ${request.command}`);
		}
		super.dispatchRequest(request);
	}

	private invalidateInspection(reason: string): void {
		this.inspectionEpoch++;
		this.inspectionChangeReason = reason;
		this.inspectionVariables.clear();
		this.inspectionGlobals.clear();
		this.nativePeripherals?.invalidate();
		for (const ticket of this.peripheralWriteTickets.values()) { ticket.cancelled = true; }
		this.peripheralWriteTickets.clear();
	}

	private checkNotDisconnecting(): void {
		if (this.disconnecting) { throw new Error('Debug session is disconnecting.'); }
	}

	private async viewerContext(contextId: string) {
		const epoch = this.inspectionEpoch, expiresAt = Date.now() + 15000;
		let phase: 'state' | 'metadata' | 'values' = 'state';
		const check = (currentPhase?: typeof phase) => {
			phase = currentPhase ?? phase;
			this.checkNotDisconnecting();
			if (epoch !== this.inspectionEpoch) { throw new InspectionStateChangedError(epoch, this.inspectionEpoch, this.inspectionChangeReason); }
			if (Date.now() >= expiresAt) { throw new Error(`Peripheral Viewer request deadline exceeded (phase: ${phase}; limit: 15000 ms).`); }
		};
		const verify = async () => {
			check('state');
			const threads = await this.tcfClient.getThreads(true);
			check('state');
			if (!threads.some(thread => thread.info.ID === contextId && thread.state.suspended)) {
				throw new Error('Peripheral Viewer requires the selected core to be stopped.');
			}
		};
		await verify();
		return { check, verify };
	}

	private async inspectionContext(raw: unknown, ownPeripheralWrite = false) {
		const options = inspectionOptionsSchema.parse(raw);
		const check = () => {
			this.checkNotDisconnecting();
			if (this.peripheralWritesInFlight > (ownPeripheralWrite ? 1 : 0)) { throw new Error('Inspection unavailable while a manual peripheral write is in progress.'); }
			if (options.epoch !== this.inspectionEpoch) {
				throw new InspectionStateChangedError(options.epoch, this.inspectionEpoch, this.inspectionChangeReason);
			}
			if (Date.now() >= options.expiresAt || options.expiresAt > Date.now() + 15000) { throw new Error('Inspection deadline expired or invalid.'); }
		};
		check();
		const contextId = this.threadIdToContext.get(options.threadId);
		const threads = await this.tcfClient.getThreads(true);
		check();
		if (!contextId || !threads.some(thread => thread.info.ID === contextId && thread.state.suspended) ||
			threads.some(thread => !thread.state.suspended)) { throw new Error('Inspection requires all reported cores stopped and an explicit valid thread.'); }
		return { contextId, check };
	}

	private storeInspectionVariable(value: { contextId: string; stack?: string; variable?: InspectedVariable }): number {
		if (this.inspectionVariables.size >= 4096) { throw new Error('MCP variable reference limit reached; execution invalidates the old references.'); }
		const reference = ++this.inspectionReference;
		this.inspectionVariables.set(reference, value);
		return reference;
	}

	private async inspectionScopes(response: DebugProtocol.ScopesResponse, raw: unknown): Promise<void> {
		const args = z.object({ frameId: z.number().int().nonnegative(), aurixMcp: inspectionOptionsSchema }).parse(raw);
		const { contextId, check } = await this.inspectionContext(args.aurixMcp);
		const [frameContext, stack] = this.getStackFrameDetails(this.getLocalScopeVariableReference(args.frameId));
		if (contextId !== frameContext) { throw new Error('Frame belongs to a different core or is stale.'); }
		check();
		const reference = this.storeInspectionVariable({ contextId, stack });
		response.body = { scopes: [new Scope('Locals', reference, false)] };
		this.sendResponse(response);
	}

	private async inspectionVariablePage(response: DebugProtocol.VariablesResponse, raw: unknown): Promise<void> {
		const args = inspectionPageSchema.extend({
			variablesReference: z.number().int().positive(), aurixMcp: inspectionOptionsSchema,
		}).parse(raw);
		const { contextId, check } = await this.inspectionContext(args.aurixMcp);
		const reference = this.inspectionVariables.get(args.variablesReference);
		if (!reference || reference.contextId !== contextId) { throw new Error('Unknown or stale MCP variable reference.'); }
		const variables: (DebugProtocol.Variable & {
			unavailable?: string; unavailableCode?: string; unavailableDetails?: LocalInspectionError['details'];
			pointerDereferenceAllowed?: false;
		})[] = [];
		const convert = async (variable: InspectedVariable): Promise<void> => {
			check();
			const value = await variable.displayValue();
			check();
			const variablesReference = variable.expandable ? this.storeInspectionVariable({ ...reference, variable }) : 0;
			variables.push({ name: variable.name() ?? '<unnamed>', value, variablesReference,
				type: variable.type.Name ?? undefined, pointerDereferenceAllowed: false });
		};
		let total: number;
		if (reference.variable) {
			const page = await reference.variable.page(args.start, args.count, check);
			total = page.total;
			for (const variable of page.variables) { await convert(variable); }
		} else {
			if (!reference.stack) { throw new Error('MCP variable reference has no stack or captured value.'); }
			const ids = await this.tcfClient.sendCommand(new GetChildrenExpressionCommand(reference.stack));
			check();
			if (ids.length > 4096) { throw new Error('Local-variable metadata exceeds 4096 entries.'); }
			total = ids.length;
			for (const id of ids.slice(args.start, args.start + args.count)) {
				check();
				try {
					const variable = await this.tcfClient.getExpressionIDVariable(contextId, reference.stack, id, undefined, check);
					check();
					if (!(variable instanceof InspectedVariable)) { throw new Error('Unsupported or unavailable local variable type.'); }
					await convert(variable);
				} catch (error) {
					check();
					const message = String(error);
					const diagnostic = error instanceof LocalInspectionError
						? { unavailableCode: error.code, unavailableDetails: error.details } : {};
					this.tcfLogger.error(`MCP local ${id}: ${message}${error instanceof LocalInspectionError ? ` ${JSON.stringify(diagnostic)}` : ''}`);
					variables.push({ name: id, value: '<unavailable>', variablesReference: 0, unavailable: message, ...diagnostic });
				}
			}
		}
		check();
		response.body = Object.assign({ variables }, { totalVariables: total, start: args.start });
		this.sendResponse(response);
	}
	private enabledPathMapper: boolean;
	private stackTraceDepth: number = -1;
	private instructionSteppingEnabled = false;
	private execRanges: Array<{ start: number; end: number }> = [];
	private breakpointPrefix = DEFAULT_BREAKPOINTS_PREFIX;
	private pathMapper: (p: string) => string = (p) => p;
	private sourceResolverBaseDir: string | undefined;
	private workspaceBaseDir: string | undefined;
	private projectRootDir: string | undefined;
	private librariesBasenameIndex: Map<string, string> | undefined;
	private programPath: string | undefined;
	private disassemblyCapabilities: string[] | undefined;
	private disassemblyCapabilitiesLogged = false;

	private breakpointsManager = new BreakpointsManager();
	private instructionBreakpointsManager = new InstructionBreakpointsManager();

	private contextToThreadId = new Map<string, number>();
	private threadIdToContext = new Map<number, string>();

	private tcfLogger: DebugLogger;
	private tcfClient: TCFClient;
	private readonly breakpointStops = new BreakpointStopBarrier(
		async () => (await this.tcfClient.getThreads(true)).map(thread => ({
			id: thread.info.ID, suspended: thread.state.suspended
		})),
		(contextId, allThreadsStopped, refocus) => {
			const threadId = this.getOrAssignThreadId(contextId);
			this.cancelPendingPauseStoppedTimers('verifiedBreakpoint');
			this.suppressPauseStoppedUntilMs = Date.now() + Math.max(150, this.stopStormPauseDelayMs * 4);
			if (!refocus) {
				this.notePrimaryBreakpointStop(threadId, contextId);
			}
			this.sendStoppedEvent(StoppedEventReason.breakpoint, threadId, { allThreadsStopped });
		},
		message => this.sendEvent(new OutputEvent(`${message}\n`, 'stderr'))
	);
	private suspendedContextIds = new Set<string>();
	private pendingStepThreads = new Set<number>();
	private pendingStepOutTargets = new Map<number, StepOutTarget & { breakpointRevision: number }>();
	private breakpointRevision = 0;
	private configuredGlobals: string[] = [];
	private liveWatchEnabled = false;
	private liveWatchIntervalMs = 1000;
	private liveWatchTimer: ReturnType<typeof setInterval> | undefined;
	private liveWatchRefreshInFlight = false;
	private watchExpressionStates = new Map<string, WatchExpressionState>();
	private launchCore: number | undefined;
	private launchResetType: string | undefined;
	private launchResetSuspend: boolean = true;
	private startupDiagnosticsEnabled: boolean = false;
	private uiFocusDiagnosticsEnabled: boolean = false;
	private stopStormPauseDelayMs: number = 30;
	private stopStormStackSuppressMs: number = 500;
	private pendingPauseStoppedTimers = new Map<string, ReturnType<typeof setTimeout>>();
	private pendingBreakpointStoppedTimers = new Map<string, ReturnType<typeof setTimeout>>();
	private breakpointStopDelayMs: number = 60;
	private suppressPauseStoppedUntilMs: number = 0;
	private refocusOnWrongContext: boolean = true;
	private primaryBreakpointStop:
		| { threadId: number; ctx: string; untilMs: number; refocused: boolean; stackSuppressUntilMs: number }
		| undefined;
	private frameIdToMeta = new Map<number, {
		threadId: number; ctx: string; stack?: string; source?: { path: string; line: number }
	}>();
	private threadIdToFrameIds = new Map<number, Set<number>>();
	private liveWatchSuspendFallbackBlockedUntilMs: number = 0;
	private postResetStackTrimUntilMs: number = 0;
	private cachedCoreContextId: string | undefined;
	private cachedCoreContextKey: number | undefined | null = null; // null = not yet cached

	constructor(enablePathMapper: boolean) {
		super();
		this.enabledPathMapper = enablePathMapper;
		this.tcfLogger = new DebugLogger(this);

		const outer = this;
		this.tcfClient = new class extends TCFClient {
			constructor(logger: TCFLogger) {
				super(logger, new SmallCommandStamper());
			}

			setCommandToken(kind: string) {
				this.tokenIdGenerator = kind === 'debug' ? new DebugCommandStamper() : new SmallCommandStamper();
			}

			protected onBreakpoint(breakpointID: string, status: InstanceStatusData[]): void {
				outer.onBreakpointHit(breakpointID, status);
			}
			protected onBreakpointRemoved(breakpointIDs: string[]): void {
				outer.onBreakpointRemoved(breakpointIDs);
			}
			protected onBreakpointAdded(breakpointIDs: string[]): void {
				outer.onBreakpointAddedOrChanged(breakpointIDs);
			}
			protected onBreakpointChanged(breakpointIDs: string[]): void {
				outer.onBreakpointAddedOrChanged(breakpointIDs);
			}
			protected onRunControlContextSuspended(info: ContextSuspendedData) {
				outer.onContextSuspended(info);
			}
			protected onRunControlContextResumed(contextID: string) {
				outer.onContextResumed(contextID);
			}
			protected onSocketError(err: any) {
				outer.cancelBreakpointStops('socketError');
				outer.tcfLogger.error(`TCF socket error: ${String(err)}`);
				outer.sendEvent(new TerminatedEvent());
			}
		}(this.tcfLogger);

		this.setDebuggerLinesStartAt1(true);
		this.setDebuggerColumnsStartAt1(true);
	}

	private focusLog(message: string) {
		if (!this.uiFocusDiagnosticsEnabled) {
			return;
		}
		this.tcfLogger.log(`[focus] ${message}`);
	}

	private startupLog(message: string) {
		if (!this.startupDiagnosticsEnabled) {
			return;
		}
		this.tcfLogger.log(`[startup] ${message}`);
	}

	private formatThreadsSnapshot(infos: any[]): string {
		return infos
			.map(t => {
				const id = String(t?.info?.ID ?? '');
				const name = t?.info?.Name ? String(t.info.Name) : '';
				const suspended = Boolean(t?.state?.suspended);
				return `${id}${name ? `(${name})` : ''}:${suspended ? 'S' : 'R'}`;
			})
			.filter(s => s.trim() !== '')
			.join(', ');
	}

	private async startupLogThreads(tag: string): Promise<void> {
		if (!this.startupDiagnosticsEnabled) {
			return;
		}
		try {
			const infos = await this.tcfClient.getThreads();
			this.tcfLogger.log(`[startup] ${tag}: threads=${infos.length}${infos.length ? ` ${this.formatThreadsSnapshot(infos)}` : ''}`);
		} catch (e) {
			this.tcfLogger.log(`[startup] ${tag}: failed to query threads: ${String(e)}`);
		}
	}

	private async pauseAllCoresBestEffort(tag: string): Promise<void> {
		// Query all threads/contexts and pause any that are running.
		// Retries a second time to catch any cores that were still starting up.
		// Used for pauseOnEntry and reset+halt scenarios.
		try {
			for (let attempt = 0; attempt < 2; attempt++) {
				const infos = await this.tcfClient.getThreads(true);
				const running = infos.filter(t => !t.state?.suspended).map(t => t.info.ID);
				const suspended = infos.filter(t => Boolean(t.state?.suspended)).map(t => t.info.ID);
				this.startupLog(
					`pauseAllCoresBestEffort(${tag}) attempt=${attempt + 1}: running=${running.length ? running.join(', ') : '(none)'} suspended=${suspended.length ? suspended.join(', ') : '(none)'}`
				);

				if (running.length === 0) {
					return;
				}

				for (const id of running) {
					try {
						await this.tcfClient.pause(id);
					} catch (error) {
						this.tcfLogger.error(`Failed to pause ${id} (${tag}): ${String(error)}`);
					}
				}

				// Give the agent a moment to publish updated states/events.
				await new Promise(resolve => setTimeout(resolve, 150));
			}
		} catch (e) {
			this.tcfLogger.error(`pauseAllCoresBestEffort(${tag}) failed: ${String(e)}`);
		}
	}

	protected sendStoppedEvent(
		reason: string,
		threadId: number,
		opts?: { allThreadsStopped?: boolean; preserveFocusHint?: boolean }
	) {
		const ctx = this.threadIdToContext.get(threadId);
		this.focusLog(
			`StoppedEvent: reason=${reason} threadId=${threadId} ctx=${String(ctx ?? '')}`
		);
		if (this.startupDiagnosticsEnabled) {
			this.tcfLogger.log(
				`[dap] StoppedEvent reason=${reason} threadId=${threadId} ctx=${String(ctx ?? '')} allThreadsStopped=${String(Boolean(opts?.allThreadsStopped))}`
			);
		}
		const ev: DebugProtocol.StoppedEvent = new StoppedEvent(reason, threadId);
		if (opts?.allThreadsStopped) {
			ev.body.allThreadsStopped = true;
		}
		ev.body.preserveFocusHint = opts?.preserveFocusHint ?? false;
		this.sendEvent(ev);
	}

	private cancelPendingPauseStoppedTimers(tag: string) {
		if (this.pendingPauseStoppedTimers.size === 0) {
			return;
		}
		for (const t of this.pendingPauseStoppedTimers.values()) {
			clearTimeout(t);
		}
		this.pendingPauseStoppedTimers.clear();
		this.focusLog(`cancelPendingPauseStoppedTimers(${tag})`);
	}

	private cancelPendingBreakpointStoppedTimer(contextId: string, tag: string) {
		const timer = this.pendingBreakpointStoppedTimers.get(contextId);
		if (!timer) {
			return;
		}
		clearTimeout(timer);
		this.pendingBreakpointStoppedTimers.delete(contextId);
		this.focusLog(`cancelPendingBreakpointStoppedTimer(${contextId}, ${tag})`);
	}

	private cancelBreakpointStops(tag: string): void {
		this.breakpointStops.invalidate();
		this.primaryBreakpointStop = undefined;
		for (const contextId of Array.from(this.pendingBreakpointStoppedTimers.keys())) {
			this.cancelPendingBreakpointStoppedTimer(contextId, tag);
		}
	}

	private notifyBreakpointStopped(contextId: string, refocus = false): void {
		const contexts = Object.values(this.tcfClient.contextInfo).filter(info => info.HasState).map(info => info.ID);
		void this.breakpointStops.notify(contextId, contexts, refocus);
	}

	private notePrimaryBreakpointStop(threadId: number, ctx: string) {
		this.primaryBreakpointStop = {
			threadId,
			ctx,
			untilMs: Date.now() + 2_000,
			refocused: false,
			stackSuppressUntilMs: Date.now() + this.stopStormStackSuppressMs,
		};
	}

	private maybeRefocusToBreakpointThread(from: string, requested: { threadId?: number; ctx?: string }) {
		if (!this.refocusOnWrongContext) {
			return;
		}
		const p = this.primaryBreakpointStop;
		if (!p) {
			return;
		}
		if (Date.now() > p.untilMs) {
			return;
		}
		if (p.refocused) {
			return;
		}
		if (requested.threadId === undefined || requested.ctx === undefined) {
			return;
		}
		if (requested.threadId === p.threadId) {
			return;
		}

		p.refocused = true;
		this.tcfLogger.log(
			`[dap] Refocus: from=${from} requestedThreadId=${requested.threadId} requestedCtx=${requested.ctx} -> breakpointThreadId=${p.threadId} breakpointCtx=${p.ctx}`
		);
		this.notifyBreakpointStopped(p.ctx, true);
	}

	private tryResolveFrame(frameId: number): { threadId?: number; ctx?: string; stack?: string } {
		const cached = this.frameIdToMeta.get(frameId);
		if (cached) {
			return { threadId: cached.threadId, ctx: cached.ctx, stack: cached.stack };
		}
		try {
			const localRef = this.getLocalScopeVariableReference(frameId);
			const [ctx, stack] = this.getStackFrameDetails(localRef);
			const threadId = this.contextToThreadId.get(ctx) ?? this.getOrAssignThreadId(ctx);
			return { threadId, ctx, stack };
		} catch {
			return {};
		}
	}

	protected rememberFrameMeta(frameId: number, threadId: number, ctx: string, stack?: string, source?: { path: string; line: number }) {
		this.frameIdToMeta.set(frameId, { threadId, ctx, stack, source });
		let set = this.threadIdToFrameIds.get(threadId);
		if (!set) {
			set = new Set<number>();
			this.threadIdToFrameIds.set(threadId, set);
		}
		set.add(frameId);
	}

	private clearFrameMetaForThread(threadId: number) {
		const ids = this.threadIdToFrameIds.get(threadId);
		if (!ids) {
			return;
		}
		for (const frameId of ids.values()) {
			this.frameIdToMeta.delete(frameId);
		}
		this.threadIdToFrameIds.delete(threadId);
	}

	private clearAllFrameMeta(): void {
		for (const threadId of Array.from(this.threadIdToFrameIds.keys())) {
			this.clearFrameMetaForThread(threadId);
		}
	}

	private beginResetTransition(): void {
		this.cancelBreakpointStops('reset');
		this.pendingStepThreads.clear();
		this.pendingStepOutTargets.clear();
		const now = Date.now();
		this.liveWatchSuspendFallbackBlockedUntilMs = now + 1500;
		this.postResetStackTrimUntilMs = now + 2000;
		this.primaryBreakpointStop = undefined;
		this.suppressPauseStoppedUntilMs = 0;
		this.cancelPendingPauseStoppedTimers('reset');
		this.clearAllFrameMeta();
	}

	private trimPostResetStack<T extends { mapToSource?: TCFCodeAreaLineNumbers }>(stack: T[]): T[] {
		if (Date.now() > this.postResetStackTrimUntilMs || stack.length <= 1) {
			return stack;
		}
		const trimmed: T[] = [stack[0]];
		for (const frame of stack.slice(1)) {
			if (frame?.mapToSource?.File && frame?.mapToSource?.SLine) {
				trimmed.push(frame);
				continue;
			}
			break;
		}
		return trimmed;
	}

	protected override onThreadSuspended(thread: number) {
		this.invalidateInspection(`thread ${thread} stopped`);
		this.clearFrameMetaForThread(thread);
		super.onThreadSuspended(thread);
	}

	protected override onThreadResumed(thread: number) {
		this.invalidateInspection(`thread ${thread} resumed`);
		this.clearFrameMetaForThread(thread);
		super.onThreadResumed(thread);
	}

	private getOrAssignThreadId(contextId: string): number {
		// Core contextId -> threadId mapping to keep thread IDs stable across sessions.
		// TCF agent context IDs: S0.D0.C0, S0.D0.C1, S0.D0.C2, ...
		// VS Code needs numeric thread IDs.
		// For example, core 0 and core 1 paused at the same time and first event arrives for core 1: we still want core 0 to be thread 1.
		const existing = this.contextToThreadId.get(contextId);
		if (existing) {
			this.threadIdToContext.set(existing, contextId);
			return existing;
		}

		// Deterministic thread IDs for AURIX multi-core contexts. This reduces UI "core highlight"
		// instability caused by threadId ordering depending on event arrival order.
		// Examples: S0.D0.C0 -> 1, S0.D0.C1 -> 2, S0.D0.C2 -> 3.
		let desiredId: number | undefined;
		const m = /(?:^|\.)C(\d+)(?:$|\b)/i.exec(contextId);
		if (m) {
			const coreNum = Number(m[1]);
			if (Number.isFinite(coreNum) && coreNum >= 0) {
				desiredId = coreNum + 1;
			}
		}

		let id: number;
		if (desiredId !== undefined && desiredId > 0) {
			const occupiedBy = this.threadIdToContext.get(desiredId);
			if (!occupiedBy || occupiedBy === contextId) {
				id = desiredId;
			} else {
				// Collision (unexpected): fall back to next free ID.
				id = 1;
				while (this.threadIdToContext.has(id)) {
					id++;
				}
			}
		} else {
			id = 1;
			while (this.threadIdToContext.has(id)) {
				id++;
			}
		}

		this.contextToThreadId.set(contextId, id);
		this.threadIdToContext.set(id, contextId);
		return id;
	}

	protected override convertClientPathToDebugger(p: string): string {
		const mapped = this.pathMapper(p);
		// The TCF side commonly uses '/' path separators even on Windows.
		return mapped.replace(/\\/g, '/');
	}

	protected override convertDebuggerPathToClient(p: string): string {
		const normalized = p.replace(/\\/g, '/');
		const isWindowsAbs = /^[a-zA-Z]:\//.test(normalized);
		const isAbs = path.isAbsolute(normalized) || isWindowsAbs;
		if (isAbs) {
			// Keep the absolute path shape but normalize separators for local FS.
			const localAbs = isWindowsAbs ? normalized.replace(/\//g, '\\') : normalized;
			if (fs.existsSync(localAbs)) {
				return localAbs;
			}

			// Fix: some toolchains embed absolute paths from a different machine/workspace
			// (e.g. "C:\\Infineon\\...\\TC375_CE\\Libraries\\..."). If that path doesn't exist locally,
			// remap it onto the detected local project root.
			const lower = normalized.toLowerCase();
			const tcMarker = '/tc375_ce/';
			const libMarker = '/libraries/';
			const candidates: string[] = [];
			if (this.projectRootDir) {
				const tcIndex = lower.indexOf(tcMarker);
				if (tcIndex >= 0) {
					const tail = normalized.substring(tcIndex + tcMarker.length);
					candidates.push(path.resolve(this.projectRootDir, ...tail.split('/')));
				}
				const libIndex = lower.indexOf(libMarker);
				if (libIndex >= 0) {
					const tail = normalized.substring(libIndex + 1); // "Libraries/..."
					candidates.push(path.resolve(this.projectRootDir, ...tail.split('/')));
				}
			}
			for (const c of candidates) {
				if (fs.existsSync(c)) {
					return c;
				}
			}

			return localAbs;
		}

		// Fix: debug info often reports project-relative paths (e.g. "Libraries/..."),
		// so resolve them to an existing local file by probing a few likely roots.
		const candidateBases: string[] = [];
		for (const base of [this.workspaceBaseDir, this.sourceResolverBaseDir].filter(Boolean) as string[]) {
			candidateBases.push(base);
		}
		// Also try parent folders of the ELF directory (common: <project>/TriCore Debug (GCC)/<elf>).
		// This helps open headers like "Libraries/..." when args.workspace is not the project root.
		if (this.sourceResolverBaseDir) {
			let dir = this.sourceResolverBaseDir;
			for (let i = 0; i < 6; i++) {
				dir = path.dirname(dir);
				candidateBases.push(dir);
				if (dir === path.dirname(dir)) {
					break;
				}
			}
		}
		// De-dup while keeping order.
		const seen = new Set<string>();
		const uniqueBases = candidateBases.filter((b) => {
			if (!b) {
				return false;
			}
			const key = path.resolve(b);
			if (seen.has(key)) {
				return false;
			}
			seen.add(key);
			return true;
		});
		for (const base of uniqueBases) {
			const candidate = path.resolve(base, normalized);
			if (fs.existsSync(candidate)) {
				return candidate;
			}
		}

		// Fix: some LineNumbers providers return only a basename (e.g. "Ifx_Ssw_CompilersGcc.h")
		// with no directory info. In that case, try to locate it under <projectRoot>/Libraries.
		if (this.projectRootDir && !normalized.includes('/') && normalized.trim() !== '') {
			const found = this.lookupLibrariesFileByBasename(normalized);
			if (found) {
				return found;
			}
		}
		return normalized;
	}

	private lookupLibrariesFileByBasename(basename: string): string | undefined {
		if (!this.projectRootDir) {
			return undefined;
		}
		if (!this.librariesBasenameIndex) {
			this.librariesBasenameIndex = new Map<string, string>();

			// Best-effort: index a limited number of files so this never blocks the debug adapter.
			// We only scan under "Libraries" because that's where missing headers typically live.
			const root = path.join(this.projectRootDir, 'Libraries');
			try {
				if (fs.existsSync(root) && fs.statSync(root).isDirectory()) {
					const stack: string[] = [root];
					let visited = 0;
					const maxVisited = 30000;
					while (stack.length > 0 && visited < maxVisited) {
						const dir = stack.pop()!;
						let entries: fs.Dirent[];
						try {
							entries = fs.readdirSync(dir, { withFileTypes: true });
						} catch {
							continue;
						}
						for (const ent of entries) {
							visited++;
							if (visited >= maxVisited) {
								break;
							}
							const full = path.join(dir, ent.name);
							if (ent.isDirectory()) {
								stack.push(full);
								continue;
							}
							if (!ent.isFile()) {
								continue;
							}
							const ext = path.extname(ent.name).toLowerCase();
							if (ext !== '.h' && ext !== '.hpp' && ext !== '.c' && ext !== '.cpp') {
								continue;
							}
							// Prefer the first hit to keep it deterministic.
							if (!this.librariesBasenameIndex.has(ent.name)) {
								this.librariesBasenameIndex.set(ent.name, full);
							}
						}
					}
				}
			} catch {
				// ignore
			}
		}

		return this.librariesBasenameIndex.get(basename);
	}

	private resolveMappedSourcePath(mapped: TCFCodeAreaLineNumbers): string | undefined {
		if (!mapped.File) {
			return undefined;
		}
		let fileFromDwarf: string = mapped.File;
		if (mapped.Dir && mapped.Dir.trim() !== '' && !path.isAbsolute(fileFromDwarf) && !/^[a-zA-Z]:[\\/]/.test(fileFromDwarf)) {
			const dir = mapped.Dir;
			const looksWindows = /^[a-zA-Z]:[\\/]/.test(dir) || dir.includes('\\');
			const joinedCandidate = looksWindows
				? path.win32.normalize(path.win32.join(dir, fileFromDwarf))
				: path.posix.normalize(path.posix.join(dir.replace(/\\/g, '/'), fileFromDwarf.replace(/\\/g, '/')));
			if (joinedCandidate) {
				if (looksWindows || fs.existsSync(joinedCandidate)) {
					fileFromDwarf = joinedCandidate;
				}
			}
		}
		return this.convertDebuggerPathToClient(fileFromDwarf);
	}

	private async initDefaultPathMapper(args: AurixTCFLaunchRequestArguments): Promise<void> {
		// If the user didn't provide a custom mapper, default to a DWARF-typical
		// layout: sources referenced relative to the build output directory.
		//
		// For AURIX ADS/GCC projects, the compiler commonly invokes sources like
		// "../Cpu0_Main.c" from the build directory (where the .elf lives). In that
		// case, sending an absolute Windows path to TCF Breakpoints/LineNumbers will
		// produce "No debug information for this source line" even when DWARF exists.
		if (args.pathMapper && args.pathMapper.trim() !== '') {
			return;
		}
		if (!args.program || args.program.trim() === '') {
			return;
		}

		const programDir = path.dirname(args.program);
		this.sourceResolverBaseDir = programDir;

		// Map client paths to paths relative to the .elf directory.
		// Keep already-relative paths as-is.
		this.pathMapper = (p: string) => {
			if (!p) {
				return p;
			}

			const normalized = p.replace(/\\/g, '/');
			const alreadyRelative = !path.isAbsolute(normalized) && !/^[a-zA-Z]:\//.test(normalized);
			if (alreadyRelative) {
				return normalized;
			}

			try {
				// Use OS-specific path APIs for correctness (drive letters, etc.)
				const rel = path.relative(programDir, p);
				// If drives differ, path.relative returns an absolute-ish path containing ':'; ignore it.
				if (!rel || /^[a-zA-Z]:/.test(rel) || path.isAbsolute(rel)) {
					return normalized;
				}
				return rel.replace(/\\/g, '/');
			} catch {
				return normalized;
			}
		};
	}

	/**
	 * Detect core type from a RunControl context ID or Name.
	 * Returns { type, index } or undefined if it's a plain TriCore context.
	 */
	private static extractCoreType(idOrName: string): { type: 'PPU' | 'CDSP' | 'SCR'; index: number } | undefined {
		if (/\bPPU\b/i.test(idOrName)) {
			return { type: 'PPU', index: 0 };
		}
		const cdspMatch = idOrName.match(/\bCDSP(\d+)\b/i);
		if (cdspMatch) {
			return { type: 'CDSP', index: parseInt(cdspMatch[1], 10) };
		}
		if (/\bSCR\b/i.test(idOrName)) {
			return { type: 'SCR', index: 0 };
		}
		return undefined;
	}

	/**
	 * Resolve the ELF path for a given core type, falling back to the main program ELF.
	 */
	private getElfPathForCore(
		coreInfo: { type: 'PPU' | 'CDSP' | 'SCR'; index: number } | undefined,
		args: AurixTCFLaunchRequestArguments,
	): string | undefined {
		if (coreInfo) {
			switch (coreInfo.type) {
				case 'PPU':
					if (args.ppuElfPath && args.ppuElfPath.trim() !== '') { return args.ppuElfPath; }
					break;
				case 'CDSP':
					if (Array.isArray(args.cdspElfPaths) && args.cdspElfPaths[coreInfo.index]?.trim()) {
						return args.cdspElfPaths[coreInfo.index];
					}
					break;
				case 'SCR':
					if (args.scrElfPath && args.scrElfPath.trim() !== '') { return args.scrElfPath; }
					break;
			}
		}
		// Fallback to main TriCore ELF
		return args.program && args.program.trim() !== '' ? args.program : undefined;
	}

	private async initMemoryMap(args: AurixTCFLaunchRequestArguments): Promise<void> {
		// Enumerate leaf execution contexts (HasState === true) from the agent,
		// identify each core type (PPU/CDSPx/SCR/TriCore), and set a MemoryMap
		// entry pointing to the core-specific ELF.
		// Only leaf contexts with HasState are valid MemoryMap targets; container
		// contexts (e.g. S0, S0.D0) must be skipped or the agent may reset the connection.
		try {
			const threads = await this.tcfClient.getThreads();
			if (threads.length === 0) {
				this.tcfLogger.log('initMemoryMap: no execution contexts found');
				return;
			}

			let mappedCount = 0;
			for (const thread of threads) {
				const contextId = thread.info.ID;
				const contextName = thread.info.Name ?? '';
				// Try ID first, then Name for core type detection
				const coreInfo = AurixTCFDebugSession.extractCoreType(contextId)
					?? AurixTCFDebugSession.extractCoreType(contextName);
				const elfPath = this.getElfPathForCore(coreInfo, args);
				if (!elfPath) {
					continue;
				}

				// Verify the file exists locally before trying to set the mapping.
				try {
					const st = await fsPromises.stat(elfPath);
					if (!st.isFile()) { continue; }
				} catch {
					continue;
				}

				const fileName = elfPath.replace(/\\/g, '/');
				const coreLabel = coreInfo ? `${coreInfo.type}${coreInfo.type === 'CDSP' ? coreInfo.index : ''}` : 'TriCore';
				try {
					await this.tcfClient.sendCommand(
						new SetMemoryMapCommand(contextId, [
							{ ['FileName']: fileName, ['ID']: contextId },
						])
					);
					mappedCount++;
					this.tcfLogger.log(`MemoryMap: ${contextId} (${coreLabel}) → ${fileName}`);
				} catch (e) {
					this.tcfLogger.error(`MemoryMap failed for ${contextId} (${coreLabel}): ${String(e)}`);
				}
			}

			this.tcfLogger.log(`MemoryMap initialized: ${mappedCount} context(s) mapped`);
		} catch (e) {
			this.tcfLogger.error(`MemoryMap initialization failed: ${String(e)}`);
		}
	}

	private async pickContextIdForCore(core: number | undefined): Promise<string | undefined> {
		// Pick a context ID matching the requested core number.
		// If core is undefined, pick the first available context.
		// If no matching core is found, fall back to the first available context.
		// For example, core=0 -> S0.D0.C0

		// Use cached result when available (core-to-context mapping is stable within a session).
		const coreKey = core ?? undefined;
		if (this.cachedCoreContextKey === coreKey && this.cachedCoreContextId !== undefined) {
			return this.cachedCoreContextId;
		}

		const infos = await this.tcfClient.getThreads();
		if (infos.length === 0) {
			this.startupLog(`pickContextIdForCore(core=${String(core)}): no threads from agent`);
			return undefined;
		}
		if (core === undefined || core === null) {
			this.startupLog(`pickContextIdForCore(core=undefined): picked first=${infos[0].info.ID}`);
			this.cachedCoreContextKey = undefined;
			this.cachedCoreContextId = infos[0].info.ID;
			return this.cachedCoreContextId;
		}

		const idRe = new RegExp(`(?:^|\\.)C${core}(?:$|\\b)`, 'i');
		const nameRe = new RegExp(`\\bcore\\s*${core}\\b|\\bC${core}\\b`, 'i');
		const found = infos.find(t => idRe.test(t.info.ID) || (t.info.Name ? nameRe.test(t.info.Name) : false));
		const picked = (found ?? infos[0]).info.ID;
		this.startupLog(`pickContextIdForCore(core=${core}): picked=${picked}${found ? '' : ' (fallback)'}`);
		this.focusLog(`pickContextIdForCore(core=${String(core)}): picked=${picked}${found ? ' (matched)' : ' (fallback)'}`);
		this.cachedCoreContextKey = coreKey;
		this.cachedCoreContextId = picked;
		return picked;
	}

	private async emitStoppedIfSuspended(contextId: string, reason: StoppedEventReason): Promise<void> {
		const infos = await this.tcfClient.getThreads();
		const match = infos.find(t => t.info.ID === contextId);
		if (!match) {
			this.startupLog(`emitStoppedIfSuspended(${contextId}, reason=${reason}): context not found; ${this.formatThreadsSnapshot(infos)}`);
			return;
		}
		if (!match.state?.suspended) {
			this.startupLog(`emitStoppedIfSuspended(${contextId}, reason=${reason}): not suspended`);
			return;
		}
		const threadId = this.getOrAssignThreadId(contextId);
		this.onThreadSuspended(threadId);
		this.sendStoppedEvent(reason, threadId);
		this.startupLog(`emitStoppedIfSuspended(${contextId}, reason=${reason}): emitted StoppedEvent(threadId=${threadId})`);
	}

	private async emitStoppedForAllSuspendedAtStartup(
		// The targetContextId is the one the user requested to stop on (if any).
		// We prefer to emit the stopped event for that core if it's suspended,
		// otherwise we pick any other suspended core.
		// This helps keep the UI stable during startup (no core switching).
		targetContextId: string | undefined,
		opts?: { targetReason?: StoppedEventReason; otherReason?: StoppedEventReason }
	): Promise<void> {
		try {
			const version = this.breakpointStops.version;
			const infos = await this.tcfClient.getThreads(true);
			if (version !== this.breakpointStops.version) {
				return;
			}
			const suspended = infos.filter(t => Boolean(t.state?.suspended)).map(t => t.info.ID);
			this.startupLog(`emitStoppedForAllSuspendedAtStartup: suspended=${suspended.length ? suspended.join(', ') : '(none)'}`);
			const targetReason = opts?.targetReason ?? StoppedEventReason.pause;

			// Mark all suspended cores in our internal state and invalidate per-thread cached references.
			for (const ctx of suspended) {
				const threadId = this.getOrAssignThreadId(ctx);
				this.suspendedContextIds.add(ctx);
				this.onThreadSuspended(threadId);
			}

			// Keep startup focus on one core without claiming that running siblings are stopped.
			let focusCtx = targetContextId;
			if (!focusCtx || !suspended.includes(focusCtx)) {
				focusCtx = suspended.length > 0 ? suspended[0] : undefined;
			}
			if (focusCtx) {
				const threadId = this.getOrAssignThreadId(focusCtx);
				if (targetReason === StoppedEventReason.breakpoint) {
					this.notifyBreakpointStopped(focusCtx);
				} else {
					const allThreadsStopped = infos.length > 0 && infos.every(thread => thread.state.suspended);
					this.sendStoppedEvent(targetReason, threadId, { allThreadsStopped, preserveFocusHint: false });
					this.startupLog(`emitStoppedForAllSuspendedAtStartup: emitted ${targetReason} for ${focusCtx} (threadId=${threadId}) allThreadsStopped=${allThreadsStopped}`);
				}
			}
		} catch (e) {
			this.startupLog(`emitStoppedForAllSuspendedAtStartup: failed: ${String(e)}`);
		}
	}

	private async resumeOtherCoresIfNeeded(targetContextId: string | undefined, args: AurixTCFLaunchRequestArguments): Promise<void> {
		// User expectation: stop on one core while other cores keep running.
		if (!args.stopOnEntry || targetContextId === undefined) {
			return;
		}
		if (args.resumeOtherCoresOnEntry !== true) {
			return;
		}

		try {
			const infos = await this.tcfClient.getThreads();
			const othersSuspended = infos
				.filter(t => t.info.ID !== targetContextId)
				.filter(t => Boolean(t.state?.suspended))
				.map(t => t.info.ID);
			this.startupLog(`resumeOtherCoresOnEntry: target=${targetContextId}, othersSuspended=${othersSuspended.length ? othersSuspended.join(', ') : '(none)'}`);

			for (const other of othersSuspended) {
				try {
					await this.tcfClient.continue(other);
					this.startupLog(`resumeOtherCoresOnEntry: continued ${other}`);
				} catch {
					// best-effort; some contexts might not be resumable
					this.startupLog(`resumeOtherCoresOnEntry: failed to continue ${other}`);
				}
			}
		} catch {
			// best-effort only
		}
	}

	private async getRegisterContextChildren(parentId: string): Promise<string[]> {
		return (await this.tcfClient.sendCommand(new GetChildrenRegistersCommand(parentId))) || [];
	}

	private normalizeRegisterGroupName(v: unknown): string {
		return (typeof v === 'string' ? v : '').trim().toLowerCase();
	}

	/**
	 * Filters the top-level register groups to only those whose group/peripheral name is "CORE".
	 *
	 * NOTE: Some agents expose a single container node at the top; in that case we peek one level
	 * deeper and try to return only its CORE children.
	 */
	private async filterRegisterRootIdsToCoreName(threadContextId: string, rootIds: string[]): Promise<string[]> {
		if (rootIds.length === 0) {
			return rootIds;
		}

		const wanted = new Set(['core', 'core registers']);

		const describe = async (id: string): Promise<{ id: string; name: string }> => {
			try {
				const ctx = await this.tcfClient.sendCommand(new GetContextRegistersCommand(id));
				return { id, name: this.normalizeRegisterGroupName(ctx?.Name) };
			} catch {
				return { id, name: '' };
			}
		};

		const entries = await Promise.all(rootIds.map(describe));
		if (this.startupDiagnosticsEnabled) {
			const preview = entries
				.slice(0, 20)
				.map(e => `${e.id}:${e.name || '(no-name)'}`)
				.join(', ');
		}
		const directMatches = entries.filter(e => wanted.has(e.name) || e.name === 'core');
		if (directMatches.length > 0) {
			return directMatches.map(e => e.id);
		}

		// If we only got a container group at the top, try its children.
		if (entries.length === 1) {
			try {
				const childIds = await this.getRegisterContextChildren(entries[0].id);
				if (childIds.length > 0) {
					const childEntries = await Promise.all(childIds.map(describe));
					if (this.startupDiagnosticsEnabled) {
						const childPreview = childEntries
							.slice(0, 20)
							.map(e => `${e.id}:${e.name || '(no-name)'}`)
							.join(', ');
					}
					const childMatches = childEntries.filter(e => wanted.has(e.name) || e.name === 'core');
					if (childMatches.length > 0) {
						return childMatches.map(e => e.id);
					}
				}
			} catch {
				// best-effort
			}
		}

		// No CORE group detected. Keep existing behavior (show everything), but log when diagnostics are enabled.
		if (this.startupDiagnosticsEnabled) {
			this.tcfLogger?.log?.(
				`[dap] filterRegisterRootIdsToCoreName: no CORE group found for ctx=${threadContextId}; leaving unfiltered`
			);
		}
		return rootIds;
	}

	private async registersContextToVariable(registerContextId: string, parentRef: number): Promise<any> {
		const ctx = await this.tcfClient.sendCommand(new GetContextRegistersCommand(registerContextId));
		const name = ctx?.Name || registerContextId;

		const childrenIds = await this.getRegisterContextChildren(registerContextId);
		if (childrenIds.length > 0) {
			return {
				name: () => name,
				displayValue: async () => '',
				getChildren: async () => {
					const children = [];
					for (const childId of childrenIds) {
						children.push(await this.registersContextToVariable(childId, parentRef));
					}
					return children;
				},
			};
		}

		if (ctx?.Readable && typeof ctx.Size === 'number' && ctx.Size > 0) {
			const buf = await this.tcfClient.sendCommand(new GetRegistersCommand(registerContextId));
			// Show raw bytes as hex. Endianness varies by target; presenting bytes avoids guessing.
			const hex = buf.toString('hex');
			const value = hex.length ? `0x${hex}` : '';
			return {
				name: () => name,
				displayValue: async () => value,
				getChildren: async () => [],
			};
		}

		return {
			name: () => name,
			displayValue: async () => '',
			getChildren: async () => [],
		};
	}

	protected override initializeRequestAsync(response: DebugProtocol.InitializeResponse, args: DebugProtocol.InitializeRequestArguments): Promise<void> {
		response.body = response.body || {};
		response.body.supportsConfigurationDoneRequest = true;
		response.body.supportsEvaluateForHovers = true;
		(response.body as any).supportsInvalidatedEvent = true;
		response.body.supportsSetVariable = false;
		response.body.supportSuspendDebuggee = true;
		response.body.supportTerminateDebuggee = true;
		response.body.supportsInstructionBreakpoints = true;
		response.body.supportsReadMemoryRequest = true;
		response.body.supportsWriteMemoryRequest = true;
		(response.body as any).supportsDisassembleRequest = true;
		this.sendResponse(response);
		return Promise.resolve();
	}


	private parseMemoryReference(ref: string): number | undefined {
		const s = ref.trim();
		if (s === '') {
			return undefined;
		}
		if (/^0x[0-9a-f]+$/i.test(s)) {
			const n = Number.parseInt(s.substring(2), 16);
			return Number.isFinite(n) ? n : undefined;
		}
		if (/^[0-9]+$/.test(s)) {
			const n = Number.parseInt(s, 10);
			return Number.isFinite(n) ? n : undefined;
		}
		const n = Number(s);
		return Number.isFinite(n) ? n : undefined;
	}

	private sumErrorBytes(errors?: MemoryErrorAddress[] | null): number {
		if (!errors || errors.length === 0) {
			return 0;
		}
		return errors.reduce((sum, e) => sum + (Number.isFinite(e?.size) ? e.size : 0), 0);
	}

	private computeWriteWordSize(address: number, length: number): number {
		if (!Number.isFinite(address) || !Number.isFinite(length) || length <= 0) {
			return 1;
		}
		if (address % 4 === 0 && length % 4 === 0) {
			return 4;
		}
		if (address % 2 === 0 && length % 2 === 0) {
			return 2;
		}
		return 1;
	}

	private isPeripheralAddress(address: number): boolean {
		if (!Number.isFinite(address)) {
			return false;
		}
		// AURIX peripheral/SFR space lives in the 0xF000_0000+ region.
		return (address >>> 0) >= 0xF0000000;
	}

	private async readMemoryBestEffort(
		// Read memory in chunks to maximize the amount of data read even if some regions are unreadable.
		// For example, read 1 KiB in 64-byte chunks.
		// Returns null if the request is out of bounds for fallback reading.
		// Some memory regions cannot be read at all (e.g. peripheral registers).
		ctx: string,
		address: number,
		count: number
	): Promise<{ base64: string; unreadableBytes?: number } | null> {
		if (count < MEMORY_READ_FALLBACK_MIN_BYTES || count > MEMORY_READ_FALLBACK_MAX_BYTES) {
			return null;
		}

		const buffer = Buffer.alloc(count);
		let unreadableBytes = 0;

		for (let offset = 0; offset < count; offset += MEMORY_READ_FALLBACK_CHUNK_BYTES) {
			this.checkNotDisconnecting();
			const chunkSize = Math.min(MEMORY_READ_FALLBACK_CHUNK_BYTES, count - offset);
			try {
				const result = await this.tcfClient.sendCommand(new GetMemoryCommand(ctx, address + offset, 1, chunkSize, 0));
				this.checkNotDisconnecting();
				const data = result?.base64 ? Buffer.from(result.base64, 'base64') : Buffer.alloc(0);
				if (data.length > 0) {
					data.copy(buffer, offset, 0, Math.min(data.length, chunkSize));
				}
				const missing = Math.max(0, chunkSize - data.length);
				const errorBytes = this.sumErrorBytes(result?.errorAddresses);
				const chunkUnreadable = Math.min(chunkSize, Math.max(missing, errorBytes));
				unreadableBytes += chunkUnreadable;
			} catch {
				this.checkNotDisconnecting();
				unreadableBytes += chunkSize;
			}
		}

		return {
			base64: buffer.toString('base64'),
			unreadableBytes: unreadableBytes > 0 ? unreadableBytes : undefined,
		};
	}

	protected override async readMemoryRequestAsync(response: DebugProtocol.ReadMemoryResponse, args: DebugProtocol.ReadMemoryArguments): Promise<void> {
		// 1) Parse memoryReference + offset from DAP request and compute start address.
		// 2) Pick a suitable context ID (core) to issue the read memory command to.
		// 3) Send GetMemory command to TCF agent.
		// 4) Format and return the read bytes.
		// For example, memoryReference="0x20000000", offset=16, count=32
		// -> read 32 bytes starting at address 0x20000010
		let peripheralRange: string | undefined;
		try {
			this.checkNotDisconnecting();
			const memoryReference = typeof args?.memoryReference === 'string' ? args.memoryReference : '';
			const base = this.parseMemoryReference(memoryReference);
			if (base === undefined) {
				this.sendErrorResponse(response, 0, 'Invalid memoryReference');
				return;
			}

			const offset = typeof args?.offset === 'number' && Number.isFinite(args.offset) ? args.offset : 0;
			const count = typeof args?.count === 'number' && Number.isFinite(args.count) ? args.count : 0;
			if (count <= 0) {
				response.body = { address: `0x${(base + offset).toString(16)}`, data: '' };
				this.sendResponse(response);
				return;
			}

			const address = base + offset;
			if (!Number.isSafeInteger(address) || address < 0 || !Number.isInteger(count) ||
				address + count > 0x100000000) {
				throw new Error('Invalid or overflowing memory read range.');
			}
			if (address + count > 0xf0000000 || this.nativePeripherals?.hasAddress(address)) {
				peripheralRange = `0x${address.toString(16)} (${count} bytes)`;
			}
			let ctx = await this.pickContextIdForCore(this.launchCore);
			this.checkNotDisconnecting();
			if (!ctx) {
				ctx = await this.pickAnySuspendedContextId();
				this.checkNotDisconnecting();
			}
			if (!ctx) {
				throw new Error('No suspended context for memory read');
			}
			// Peripheral Viewer speaks DAP readMemory, but SFRs must never reach TCF Memory.get.
			if (peripheralRange && this.nativePeripherals) {
				const { check, verify } = await this.viewerContext(ctx);
				const bytes = await this.nativePeripherals.readRange(ctx, address, count, check);
				await verify();
				check();
				response.body = { address: `0x${address.toString(16)}`, data: bytes.toString('base64') };
				this.sendResponse(response);
				return;
			}
			if (peripheralRange) {
				const reader = await this.peripheralReader();
				const options = { threadId: this.getOrAssignThreadId(ctx), epoch: this.inspectionEpoch, expiresAt: Date.now() + 9500 };
				const { contextId, check } = await this.inspectionContext(options);
				const bytes = await reader.readViewerRange(contextId, address, count, check);
				await this.inspectionContext(options);
				check();
				response.body = { address: `0x${address.toString(16)}`, data: bytes.toString('base64') };
				this.sendResponse(response);
				return;
			}
			try {
				const result = await this.tcfClient.sendCommand(new GetMemoryCommand(ctx, address, 1, count, 0));
				this.checkNotDisconnecting();
				const unreadableBytes = this.sumErrorBytes(result?.errorAddresses);
				response.body = {
					address: `0x${address.toString(16)}`,
					data: result?.base64 || '',
					unreadableBytes: unreadableBytes > 0 ? unreadableBytes : undefined,
				};
				this.sendResponse(response);
			} catch (e) {
				this.checkNotDisconnecting();
				const fallback = await this.readMemoryBestEffort(ctx, address, count);
				this.checkNotDisconnecting();
				if (fallback) {
					response.body = {
						address: `0x${address.toString(16)}`,
						data: fallback.base64,
						unreadableBytes: fallback.unreadableBytes,
					};
					this.sendResponse(response);
					return;
				}
				this.sendErrorResponse(response, 0, 'readMemory failed {message}', { message: String(e) });
			}
		} catch (e) {
			if (this.disconnecting) {
				if (!this.memoryDisconnectReported) {
					this.memoryDisconnectReported = true;
					this.sendEvent(new OutputEvent(
						`[Memory] Refresh cancelled during debug disconnect: ${String(e)}. No bytes returned.\n`, 'console'));
				}
				// Viewer stops its remaining refresh ranges on this non-user-facing DAP error.
				this.sendErrorResponse(response, { id: 0, format: 'busy', showUser: false });
				return;
			}
			if (peripheralRange && e instanceof InspectionStateChangedError) {
				if (e.currentEpoch > this.lastPeripheralCancellationEpoch) {
					this.lastPeripheralCancellationEpoch = e.currentEpoch;
					this.sendEvent(new OutputEvent(
						`[Peripheral Viewer] Refresh cancelled at ${peripheralRange}: ${e.reason} ` +
						`(inspection epoch ${e.previousEpoch} -> ${e.currentEpoch}).\n` +
						'No bytes returned; displayed values may be cached/default values. ' +
						'Refresh after all cores are stopped and stable.\n', 'console'));
				}
				// Viewer recognizes this exact error and stops the remaining ranges in this refresh.
				this.sendErrorResponse(response, { id: 0, format: 'busy', showUser: false });
				return;
			}
			if (peripheralRange) {
				this.sendEvent(new OutputEvent(
					`[Peripheral Viewer] Read failed at ${peripheralRange}: ${String(e)}\n` +
					'No peripheral bytes were returned. XPeripherals may still show cached/default values (including zero); ' +
					'these are not measured values. After all cores are stopped and stable, refresh the peripheral. ' +
					'See Peripheral Viewer output for details.\n', 'stderr'));
			}
			this.sendErrorResponse(response, 0, 'readMemory failed {message}', { message: String(e) });
		}
	}

	protected override async writeMemoryRequestAsync(response: DebugProtocol.WriteMemoryResponse, args: DebugProtocol.WriteMemoryArguments): Promise<void> {
		// 1) Parse memoryReference + offset from DAP request and compute start address.
		// 2) Pick a suitable context ID (core) to issue the write memory command to.
		// 3) Send SetMemory command to TCF agent.
		// 4) Format and return the number of bytes written.
		try {
			const memoryReference = typeof args?.memoryReference === 'string' ? args.memoryReference : '';
			const base = this.parseMemoryReference(memoryReference);
			if (base === undefined) {
				this.sendErrorResponse(response, 0, 'Invalid memoryReference');
				return;
			}

			const offset = typeof args?.offset === 'number' && Number.isFinite(args.offset) ? args.offset : 0;
			const dataBase64 = typeof args?.data === 'string' ? args.data : '';
			const bytes = Buffer.from(dataBase64, 'base64');
			const requestedLength = bytes.length;
			const address = base + offset;
			if (!Number.isSafeInteger(address) || address < 0 || address + requestedLength > 0x100000000) {
				throw new Error('Invalid peripheral write address.');
			}
			if (address + requestedLength > 0xf0000000 || this.nativePeripherals?.hasAddress(address)) {
				if (!this.nativePeripherals) { throw new Error('Native peripheral writes are unavailable; no memory fallback is allowed.'); }
				if (!requestedLength || bytes.toString('base64') !== dataBase64) { throw new Error('Invalid peripheral write payload.'); }
				const contextId = await this.pickContextIdForCore(this.launchCore);
				if (!contextId) { throw new Error('No context for peripheral write.'); }
				if (this.peripheralWritesInFlight) { throw new Error('Another peripheral write is in progress.'); }
				this.peripheralWritesInFlight++;
				try {
					const { check } = await this.viewerContext(contextId);
					await this.nativePeripherals.writeRegister(contextId, address, bytes, check);
				} catch (error) {
					throw new Error(`Peripheral write failed: ${String(error)} If dispatch occurred, the write may already have taken effect; it was not retried.`);
				} finally {
					this.peripheralWritesInFlight--;
					this.invalidateInspection('manual peripheral write');
				}
				response.body = { offset: 0, bytesWritten: bytes.length };
				this.sendResponse(response);
				return;
			}
			let targetAddress = address;
			let writeBytes = bytes;
			let wordSize = this.computeWriteWordSize(address, bytes.length);
			let writeMode = bytes.length >= 4 && bytes.length % 4 === 0 ? 1 : 0;

			const ctx = (await this.pickContextIdForCore(this.launchCore)) ?? (await this.pickAnySuspendedContextId());
			if (!ctx) {
				this.sendErrorResponse(response, 0, 'No suspended context for memory write');
				return;
			}

			// Peripheral registers often require 32-bit aligned writes.
			// If the request is smaller than 4 bytes, attempt a read-modify-write on the aligned word.
			if (requestedLength > 0 && requestedLength < 4 && this.isPeripheralAddress(address)) {
				const aligned = address - (address % 4);
				const byteOffset = address - aligned;
				try {
					const result = await this.tcfClient.sendCommand(new GetMemoryCommand(ctx, aligned, 1, 4, 0));
					const existing = result?.base64 ? Buffer.from(result.base64, 'base64') : Buffer.alloc(0);
					if (existing.length >= 4) {
						const patched = Buffer.from(existing.subarray(0, 4));
						bytes.copy(patched, byteOffset, 0, Math.min(requestedLength, 4 - byteOffset));
						targetAddress = aligned;
						writeBytes = patched;
						wordSize = 4;
						writeMode = 1;
					}
				} catch {
					// If RMW fails, fall back to the original write request.
				}
			}

			const errors = await this.tcfClient.sendCommand(
				new SetMemoryCommand(ctx, targetAddress, wordSize, writeBytes.length, writeBytes.toString('base64'), writeMode)
			);
			const errorBytes = this.sumErrorBytes(errors);
			if (errorBytes > 0 && args?.allowPartial !== true) {
				this.sendErrorResponse(response, 0, 'Partial write refused by adapter');
				return;
			}

			response.body = { bytesWritten: Math.max(0, requestedLength - errorBytes) };
			this.sendResponse(response);
		} catch (e) {
			this.sendErrorResponse(response, 0, 'writeMemory failed {message}', { message: String(e) });
		}
	}

	protected override async disassembleRequestAsync(response: DebugProtocol.DisassembleResponse, args: DebugProtocol.DisassembleArguments): Promise<void> {
		// 1) Parse memoryReference + offset from DAP request and compute start address.
		//    (typically around the current PC reported by stackTrace)
		// 2) Pick a suitable context ID (core) to issue the disassemble command to.
		// 3) Query disassembly capabilities (ISAs) if not already cached.
		// 4) Send Disassemble command to TCF agent.
		// 5) Format and return the disassembly lines.
		try {
			const memoryReference = typeof args?.memoryReference === 'string' ? args.memoryReference.trim() : '';
			if (memoryReference === '') {
				throw new Error('Missing memoryReference');
			}

			const base = this.parseMemoryReference(memoryReference);
			if (base === undefined || !Number.isSafeInteger(base) || base < 0) {
				throw new Error('Invalid memoryReference');
			}

			const offset = args.offset ?? 0;
			const instructionOffset = args.instructionOffset ?? 0;
			const instructionCount = args.instructionCount;
			if (!Number.isSafeInteger(offset) || !Number.isSafeInteger(instructionOffset) ||
				!Number.isSafeInteger(instructionCount) || instructionCount < 0) {
				throw new Error('Invalid disassembly count or offset');
			}
			const baseAddress = base + offset;
			if (!Number.isSafeInteger(baseAddress)) {
				throw new Error('Disassembly address exceeds supported precision');
			}
			if (instructionCount === 0) {
				response.body = { instructions: [] };
				this.sendResponse(response);
				return;
			}
			// TriCore instructions are 2 or 4 bytes. Use max size to ensure we cover the requested window.
			const minInstrBytes = 2;
			const maxInstrBytes = 4;
			const alignedBaseAddress = baseAddress - (baseAddress % minInstrBytes);
			let startAddress = alignedBaseAddress + (instructionOffset * maxInstrBytes);
			if (!Number.isSafeInteger(startAddress)) {
				throw new Error('Disassembly offset exceeds supported precision');
			}

			const ctx = (await this.pickContextIdForCore(this.launchCore)) ?? (await this.pickAnySuspendedContextId());
			if (!ctx) {
				throw new Error('No context for disassembly');
			}

			if (this.disassemblyCapabilities === undefined) {
				try {
					const caps = await this.tcfClient.sendCommand(new GetCapabilitiesDisassemblyCommand(ctx));
					this.disassemblyCapabilities = (caps || [])
						.map(c => (c?.ISA ? String(c.ISA) : ''))
						.filter(x => x.trim() !== '');
				} catch (error) {
					this.tcfLogger.error(`Cannot query disassembly capabilities: ${String(error)}`);
					this.disassemblyCapabilities = [];
				}
			}
			if (!this.disassemblyCapabilitiesLogged) {
				this.disassemblyCapabilitiesLogged = true;
				const capsText = (this.disassemblyCapabilities || []).join(', ');
				this.tcfLogger.log(`Disassembly capabilities (ISAs): ${capsText || '(none reported)'}`);
			}

			// Request enough bytes to produce the requested window + a small margin.
			// The agent disassembler falls back to .byte/.half/.word if ISA-specific decoding is unavailable.
			const windowInstrs = instructionCount + Math.abs(instructionOffset) + 16;
			let byteBudget = Math.max(1, windowInstrs * maxInstrBytes);

			// Clip to executable ranges from the ELF (if available).
			const execRange = this.findExecutableRangeForAddress(alignedBaseAddress);
			if (this.execRanges.length > 0 && !execRange) {
				response.body = { instructions: disassemblyWindow([], alignedBaseAddress, instructionOffset, instructionCount) };
				this.sendResponse(response);
				return;
			}
			if (execRange) {
				const maxBytesNeeded = instructionCount * maxInstrBytes;
				let maxStart = execRange.end - maxBytesNeeded;
				if (maxStart < execRange.start) {
					maxStart = execRange.start;
				}
				startAddress = Math.min(Math.max(startAddress, execRange.start), maxStart);
				startAddress = startAddress - (startAddress % minInstrBytes);
				byteBudget = Math.max(1, Math.min(byteBudget, execRange.end - startAddress));
				if (byteBudget <= 0) {
					response.body = { instructions: disassemblyWindow([], alignedBaseAddress, instructionOffset, instructionCount) };
					this.sendResponse(response);
					return;
				}
			}
			const disassembleAt = async (addr: number) => {
				return await this.tcfClient.sendCommand(
					new DisassembleDisassemblyCommand(ctx, addr, execRange ? Math.min(byteBudget, execRange.end - addr) : byteBudget, {
						ISA: 'TRICORE',
						Simplified: true,
						PseudoInstructions: true,
						OpcodeValue: true,
					})
				);
			};
			let lines = await disassembleAt(startAddress);

			if (!lines?.some(line => line.Address === alignedBaseAddress)) {
				// Retry disassembly anchored at the aligned base address.
				lines = await disassembleAt(alignedBaseAddress);
			}
			const instructions = disassemblyWindow(lines ?? [], alignedBaseAddress, instructionOffset, instructionCount);

			response.body = { instructions };
			this.sendResponse(response);
		} catch (e) {
			this.sendErrorResponse(response, 0, 'Disassemble error {message}', { message: String(e) });
		}
	}


	protected override async launchRequestAsync(response: DebugProtocol.LaunchResponse, rawArgs: DebugProtocol.LaunchRequestArguments): Promise<void> {
		const args = rawArgs as AurixTCFLaunchRequestArguments;
		this.launchCore = args.core;
		this.inspectionMemoryRanges = undefined;
		this.inspectionPeripheralProfile = args.peripheralReadProfile === 'disabled' ? undefined : preparedPeripheralProfile(args.svdFile);
		this.mcpPeripheralMode = args.peripheralReadProfile === 'disabled' ? 'disabled' :
			args.peripheralReadProfile === peripheralProfileName ? 'legacy' : 'full';
		const peripheralCatalog = preparedPeripheralCatalog(args.svdFile);
		this.nativePeripherals = peripheralCatalog ? new NativePeripheralAccess(command => this.tcfClient.sendCommand(command), peripheralCatalog) : undefined;
		this.peripheralNotice = args.__aurixPeripheralNotice ?? (this.inspectionPeripheralProfile
			? `Read-only peripheral profile: ${this.inspectionPeripheralProfile.registers.length} approved registers.`
			: 'Peripheral reads are disabled or unavailable for this session; select a matching SVD and relaunch.');
		this.sendEvent(new OutputEvent(`${this.peripheralNotice}\n`, 'console'));
		this.instructionSteppingEnabled = args.instructionStepping === true;
		this.liveWatchEnabled = args.liveWatchEnabled === true;
		this.liveWatchIntervalMs = this.normalizeLiveWatchIntervalMs(args.liveWatchIntervalMs);
		this.launchResetType = typeof args.resetType === 'string' && args.resetType.trim() !== '' ? args.resetType.trim() : undefined;
		// Default: run after reset so we stop at first breakpoint / stop-at-function.
		this.launchResetSuspend = args.resetSuspend === true;
		const host = args.host || DEFAULT_TCF_HOST;
		const port = args.port || DEFAULT_TCF_PORT;
		this.breakpointPrefix = args.breakpointPrefix ?? DEFAULT_BREAKPOINTS_PREFIX;
		this.programPath = args.program;
		if (this.programPath && this.programPath.trim() !== '') {
			try {
				this.execRanges = this.loadExecutableRangesFromElf(this.programPath);
				if (this.execRanges.length > 0) {
					this.tcfLogger.log(
						`ELF executable ranges: ${this.execRanges.map(r => `0x${r.start.toString(16)}-0x${r.end.toString(16)}`).join(', ')}`
					);
				}
			} catch (e) {
				this.execRanges = [];
				this.tcfLogger.error(`Failed to parse ELF executable ranges: ${String(e)}`);
			}
		}
		this.workspaceBaseDir = undefined;
		this.projectRootDir = undefined;
		if (args.workspace && args.workspace.trim() !== '') {
			// Best-effort: args.workspace may be a folder or a workspace-file path.
			const wsPath = path.resolve(args.workspace);
			try {
				const st = fs.statSync(wsPath);
				this.workspaceBaseDir = st.isDirectory() ? wsPath : path.dirname(wsPath);
			} catch {
				this.workspaceBaseDir = path.dirname(wsPath);
			}
		}
		this.configuredGlobals = Array.isArray(args.globals) ? args.globals.filter(x => typeof x === 'string' && x.trim() !== '') : [];
		await this.initDefaultPathMapper(args);

		// Detect the local project root (where "Libraries" lives). This is used to remap
		// non-local absolute paths reported by the toolchain (e.g. a different workspace root).
		const rootSearchStarts = [this.workspaceBaseDir, this.sourceResolverBaseDir].filter(Boolean) as string[];
		for (const start of rootSearchStarts) {
			let dir = start;
			for (let i = 0; i < 10; i++) {
				try {
					if (fs.existsSync(path.join(dir, 'Libraries'))) {
						this.projectRootDir = dir;
						break;
					}
				} catch {
					// ignore
				}
				const parent = path.dirname(dir);
				if (parent === dir) {
					break;
				}
				dir = parent;
			}
			if (this.projectRootDir) {
				break;
			}
		}

		// No local DWARF tooling: rely on agent-provided line info (mapToSource) + MemoryMap.

		if (typeof args.stackTraceDepth === 'number' && args.stackTraceDepth > 0) {
			this.stackTraceDepth = args.stackTraceDepth;
		}

		this.tcfLogger.setDebugTCFMessages(Boolean(args.debugTCFMessages || args.internal?.debugTCFMessages));
		this.uiFocusDiagnosticsEnabled = Boolean(args.debugUIFocus || args.internal?.debugUIFocus);
		if (args.internal?.commandToken) {
			(this.tcfClient as any).setCommandToken(args.internal.commandToken);
		}

		if (args.pathMapper && args.pathMapper.trim() !== '') {
			if (this.enabledPathMapper) {
				try {
					const factory = new Function(args.pathMapper);
					const mapper = factory();
					if (typeof mapper === 'function') {
						this.pathMapper = mapper;
					}
				} catch (e) {
					this.tcfLogger.error(`Failed to load pathMapper: ${String(e)}`);
				}
			} else {
				this.tcfLogger.error('Ignoring pathMapper (not enabled / untrusted workspace).');
			}
		}

		if (typeof args.timeout === 'number') {
			this.tcfClient.setCommandTimeout(args.timeout);
		}
		this.tcfLogger.setPrefix('');

		const stopOnEntry = Boolean(args.stopOnEntry);
		if (typeof args.stopStormPauseDelayMs === 'number' && Number.isFinite(args.stopStormPauseDelayMs) && args.stopStormPauseDelayMs >= 0) {
			this.stopStormPauseDelayMs = args.stopStormPauseDelayMs;
		}
		if (typeof args.refocusOnWrongContext === 'boolean') {
			this.refocusOnWrongContext = args.refocusOnWrongContext;
		}
		this.startupDiagnosticsEnabled =
			stopOnEntry ||
			Boolean(args.debugTCFMessages || args.internal?.debugTCFMessages || (args.internal as any)?.debugStartup) ||
			this.uiFocusDiagnosticsEnabled;
		this.startupLog(
			`launch host=${host}:${port} core=${String(args.core)} stopOnEntry=${String(args.stopOnEntry)}(${typeof args.stopOnEntry}) resumeOtherCoresOnEntry=${String(args.resumeOtherCoresOnEntry)} entryFunction=${String(args.entryFunction ?? '')} resetType=${String(this.launchResetType ?? '')} resetSuspend=${String(this.launchResetSuspend)}`
		);
		this.startupLog(`stopStormPauseDelayMs=${this.stopStormPauseDelayMs}`);
		this.startupLog(`refocusOnWrongContext=${String(this.refocusOnWrongContext)}`);
		this.startupLog(`stopStormStackSuppressMs=${this.stopStormStackSuppressMs} (fixed)`);

		try {
			this.startupLog('connecting...');
			await this.tcfClient.connect(host, port);
			this.startupLog('connected');
			await this.initMemoryMap(args);
			this.refreshLiveWatchTimer();
			this.sendResponse(response);
			this.sendEvent(new InitializedEvent());
			await this.startupLogThreads('after InitializedEvent');

			// If the target is already suspended (e.g. agent stops on entry by itself),
			// proactively inform VS Code so the toolbar shows Resume/Step.
			try {
				const initialContext = await this.pickContextIdForCore(args.core);
				this.startupLog(`initial suspend check: context=${String(initialContext ?? '')}`);
				if (initialContext) {
					await this.emitStoppedIfSuspended(initialContext, StoppedEventReason.pause);
				}
			} catch {
				// best-effort only
			}
			if (args.entryFunction && args.stopOnEntry) {
				this.tcfLogger.log('stopOnEntry is true while entryFunction is set; will request a pause after launch so VS Code can show Call Stack/Variables.');
			}

			if (stopOnEntry) {
				try {
					await this.startupLogThreads('before stopOnEntry pause');
					const targetContext = await this.pickContextIdForCore(args.core);
					this.startupLog(
						`stopOnEntry: pause request mode=${args.resumeOtherCoresOnEntry === true ? 'single-core' : 'all-cores'} target=${String(targetContext ?? '')}`
					);
					// Default: stop the whole system and then focus the requested core.
					// This matches typical multi-core "stop at function" behavior.
					if (args.resumeOtherCoresOnEntry === true) {
						await this.tcfClient.pause(targetContext);
					} else {
						// Avoid relying on cached contextInfo/top-level selection; explicitly pause each core.
						await this.pauseAllCoresBestEffort('stopOnEntry');
					}
					await this.startupLogThreads('after stopOnEntry pause');
					if (args.resumeOtherCoresOnEntry === true) {
						// Only one core is expected to be stopped.
						if (targetContext) {
							await this.emitStoppedIfSuspended(targetContext, StoppedEventReason.pause);
							await this.resumeOtherCoresIfNeeded(targetContext, args);
						}
					} else {
						// We paused all cores; ensure VS Code marks all threads as stopped.
						await this.emitStoppedForAllSuspendedAtStartup(targetContext);
					}
					await this.startupLogThreads('after emitStopped/resumeOtherCoresIfNeeded');
				} catch (e) {
					this.tcfLogger.error(`stopOnEntry requested but pause failed: ${String(e)}`);
				}
			}
		} catch (e) {
			this.sendErrorResponse(response, 1, `Could not connect to ${host}:${port}. {message}`, { message: String(e) });
		}
	}

	protected override async disconnectRequestAsync(response: DebugProtocol.DisconnectResponse): Promise<void> {
		this.disconnecting = true;
		this.cancelBreakpointStops('disconnect');
		this.cancelPendingPauseStoppedTimers('disconnect');
		this.pendingStepThreads.clear();
		this.pendingStepOutTargets.clear();
		this.tcfClient.disconnect();
		this.sendResponse(response);
		this.sendEvent(new TerminatedEvent());
	}

	protected override async configurationDoneRequestAsync(response: DebugProtocol.ConfigurationDoneResponse): Promise<void> {
		this.breakpointsManager.setConfigured();
		await this.syncAllBreakpoints();
		this.sendResponse(response);
	}

	protected override async threadsRequestAsync(response: DebugProtocol.ThreadsResponse): Promise<void> {
		const infos = await this.tcfClient.getThreads();
		const threads = infos.map(x => {
			const id = this.getOrAssignThreadId(x.info.ID);
			return new Thread(id, x.info.Name || x.info.ID);
		});
		if (this.startupDiagnosticsEnabled) {
			const list = threads.map(t => `${t.id}:${t.name}`).join(', ');
			this.tcfLogger.log(`[dap] ThreadsResponse threads=${threads.length}${threads.length ? ` ${list}` : ''}`);
		}
		response.body = { threads };
		this.sendResponse(response);
	}

	protected override async stackTraceRequestAsync(response: DebugProtocol.StackTraceResponse, args: DebugProtocol.StackTraceArguments): Promise<void> {
		const contextId = this.threadIdToContext.get(args.threadId);
		if (this.startupDiagnosticsEnabled) {
			this.tcfLogger.log(`[dap] StackTraceRequest threadId=${args.threadId} ctx=${String(contextId ?? '')}`);
		}
		const p = this.primaryBreakpointStop;
		if (p && args.threadId !== p.threadId) {
			// Multi-core UX: previously we returned an empty stack for non-primary threads for a short
			// window after a breakpoint stop (to reduce focus thrash during "stop storms").
			// That can leave other cores' call stacks blank until the user manually refreshes.
			// Instead, just delay responding until the suppression window passes.
			const remainingMs = p.stackSuppressUntilMs - Date.now();
			if (remainingMs > 0) {
				if (this.startupDiagnosticsEnabled) {
					this.tcfLogger.log(
						`[dap] StackTraceDelayed threadId=${args.threadId} ctx=${String(contextId ?? '')} primaryThreadId=${p.threadId} primaryCtx=${p.ctx} delayMs=${remainingMs}`
					);
				}
				await new Promise(resolve => setTimeout(resolve, remainingMs));
			}
		}
		if (!contextId) {
			response.body = { stackFrames: [], totalFrames: 0 };
			this.sendResponse(response);
			return;
		}

		const stack = this.trimPostResetStack(await this.tcfClient.getStackTrace(contextId, NEVER_CANCELLED, this.stackTraceDepth));
		const frames: StackFrame[] = [];
		for (const frame of stack) {
			const frameId = this.createNextStackFrameId(args.threadId, frame.context);
			const mapped = frame.mapToSource;
			const ipNum = typeof frame.context?.IP === 'number' ? frame.context.IP : undefined;
			// Align to instruction boundary (TriCore has 2/4-byte instructions).
			const ipAligned = ipNum !== undefined ? (ipNum - (ipNum % 2)) : undefined;
			const ipRef = ipAligned !== undefined ? `0x${ipAligned.toString(16)}` : undefined;
			if (mapped?.File && mapped?.SLine) {
				const sourcePath = this.resolveMappedSourcePath(mapped);
				this.rememberFrameMeta(frameId, args.threadId, contextId, frame.context?.ID,
					sourcePath ? { path: sourcePath, line: mapped.SLine } : undefined);
				const src = sourcePath ? new Source(path.basename(sourcePath), sourcePath) : undefined;
				const sf = new StackFrame(frameId, frame.context.Name || frame.context.ID, src, mapped.SLine, 1);
				(sf as any).instructionPointerReference = ipRef;
				frames.push(sf);
				continue;
			}

			this.rememberFrameMeta(frameId, args.threadId, contextId, frame.context?.ID);
			const sf = new StackFrame(frameId, frame.context.Name || frame.context.ID);
			(sf as any).instructionPointerReference = ipRef;
			frames.push(sf);
		}

		response.body = { stackFrames: frames, totalFrames: frames.length };
		if (this.startupDiagnosticsEnabled) {
			this.tcfLogger.log(`[dap] StackTraceResponse threadId=${args.threadId} ctx=${contextId} frames=${frames.length}`);
		}
		this.sendResponse(response);
	}

	protected override async scopesRequestAsync(response: DebugProtocol.ScopesResponse, args: DebugProtocol.ScopesArguments): Promise<void> {
		if ('aurixMcp' in args) { await this.inspectionScopes(response, args); return; }
		if (this.startupDiagnosticsEnabled) {
			const resolved = this.tryResolveFrame(args.frameId);
			this.tcfLogger.log(
				`[dap] ScopesRequest frameId=${args.frameId} threadId=${String(resolved.threadId ?? '')} ctx=${String(resolved.ctx ?? '')}`
			);
			this.maybeRefocusToBreakpointThread('ScopesRequest', resolved);
		}
		try {
			response.body = {
				scopes: [
					new Scope('Locals', this.getLocalScopeVariableReference(args.frameId), false),
					// new Scope('Globals', this.getGlobalScopeVariableReference(args.frameId), false),
					new Scope('CORE Registers', this.getRegisterScopeVariableReference(args.frameId), false),
				]
			};
			this.sendResponse(response);
		} catch (e) {
			const msg = e instanceof Error ? e.message : String(e);
			const isStaleRef = msg.startsWith('Unknown stack frame') || msg.startsWith('Unknown object reference');
			if (isStaleRef) {
				if (this.startupDiagnosticsEnabled) {
					this.tcfLogger.log(`[dap] ScopesRequest suppressed: ${msg}`);
				}
				response.body = { scopes: [] };
				this.sendResponse(response);
				return;
			}
			throw e;
		}
	}

	protected override async variablesRequestAsync(response: DebugProtocol.VariablesResponse, args: DebugProtocol.VariablesArguments): Promise<void> {
		if ('aurixMcp' in args) { await this.inspectionVariablePage(response, args); return; }
		if (this.startupDiagnosticsEnabled) {
			let ctx = '';
			try {
				const details = this.getStackFrameDetails(args.variablesReference);
				ctx = details?.[0] ?? '';
			} catch {
				// ignore
			}
			const kind = this.isSubVariableReference(args.variablesReference)
				? 'sub'
				: this.isRegisterScopeVariableReference(args.variablesReference)
					? 'registers'
					: this.isGlobalScopeVariableReference(args.variablesReference)
						? 'globals'
						: this.isLocalScopeVariableReference(args.variablesReference)
							? 'locals'
							: 'unknown';
			const threadId = ctx ? (this.contextToThreadId.get(ctx) ?? this.getOrAssignThreadId(ctx)) : undefined;
			this.tcfLogger.log(
				`[dap] VariablesRequest ref=${args.variablesReference} kind=${kind} threadId=${String(threadId ?? '')} ctx=${String(ctx)}`
			);
			this.maybeRefocusToBreakpointThread('VariablesRequest', { threadId, ctx });
		}
		try {
			if (this.isSubVariableReference(args.variablesReference)) {
				const vars = this.getSubVariable(args.variablesReference);
				const dapVars = await Promise.all(vars.map(v => this.toDAPVariable(v, args.variablesReference)));
				response.body = { variables: dapVars };
				this.sendResponse(response);
				return;
			}

			const [ctx, stack] = this.getStackFrameDetails(args.variablesReference);
			const wantRegisters = this.isRegisterScopeVariableReference(args.variablesReference);
			if (wantRegisters) {
				const rootIds = await this.getRegisterContextChildren(ctx);
				const filteredRootIds = await this.filterRegisterRootIdsToCoreName(ctx, rootIds);
				const regVars = [];
				for (const id of filteredRootIds) {
					regVars.push(await this.registersContextToVariable(id, args.variablesReference));
				}
				const dapVars = await Promise.all(regVars.map(v => this.toDAPVariable(v, args.variablesReference)));
				response.body = { variables: dapVars };
				this.sendResponse(response);
				return;
			}

			const wantGlobals = this.isGlobalScopeVariableReference(args.variablesReference);
			if (wantGlobals) {
				if (this.configuredGlobals.length === 0) {
					response.body = { variables: [] };
					this.sendResponse(response);
					return;
				}

				const globals = [];
				for (const expr of this.configuredGlobals) {
					try {
						// AURIX agent: createInScope can hang; prefer standard Expressions.create.
						const exprId = await this.tcfClient.sendCommand(new CreateExpressionsCommand(ctx, null, expr));
						const v = await this.tcfClient.getExpressionIDVariable(ctx, stack, exprId);
						if (v) {
							globals.push(v);
						}
					} catch (e) {
						this.tcfLogger.error(`Failed to evaluate global '${expr}': ${String(e)}`);
					}
				}
				const dapVars = await Promise.all(globals.map(v => this.toDAPVariable(v, args.variablesReference)));
				response.body = { variables: dapVars };
				this.sendResponse(response);
				return;
			}

			const vars = await this.tcfClient.getStackVariables(ctx, stack);
			const filtered = vars.filter(v => v.isRegister() === false);
			const dapVars = await Promise.all(filtered.map(v => this.toDAPVariable(v, args.variablesReference)));
			response.body = { variables: dapVars };
			this.sendResponse(response);
		} catch (e) {
			const msg = e instanceof Error ? e.message : String(e);
			const isStaleRef =
				msg.startsWith('Unknown object reference') ||
				msg.startsWith('Unknown stack frame') ||
				msg.startsWith('Unknown sub variable reference');
			const isExecutionRunning = (() => {
				const maybe = e as any;
				if (Array.isArray(maybe)) {
					return maybe.some((x) => (x as any)?.Code === 14 || String((x as any)?.Format ?? '').includes('Execution context is running'));
				}
				return maybe?.Code === 14 || String(maybe?.Format ?? '').includes('Execution context is running');
			})();

			// VS Code can issue Variables requests while stepping/resetting, and it can also
			// re-request old references after we invalidated them. These are benign.
			if (isStaleRef || isExecutionRunning) {
				if (this.startupDiagnosticsEnabled) {
					this.tcfLogger.log(`[dap] VariablesRequest suppressed: ${msg}`);
				}
				response.body = { variables: [] };
				this.sendResponse(response);
				return;
			}

			this.sendErrorResponse(response, 0, 'Variables error {message}', { message: msg });
		}
	}

	protected override async evaluateRequestAsync(response: DebugProtocol.EvaluateResponse, args: DebugProtocol.EvaluateArguments): Promise<void> {
		if (this.startupDiagnosticsEnabled) {
			if (typeof args.frameId === 'number') {
				const resolved = this.tryResolveFrame(args.frameId);
				this.tcfLogger.log(
					`[dap] EvaluateRequest frameId=${args.frameId} threadId=${String(resolved.threadId ?? '')} ctx=${String(resolved.ctx ?? '')} expr=${String(args.expression ?? '')}`
				);
				this.maybeRefocusToBreakpointThread('EvaluateRequest', resolved);
			} else {
				this.tcfLogger.log(`[dap] EvaluateRequest frameId=(none) expr=${String(args.expression ?? '')}`);
			}
		}
		try {
			if (typeof args.expression !== 'string' || args.expression.trim() === '') {
				response.body = { result: '', variablesReference: 0 };
				this.sendResponse(response);
				return;
			}

			const expressionText = args.expression.trim();
			const isWatchRequest = args.context === 'watch';
			const liveRefreshable = this.isLiveWatchRefreshableExpression(expressionText);

			let ctx: string | undefined;
			let stack: string | undefined;
			let parentRef: number | undefined;
			let createParentContext: string | undefined;
			if (isWatchRequest && this.liveWatchEnabled && liveRefreshable) {
				ctx = await this.pickContextIdForRunningWatch();
				if (ctx) {
					parentRef = 0;
					createParentContext = ctx;
				}
			}
			if (!createParentContext && typeof args.frameId === 'number') {
				parentRef = this.getLocalScopeVariableReference(args.frameId);
				[ctx, stack] = this.getStackFrameDetails(parentRef);
				createParentContext = stack;
			} else if (!createParentContext) {
				// Watch / REPL sometimes evaluate without a frameId.
				parentRef = 0;
				if (!createParentContext) {
					ctx = await this.pickAnySuspendedContextId();
					if (ctx) {
						const stacks = (await this.tcfClient.sendCommand(new GetChildrenStackTraceCommand(ctx))) || [];
						stack = stacks.length > 0 ? stacks[stacks.length - 1] : undefined;
						createParentContext = stack;
					}
				}
			}

			if (!ctx || !createParentContext) {
				if (this.tryRespondWithCachedWatchValue(response, expressionText, isWatchRequest)) {
					return;
				}
				response.body = { result: '', variablesReference: 0 };
				this.sendResponse(response);
				return;
			}

			// AURIX agent: createInScope can hang; prefer standard Expressions.create.
			const exprId = await this.tcfClient.sendCommand(new CreateExpressionsCommand(createParentContext, null, expressionText));
			const v = await this.tcfClient.getExpressionIDVariable(ctx, stack ?? createParentContext, exprId, expressionText);

			if (!v) {
				// Non-displayable symbols are an inline evaluation failure, not a session fault.
				this.sendErrorResponse(response, {
					id: 0, format: 'Evaluate error {message}',
					variables: { message: `Cannot display expression '${expressionText}': unsupported value type` },
					showUser: false,
				});
				return;
			}

			let variablesReference = 0;
			try {
				const children = await v.getChildren?.();
				if (children && children.length > 0) {
					variablesReference = parentRef ? this.createSubVariableReference(parentRef, children) : 0;
				}
			} catch {
				// ignore child errors
			}

			const result = await v.displayValue();
			if (result === undefined) {
				throw new Error(`Cannot display expression '${expressionText}': value decoding failed`);
			}
			response.body = {
				result,
				variablesReference,
			};
			if (isWatchRequest) {
				this.watchExpressionStates.set(expressionText, {
					result: response.body.result,
					liveRefreshable,
				});
				this.refreshLiveWatchTimer();
			}
			this.sendResponse(response);
		} catch (e) {
			const msg = e instanceof Error ? e.message : String(e);
			const isStaleRef = msg.startsWith('Unknown stack frame') || msg.startsWith('Unknown object reference');
			const isExecutionRunning = (() => {
				const maybe = e as any;
				if (Array.isArray(maybe)) {
					return maybe.some((x) => (x as any)?.Code === 14 || String((x as any)?.Format ?? '').includes('Execution context is running'));
				}
				return maybe?.Code === 14 || String(maybe?.Format ?? '').includes('Execution context is running');
			})();

			// VS Code may ask for evaluation during stepping/reset/continue and may reuse old frameIds.
			// Treat these as benign UI refresh artifacts.
			if (isStaleRef || isExecutionRunning) {
				if (this.startupDiagnosticsEnabled) {
					this.tcfLogger.log(`[dap] EvaluateRequest suppressed: ${msg}`);
				}
				if (typeof args.expression === 'string' && this.tryRespondWithCachedWatchValue(response, args.expression.trim(), args.context === 'watch')) {
					return;
				}
				response.body = { result: '', variablesReference: 0 };
				this.sendResponse(response);
				return;
			}

			this.sendErrorResponse(response, 0, 'Evaluate error {message}', { message: msg });
		}
	}

	private async pickAnySuspendedContextId(): Promise<string | undefined> {
		const known = Array.from(this.suspendedContextIds.values());
		if (known.length > 0) {
			return known[0];
		}
		try {
			const infos = await this.tcfClient.getThreads();
			const suspended = infos.find(t => Boolean(t.state?.suspended));
			return suspended?.info.ID;
		} catch {
			return undefined;
		}
	}

	private normalizeLiveWatchIntervalMs(value: unknown): number {
		const numeric = typeof value === 'number' ? value : Number(value);
		if (!Number.isFinite(numeric)) {
			return 1000;
		}
		return Math.min(10_000, Math.max(200, Math.round(numeric)));
	}

	private isLiveWatchRefreshableExpression(expressionText: string): boolean {
		return /^[A-Za-z_][A-Za-z0-9_]*(?:(?:\.[A-Za-z_][A-Za-z0-9_]*)|(?:\[[0-9]+\]))*$/.test(expressionText);
	}

	private tryRespondWithCachedWatchValue(response: DebugProtocol.EvaluateResponse, expressionText: string, isWatchRequest: boolean): boolean {
		if (!isWatchRequest) {
			return false;
		}
		const cached = this.watchExpressionStates.get(expressionText);
		if (!cached) {
			return false;
		}
		response.body = { result: cached.result, variablesReference: 0 };
		this.sendResponse(response);
		return true;
	}

	private async pickContextIdForRunningWatch(): Promise<string | undefined> {
		const infos = await this.tcfClient.getThreads();
		const running = infos.filter(t => !t.state?.suspended);
		if (running.length === 0) {
			return undefined;
		}
		if (this.launchCore !== undefined) {
			const idRe = new RegExp(`(?:^|\\.)C${this.launchCore}(?:$|\\b)`, 'i');
			const nameRe = new RegExp(`\\bcore\\s*${this.launchCore}\\b|\\bC${this.launchCore}\\b`, 'i');
			const preferred = running.find(t => idRe.test(t.info.ID) || (t.info.Name ? nameRe.test(t.info.Name) : false));
			if (preferred) {
				return preferred.info.ID;
			}
		}
		return running[0].info.ID;
	}

	private refreshLiveWatchTimer(): void {
		if (this.liveWatchTimer) {
			clearInterval(this.liveWatchTimer);
			this.liveWatchTimer = undefined;
		}
	}

	private async onLiveWatchTimerTick(): Promise<void> {
		return;
	}

	private setLiveWatchState(enabled: boolean, intervalMs?: number): void {
		this.liveWatchEnabled = enabled;
		if (intervalMs !== undefined) {
			this.liveWatchIntervalMs = this.normalizeLiveWatchIntervalMs(intervalMs);
		}
		this.refreshLiveWatchTimer();
	}

	private async evaluateGlobalExpressionValue(expressionText: string): Promise<string | undefined> {
		const runningCtx = await this.pickContextIdForRunningWatch();
		const ctx = runningCtx
			?? (Date.now() < this.liveWatchSuspendFallbackBlockedUntilMs ? undefined : await this.pickAnySuspendedContextId());
		if (!ctx) {
			return undefined;
		}
		const exprId = await this.tcfClient.sendCommand(new CreateExpressionsCommand(ctx, null, expressionText));
		const v = await this.tcfClient.getExpressionIDVariable(ctx, ctx, exprId, expressionText);
		if (!v) {
			return undefined;
		}
		return (await v.displayValue?.()) ?? '';
	}


	protected override async continueRequestAsync(response: DebugProtocol.ContinueResponse, args: DebugProtocol.ContinueArguments): Promise<void> {
		this.cancelBreakpointStops('continue');
		this.pendingStepThreads.delete(args.threadId);
		this.pendingStepOutTargets.delete(args.threadId);
		const contextId = this.threadIdToContext.get(args.threadId);
		await this.tcfClient.continue(contextId);
		this.sendResponse(response);
	}

	protected override async nextRequestAsync(response: DebugProtocol.NextResponse, args: DebugProtocol.NextArguments): Promise<void> {
		this.cancelBreakpointStops('next');
		this.pendingStepOutTargets.delete(args.threadId);
		const contextId = this.threadIdToContext.get(args.threadId);
		this.pendingStepThreads.add(args.threadId);
		if (this.instructionSteppingEnabled) {
			await this.tcfClient.nextInstruction(contextId);
		} else {
			await this.tcfClient.next(contextId);
		}
		this.sendResponse(response);
	}

	private findExecutableRangeForAddress(addr: number): { start: number; end: number } | undefined {
		if (this.execRanges.length === 0) {
			return undefined;
		}
		for (const r of this.execRanges) {
			if (addr >= r.start && addr < r.end) {
				return r;
			}
		}
		return undefined;
	}

	private loadExecutableRangesFromElf(elfPath: string): Array<{ start: number; end: number }> {
		return elfLoadRanges(fs.readFileSync(elfPath), 1);
	}

	protected override async stepInRequestAsync(response: DebugProtocol.StepInResponse, args: DebugProtocol.StepInArguments): Promise<void> {
		this.cancelBreakpointStops('stepIn');
		this.pendingStepOutTargets.delete(args.threadId);
		const contextId = this.threadIdToContext.get(args.threadId);
		this.pendingStepThreads.add(args.threadId);
		try {
			if (this.instructionSteppingEnabled) {
				await this.tcfClient.stepInInstruction(contextId);
			} else {
				await this.tcfClient.stepIn(contextId);
			}
		} catch (error) {
			this.pendingStepThreads.delete(args.threadId);
			throw error;
		}
		this.sendResponse(response);
	}

	protected override async stepOutRequestAsync(response: DebugProtocol.StepOutResponse, args: DebugProtocol.StepOutArguments): Promise<void> {
		this.cancelBreakpointStops('stepOut');
		const contextId = this.threadIdToContext.get(args.threadId);
		if (!contextId) {
			throw new Error(`Cannot step out: unknown thread ${args.threadId}`);
		}
		this.pendingStepThreads.delete(args.threadId);
		this.pendingStepOutTargets.delete(args.threadId);
		const stack = await this.tcfClient.getStackTrace(contextId, NEVER_CANCELLED);
		const returnAddress = stack[1]?.context.IP;
		if (typeof returnAddress === 'number' && Number.isSafeInteger(returnAddress) && returnAddress >= 0) {
			const breakpointRevision = this.breakpointRevision;
			const breakpoints = [...this.breakpointsManager.getAll(), ...this.instructionBreakpointsManager.getAll()];
			try {
				const breakpointStatuses = await Promise.all(breakpoints.map(breakpoint =>
					this.tcfClient.sendCommand(new GetStatusBreakpointsCommand(this.breakpointIdToTcfId(breakpoint.id)))));
				this.pendingStepOutTargets.set(args.threadId, { returnAddress, breakpointStatuses, breakpointRevision });
			} catch (error) {
				this.tcfLogger.error(`Cannot verify Step Out user breakpoints; preserving agent stop reason: ${String(error)}`);
			}
		} else {
			this.tcfLogger.log('Step Out caller address unavailable; preserving agent stop reason.');
		}
		this.pendingStepThreads.add(args.threadId);
		// No instruction-level "step out" in TCF; keep semantic step-out.
		try {
			await this.tcfClient.stepOut(contextId);
		} catch (error) {
			this.pendingStepThreads.delete(args.threadId);
			this.pendingStepOutTargets.delete(args.threadId);
			throw error;
		}
		this.sendResponse(response);
	}

	protected override async pauseRequestAsync(response: DebugProtocol.PauseResponse, args: DebugProtocol.PauseArguments): Promise<void> {
		this.pendingStepThreads.clear();
		this.pendingStepOutTargets.clear();
		const contextId = this.threadIdToContext.get(args.threadId);
		// Even when VS Code sends Pause for a specific thread, users expect "pause" to stop the whole
		// multi-core system. Explicitly suspend all core contexts and then emit stopped events.
		await this.pauseAllCoresBestEffort('pauseRequestAsync');
		const threads = await this.tcfClient.getThreads(true);
		const running = threads.filter(thread => !thread.state.suspended);
		if (threads.length === 0 || running.length > 0) {
			throw new Error(`Pause did not halt all cores: ${running.map(thread => thread.info.ID).join(', ') || 'no execution contexts'}`);
		}
		await this.emitStoppedForAllSuspendedAtStartup(contextId, { targetReason: StoppedEventReason.pause, otherReason: StoppedEventReason.pause });
		this.sendResponse(response);
	}

	protected override async setBreakPointsRequestAsync(response: DebugProtocol.SetBreakpointsResponse, args: DebugProtocol.SetBreakpointsArguments): Promise<void> {
		// Breakpoint flow (VS Code -> DAP - > TCF):
		// 1) VS Code sends SetBreakpointsRequest with file + lines.
		// 2) Update local state (add/remove as needed) and assign IDs.
		// 3) If already configured, sync all breakpoints to TCF agent.
		// 4) Respond to VS Code with the actual breakpoint states so UI updates.
		const file = args.source.path || '';
		const lines = (args.breakpoints || []).map(b => b.line);
		const tuples = this.breakpointsManager.updateFile(file, lines);

		if (this.breakpointsManager.configured) {
			await this.syncAllBreakpoints();
		}

		const bps = tuples.map(t => {
			const bp = new Breakpoint(t.verified, t.line);
			(bp as any).id = t.id;
			return bp;
		});
		response.body = { breakpoints: bps };
		this.sendResponse(response);
	}

	protected override async setInstructionBreakpointsRequestAsync(
		response: DebugProtocol.SetInstructionBreakpointsResponse,
		args: DebugProtocol.SetInstructionBreakpointsArguments
	): Promise<void> {
		const requestAddrs: Array<number | undefined> = [];
		const addrs: number[] = [];

		for (const bp of args.breakpoints || []) {
			const base = this.parseMemoryReference(bp.instructionReference);
			if (base === undefined) {
				requestAddrs.push(undefined);
				continue;
			}
			const offset = typeof bp.offset === 'number' ? bp.offset : 0;
			const addr = base + offset;
			requestAddrs.push(addr);
			addrs.push(addr);
		}

		if (this.startupDiagnosticsEnabled) {
			const refs = requestAddrs.map(addr => (addr === undefined ? 'invalid' : `0x${addr.toString(16)}`));
			this.tcfLogger.log(`[dap] SetInstructionBreakpointsRequest count=${requestAddrs.length} addrs=${refs.join(', ')}`);
		}

		const tuples = this.instructionBreakpointsManager.updateAddresses(addrs, () => this.breakpointsManager.allocateId());
		if (this.breakpointsManager.configured) {
			await this.syncAllBreakpoints();
		}

		const byAddr = new Map<number, InstructionBreakpointTuple>();
		for (const t of tuples) {
			byAddr.set(t.address, t);
		}

		const bps = requestAddrs.map((addr) => {
			if (addr === undefined) {
				const bp = new Breakpoint(false, 0);
				(bp as any).message = 'Invalid instructionReference';
				return bp;
			}
			const t = byAddr.get(addr);
			const bp = new Breakpoint(t?.verified ?? false, 0);
			if (t) {
				(bp as any).id = t.id;
			}
			(bp as any).instructionReference = `0x${addr.toString(16)}`;
			return bp;
		});

		response.body = { breakpoints: bps };
		this.sendResponse(response);
	}

	private breakpointIdToTcfId(id: number): string {
		return `${this.breakpointPrefix}${id}`;
	}

	private breakpointTcfIdToId(tcfId: string): number {
		if (!tcfId.startsWith(this.breakpointPrefix)) {
			return BREAKPOINT_INVALID;
		}
		const num = Number(tcfId.substring(this.breakpointPrefix.length));
		return Number.isFinite(num) ? num : BREAKPOINT_INVALID;
	}

	private async syncAllBreakpoints(): Promise<void> {
		this.breakpointRevision++;
		const all = this.breakpointsManager.getAll();
		const data: BreakpointData[] = all.map(b => ({
			ID: this.breakpointIdToTcfId(b.id),
			Enabled: true,
			File: this.convertClientPathToDebugger(b.file),
			Line: b.line,
		}));
		const instr = this.instructionBreakpointsManager.getAll();
		let instrContextIds: string[] | undefined;
		if (instr.length > 0) {
			try {
				const target = (await this.pickContextIdForCore(this.launchCore)) ?? (await this.pickAnySuspendedContextId());
				if (target) {
					instrContextIds = [target];
				} else {
					const infos = await this.tcfClient.getThreads();
					instrContextIds = infos
						.filter(t => Boolean(t.info?.CanSuspend))
						.map(t => t.info.ID);
				}
				if (this.startupDiagnosticsEnabled) {
					this.tcfLogger.log(
						`[breakpoints] instr ContextIds=${instrContextIds.length ? instrContextIds.join(', ') : '(none)'}`
					);
				}
			} catch (e) {
				if (this.startupDiagnosticsEnabled) {
					this.tcfLogger.log(`[breakpoints] instr ContextIds query failed: ${String(e)}`);
				}
			}
		}
		if (this.startupDiagnosticsEnabled) {
			const addrStrings = instr.map(b => `0x${b.address.toString(16)}`);
			const maxShow = 16;
			const shown = addrStrings.slice(0, maxShow);
			const suffix = addrStrings.length > maxShow ? ` ...+${addrStrings.length - maxShow}` : '';
			this.tcfLogger.log(
				`[breakpoints] syncAllBreakpoints files=${all.length} instr=${instr.length} instrAddrs=${shown.join(', ')}${suffix}`
			);
		}
		for (const b of instr) {
			const location = `0x${b.address.toString(16)}`;
			data.push({
				ID: this.breakpointIdToTcfId(b.id),
				Enabled: true,
				Address: location,
				Location: location,
				BreakpointType: BreakpointType.Hardware,
				ContextIds: instrContextIds && instrContextIds.length > 0 ? instrContextIds : undefined,
			});
		}
		await this.tcfClient.setBreakpointsList(data);
	}

	private async toDAPVariable(v: any, parentRef: number): Promise<DebugProtocol.Variable> {
		const name = v.name?.() ?? '<unnamed>';
		const value = (await v.displayValue?.()) ?? '';
		let variablesReference = 0;
		try {
			const children = await v.getChildren?.();
			if (children && children.length > 0) {
				variablesReference = this.createSubVariableReference(parentRef, children);
			}
		} catch (error) {
			this.tcfLogger.error(`Cannot expand variable '${name}': ${String(error)}`);
		}
		return new Variable(name, value, variablesReference);
	}

	private onBreakpointHit(tcfId: string, status: InstanceStatusData[]) {
		const id = this.breakpointTcfIdToId(tcfId);
		if (id === BREAKPOINT_INVALID) {
			return;
		}
		const contexts = status.map(s => s.LocationContext).filter((c): c is string => Boolean(c));
		if (contexts.length === 0) {
			return;
		}

		const contextId = contexts[0];
		if (this.pendingBreakpointStoppedTimers.has(contextId) || this.breakpointStops.has(contextId)) {
			return;
		}
		this.cancelPendingPauseStoppedTimers('breakpointHit');
		this.suppressPauseStoppedUntilMs = Date.now() + Math.max(150, this.stopStormPauseDelayMs * 4);

		const timer = setTimeout(() => {
			this.pendingBreakpointStoppedTimers.delete(contextId);
			const threadId = this.getOrAssignThreadId(contextId);
			this.pendingStepThreads.delete(threadId);
			this.pendingStepOutTargets.delete(threadId);
			this.onThreadSuspended(threadId);
			this.notifyBreakpointStopped(contextId);
		}, this.breakpointStopDelayMs);
		this.pendingBreakpointStoppedTimers.set(contextId, timer);
	}

	private onBreakpointRemoved(tcfIds: string[]) {
		this.breakpointRevision++;
		for (const tcfId of tcfIds) {
			const id = this.breakpointTcfIdToId(tcfId);
			if (id === BREAKPOINT_INVALID) {
				continue;
			}
			this.breakpointsManager.deleteById(id);
			this.instructionBreakpointsManager.deleteById(id);
			this.sendEvent(new BreakpointEvent(BreakpointEventReason.removed, { id, verified: false }));
		}
	}

	private onBreakpointAddedOrChanged(tcfIds: string[]) {
		for (const tcfId of tcfIds) {
			const id = this.breakpointTcfIdToId(tcfId);
			if (id === BREAKPOINT_INVALID) {
				continue;
			}
			this.breakpointRevision++;
			this.breakpointsManager.setVerified(id, true);
			this.instructionBreakpointsManager.setVerified(id, true);
			this.sendEvent(new BreakpointEvent(BreakpointEventReason.changed, { id, verified: true }));
		}
	}

	protected onContextSuspended(info: ContextSuspendedData) {
		// Ignore duplicate suspend events for the same context.
		const contextId = info.id;
		if (this.suspendedContextIds.has(contextId)) {
			return;
		}
		this.suspendedContextIds.add(contextId);
		const threadId = this.getOrAssignThreadId(contextId);
		this.onThreadSuspended(threadId);

		const reasonText = (info.reason || '').toLowerCase();
		const pendingStep = this.pendingStepThreads.delete(threadId);
		const stepOutTarget = this.pendingStepOutTargets.get(threadId);
		this.pendingStepOutTargets.delete(threadId);
		let reason = reasonText.includes('breakpoint') ? StoppedEventReason.breakpoint : StoppedEventReason.pause;
		if (reason === StoppedEventReason.breakpoint && pendingStep &&
			stepOutTarget?.breakpointRevision === this.breakpointRevision &&
			!this.pendingBreakpointStoppedTimers.has(contextId) &&
			isStepOutReturnStop(info, stepOutTarget)) {
			reason = StoppedEventReason.step;
		}
		if (stepOutTarget && reasonText.includes('breakpoint')) {
			this.tcfLogger.log(`[stepOut] return=0x${stepOutTarget.returnAddress.toString(16)} pc=0x${info.pc.toString(16)} mappedReason=${reason}; user breakpoint evidence takes precedence`);
		}
		if (reason !== StoppedEventReason.breakpoint) {
			if (pendingStep || reasonText.includes('step')) {
				reason = StoppedEventReason.step;
			}
		}
		if (this.startupDiagnosticsEnabled) {
			this.tcfLogger.log(`[runcontrol] suspended id=${contextId} reason=${String(info.reason ?? '')}`);
		}
		if (reason === StoppedEventReason.breakpoint) {
			this.cancelPendingBreakpointStoppedTimer(contextId, 'runcontrolBreakpoint');
		}
		if (this.startupDiagnosticsEnabled && reason === StoppedEventReason.breakpoint) {
			const instr = this.instructionBreakpointsManager.getAll();
			if (instr.length > 0) {
				const pc = info.pc;
				const bpIds = Array.isArray(info.data?.BPs) ? info.data?.BPs : [];
				if (bpIds.length > 0) {
					const details = bpIds.map((tcfId) => {
						const id = this.breakpointTcfIdToId(tcfId);
						if (id === BREAKPOINT_INVALID) {
							return `${tcfId}(unknown)`;
						}
						const instrBp = this.instructionBreakpointsManager.getById(id);
						if (instrBp) {
							return `${tcfId}=instr@0x${instrBp.address.toString(16)}`;
						}
						const srcBp = this.breakpointsManager.getById(id);
						if (srcBp) {
							const file = srcBp.file ? srcBp.file.split(/[\\/]/).pop() : '';
							return `${tcfId}=src ${file}:${srcBp.line}`;
						}
						return `${tcfId}=untracked`;
					});
					this.tcfLogger.log(`[breakpoints] stop bps=${details.join(', ')}`);
				} else {
					this.tcfLogger.log(`[breakpoints] stop bps=(none) data=${JSON.stringify(info.data ?? {})}`);
				}
				let match: InstructionBreakpointTuple | undefined;
				let nearest: InstructionBreakpointTuple | undefined;
				let nearestDelta = Number.POSITIVE_INFINITY;
				for (const b of instr) {
					if (b.address === pc) {
						match = b;
						break;
					}
					const delta = Math.abs(b.address - pc);
					if (delta < nearestDelta) {
						nearestDelta = delta;
						nearest = b;
					}
				}
				const matchText = match ? `id=${match.id}` : 'none';
				const nearestText = nearest ? `0x${nearest.address.toString(16)} (id=${nearest.id}, delta=${nearestDelta})` : 'none';
				this.tcfLogger.log(`[breakpoints] stop pc=0x${pc.toString(16)} instrMatch=${matchText} nearest=${nearestText}`);
			}
		}
		if (reason === StoppedEventReason.breakpoint) {
			this.refreshLiveWatchTimer();
			this.cancelPendingPauseStoppedTimers('runcontrolBreakpoint');
			this.suppressPauseStoppedUntilMs = Date.now() + Math.max(150, this.stopStormPauseDelayMs * 4);
			this.notifyBreakpointStopped(contextId);
			return;
		}

		// Step is an explicit user action; don't delay or suppress it.
		if (reason === StoppedEventReason.step) {
			this.refreshLiveWatchTimer();
			this.sendStoppedEvent(reason, threadId);
			return;
		}

		// Delay pause-type stops slightly. This helps ensure a breakpoint stop becomes the primary
		// UI context when multiple cores suspend nearly simultaneously.
		if (this.breakpointStops.waiting || Date.now() < this.suppressPauseStoppedUntilMs) {
			this.focusLog(`suppress pause StoppedEvent for ${contextId} (threadId=${threadId})`);
			return;
		}
		if (this.stopStormPauseDelayMs > 0) {
			if (this.pendingPauseStoppedTimers.has(contextId)) {
				return;
			}
			const timer = setTimeout(() => {
				this.pendingPauseStoppedTimers.delete(contextId);
				if (!this.suspendedContextIds.has(contextId)) {
					return;
				}
				if (this.breakpointStops.waiting || Date.now() < this.suppressPauseStoppedUntilMs) {
					return;
				}
				this.sendStoppedEvent(StoppedEventReason.pause, threadId, { preserveFocusHint: true });
			}, this.stopStormPauseDelayMs);
			this.pendingPauseStoppedTimers.set(contextId, timer);
			return;
		}

		this.sendStoppedEvent(reason, threadId, { preserveFocusHint: true });
		this.refreshLiveWatchTimer();
	}

	private onContextResumed(contextId: string) {
		this.cancelBreakpointStops('contextResumed');
		this.suspendedContextIds.delete(contextId);
		const threadId = this.getOrAssignThreadId(contextId);
		this.onThreadResumed(threadId);
		// Important for multi-core: do NOT let VS Code assume all threads continued.
		this.sendEvent(new ContinuedEvent(threadId, false));
		if (this.startupDiagnosticsEnabled) {
			this.tcfLogger.log(`[dap] ContinuedEvent threadId=${threadId} ctx=${contextId} allThreadsContinued=false`);
		}
		if (this.startupDiagnosticsEnabled) {
			this.tcfLogger.log(`[runcontrol] resumed id=${contextId} threadId=${threadId}`);
		}
		this.refreshLiveWatchTimer();
	}

	protected override async customRequestAsync(command: string, response: DebugProtocol.Response, args: any, request?: DebugProtocol.Request): Promise<void> {
		if (command === 'aurix-tcf/mcpGlobals') {
			const input = globalLookupSchema.extend({ aurixMcp: inspectionOptionsSchema }).strict().parse(args);
			const { contextId, check } = await this.inspectionContext(input.aurixMcp);
			if (!this.programPath) { throw new Error('Global inspection requires a selected ELF with debug symbols.'); }
			const inspector = new GlobalVariableInspector(command => this.tcfClient.sendCommand(command), this.programPath);
			const selections = await inspector.lookup(contextId, { name: input.name, source: input.source }, check);
			await this.inspectionContext(input.aurixMcp);
			check();
			if (this.inspectionGlobals.size + selections.filter(selection => selection.metadata.readable).length > 4096) {
				throw new Error('MCP global symbol reference limit reached; execution invalidates old references.');
			}
			response.body = { name: input.name, source: input.source, elfSha256: inspector.elfSha256,
				symbols: selections.map(selection => {
					const reference = selection.metadata.readable ? ++this.inspectionReference : 0;
					if (reference) { this.inspectionGlobals.set(reference, selection); }
					return { ...selection.metadata, reference };
				}) };
			this.sendResponse(response);
			return;
		}
		if (command === 'aurix-tcf/mcpReadGlobal') {
			const input = z.object({ reference: z.number().int().positive(), aurixMcp: inspectionOptionsSchema }).strict().parse(args);
			const { contextId, check } = await this.inspectionContext(input.aurixMcp);
			const selection = this.inspectionGlobals.get(input.reference);
			if (!selection || selection.contextId !== contextId) { throw new Error('Unknown, cross-core or stale MCP global symbol reference.'); }
			if (!this.programPath) { throw new Error('Global inspection requires a selected ELF.'); }
			const inspector = new GlobalVariableInspector(command => this.tcfClient.sendCommand(command), this.programPath);
			const result = await inspector.read(selection, check);
			await this.inspectionContext(input.aurixMcp);
			check();
			const variablesReference = result.variable.expandable ? this.storeInspectionVariable({ contextId, variable: result.variable }) : 0;
			response.body = { elfSha256: inspector.elfSha256, variable: { ...result.value, variablesReference } };
			this.sendResponse(response);
			return;
		}
		if (command === 'aurix-tcf/mcpRevokePeripheralWrite') {
			const { token } = z.object({ token: z.string().uuid() }).strict().parse(args);
			const ticket = this.peripheralWriteTickets.get(token);
			if (ticket) { ticket.cancelled = true; this.peripheralWriteTickets.delete(token); }
			response.body = { revoked: ticket !== undefined };
			this.sendResponse(response);
			return;
		}
		if (command === 'aurix-tcf/mcpPreparePeripheralWrite') {
			const input = z.object({ registerId: z.string(), value: z.string().max(128), aurixMcp: inspectionOptionsSchema }).strict().parse(args);
			if (this.mcpPeripheralMode !== 'full' || !this.nativePeripherals) { throw new Error('Full-SVD MCP peripheral writes are unavailable for this session.'); }
			const { contextId, check } = await this.inspectionContext(input.aurixMcp);
			const plan = await this.nativePeripherals.prepareWrite(contextId, input.registerId, input.value, check);
			await this.inspectionContext(input.aurixMcp);
			for (const [key, ticket] of this.peripheralWriteTickets) {
				if (ticket.expiresAt <= Date.now()) { ticket.cancelled = true; this.peripheralWriteTickets.delete(key); }
			}
			if (this.peripheralWriteTickets.size >= 16) { throw new Error('Too many pending peripheral write confirmations.'); }
			const token = randomUUID(), expiresAt = Date.now() + 120000;
			this.peripheralWriteTickets.set(token, { plan, access: this.nativePeripherals, threadId: input.aurixMcp.threadId,
				epoch: input.aurixMcp.epoch, expiresAt, consumed: false, cancelled: false });
			response.body = { token, id: plan.id, name: plan.name, address: plan.address, size: plan.size, valueHex: plan.valueHex,
				threadId: input.aurixMcp.threadId, contextId, epoch: input.aurixMcp.epoch, expiresAt };
			this.sendResponse(response);
			return;
		}
		if (command === 'aurix-tcf/mcpCommitPeripheralWrite') {
			const input = z.object({ token: z.string().uuid(), aurixMcp: inspectionOptionsSchema }).strict().parse(args);
			const ticket = this.peripheralWriteTickets.get(input.token);
			if (!ticket || ticket.consumed) { throw new Error('Peripheral write confirmation is unknown, expired or already consumed.'); }
			ticket.consumed = true;
			let reserved = false;
			try {
				if (this.mcpPeripheralMode !== 'full' || this.nativePeripherals !== ticket.access || ticket.cancelled ||
					ticket.epoch !== input.aurixMcp.epoch || ticket.threadId !== input.aurixMcp.threadId || Date.now() >= ticket.expiresAt) {
					throw new Error('Peripheral write confirmation no longer matches this session/state.');
				}
				if (this.peripheralWritesInFlight) { throw new Error('Another peripheral write is in progress.'); }
				this.peripheralWritesInFlight++;
				reserved = true;
				const { contextId, check } = await this.inspectionContext(input.aurixMcp, true);
				if (contextId !== ticket.plan.contextId) { throw new Error('Peripheral write core changed after confirmation.'); }
				const guard = () => {
					check();
					if (ticket.cancelled || Date.now() >= ticket.expiresAt) { throw new Error('Peripheral write confirmation was cancelled or expired.'); }
				};
				await ticket.access.commitWrite(ticket.plan, guard);
			} finally {
				this.peripheralWriteTickets.delete(input.token);
				if (reserved) { this.peripheralWritesInFlight--; this.invalidateInspection('MCP peripheral write'); }
			}
			response.body = { id: ticket.plan.id, name: ticket.plan.name, address: ticket.plan.address, size: ticket.plan.size,
				valueHex: ticket.plan.valueHex, evidence: 'Registers.set', writes: 1, readBackPerformed: false, inspectionEpoch: this.inspectionEpoch };
			this.sendResponse(response);
			return;
		}
		if (command === 'aurix-tcf/mcpReadMemory') {
			const input = memoryReadSchema.extend({ aurixMcp: inspectionOptionsSchema }).parse(args);
			const { contextId, check } = await this.inspectionContext(input.aurixMcp);
			if (!this.programPath) { throw new Error('No ELF was selected for bounded memory inspection.'); }
			this.inspectionMemoryRanges ??= readableElfRanges(this.programPath);
			response.body = await readInspectedMemory(command => this.tcfClient.sendCommand(command), contextId,
				this.inspectionMemoryRanges, { address: input.address, count: input.count }, check);
			await this.inspectionContext(input.aurixMcp);
			check();
			this.sendResponse(response);
			return;
		}
		if (command === 'aurix-tcf/mcpPeripherals') {
			const input = peripheralPageSchema.extend({
				aurixMcp: inspectionOptionsSchema,
				registerIds: z.array(z.string().min(1).max(4096)).min(1).max(32).optional(),
			}).strict().parse(args);
			const { contextId, check } = await this.inspectionContext(input.aurixMcp);
			const reader = await this.peripheralReader();
			response.body = input.registerIds ? { registers: await reader.read(contextId, input.registerIds, check) }
				: reader.catalog({ start: input.start, count: input.count, filter: input.filter, exactNames: input.exactNames }, check);
			await this.inspectionContext(input.aurixMcp);
			check();
			this.sendResponse(response);
			return;
		}
		if (command === 'aurix-tcf/mcpState') {
			const threads = await this.tcfClient.getThreads(true);
			response.body = {
				instructionStepping: this.instructionSteppingEnabled,
				inspectionEpoch: this.inspectionEpoch,
				threads: threads.map(thread => {
					const pc = thread.state.data?.PCError ? undefined : targetAddress(thread.state.pc);
					return {
						id: this.getOrAssignThreadId(thread.info.ID),
						name: thread.info.Name || thread.info.ID,
						contextId: thread.info.ID,
						suspended: thread.state.suspended,
						...(thread.state.suspended ? { stop: {
							evidence: 'RunControl.getState', reason: thread.state.lastStateReason ?? null,
							instructionPointerReference: pc === undefined ? null : `0x${pc.toString(16)}`,
							...(pc === undefined ? { pcUnavailable: 'Agent PC is missing, invalid, or reported with PCError.' } : {}),
							breakpointIds: thread.state.data?.BPs,
						} } : {}),
					};
				}),
			};
			this.sendResponse(response);
			return;
		}
		if (command === 'aurix-tcf/mcpBreakpointStatus') {
			const request = z.object({
				source: z.string().min(1).max(4096), line: z.number().int().positive(),
				expiresAt: z.number().int().positive(),
			}).strict().parse(args);
			const key = (source: string) => process.platform === 'win32' ? path.normalize(source).toLowerCase() : path.normalize(source);
			const matches = this.breakpointsManager.getAll().filter(bp => key(bp.file) === key(request.source) && bp.line === request.line);
			if (matches.length !== 1) { throw new Error('Source breakpoint is absent or ambiguous in this adapter; no native ID was guessed.'); }
			const revision = this.breakpointRevision;
			const epoch = this.inspectionEpoch;
			const check = () => {
				if (revision !== this.breakpointRevision || epoch !== this.inspectionEpoch) {
					throw new Error('Breakpoint or execution state changed during evidence lookup; discard this result.');
				}
				if (Date.now() >= request.expiresAt || request.expiresAt > Date.now() + 15000) {
					throw new Error('Breakpoint evidence deadline expired or invalid.');
				}
			};
			const reader = new BreakpointInspector(c => this.tcfClient.sendCommand(c), area => this.resolveMappedSourcePath(area));
			response.body = await reader.read(this.breakpointIdToTcfId(matches[0].id), check);
			check();
			this.sendResponse(response);
			return;
		}
		if (command === 'aurix-tcf/mcpRegisters') {
			const request = z.object({
				aurixMcp: inspectionOptionsSchema,
				registerIds: z.array(z.string().min(1).max(4096)).min(1).max(32).optional(),
			}).strict().parse(args);
			const { contextId, check } = await this.inspectionContext(request.aurixMcp);
			const reader = new CoreRegisterReader(c => this.tcfClient.sendCommand(c));
			response.body = { registers: request.registerIds
				? await reader.read(contextId, request.registerIds, check) : await reader.list(contextId, check) };
			check();
			this.sendResponse(response);
			return;
		}
		if (command === 'aurix-tcf/frameSource') {
			if (!Number.isInteger(args?.frameId) || !Number.isInteger(args?.threadId)) {
				throw new Error('frameSource requires integer frameId and threadId');
			}
			const frame = this.frameIdToMeta.get(args.frameId);
			if (!frame || frame.threadId !== args.threadId) {
				throw new Error('frameSource refers to an expired frame or a different core');
			}
			response.body = { source: frame.source };
			this.sendResponse(response);
			return;
		}
		if (command === 'aurix-tcf/setInstructionStepping') {
			this.instructionSteppingEnabled = Boolean(args?.enabled);
			this.sendResponse(response);
			return;
		}
		if (command === 'aurix-tcf/halt') {
			this.pendingStepThreads.clear();
			this.pendingStepOutTargets.clear();
			try {
				// Best-effort: suspend the selected core context first (faster than trying many contexts).
				const ctx = await this.pickContextIdForCore(this.launchCore);
				if (ctx) {
					await this.tcfClient.pause(ctx);
				} else {
					await this.pauseAllCoresBestEffort('halt');
				}
				// Give the agent a moment to publish suspended state, then push a stopped event.
				await new Promise(resolve => setTimeout(resolve, 200));
				const ctx2 = await this.pickContextIdForCore(this.launchCore);
				if (ctx2) {
					await this.emitStoppedIfSuspended(ctx2, StoppedEventReason.pause);
				}
			} catch (e) {
				this.tcfLogger.error(`Halt failed: ${String(e)}`);
			}
			this.sendResponse(response);
			return;
		}

		if (command === 'aurix-tcf/reset') {
			try {
				this.beginResetTransition();
				// NOTE: ContextReset.getCapabilities is unreliable on some AURIX agents (can time out).
				// We therefore skip capability probing and use a configured resetType or a conservative default.
				const requestedType = typeof args?.type === 'string' ? args.type.trim() : '';
				const candidateTypes = [requestedType, this.launchResetType ?? '', 'reset']
					.map(t => (typeof t === 'string' ? t.trim() : ''))
					.filter(t => t !== '')
					.filter((t, i, a) => a.indexOf(t) === i);

				// Default: run after reset (agent should stop at first breakpoint / stop-at-function).
				const suspend = typeof args?.suspend === 'boolean' ? args.suspend : this.launchResetSuspend;
				const requestedCore = typeof args?.core === 'number' ? args.core : this.launchCore;
				const ctx = await this.pickContextIdForCore(requestedCore);
				if (!ctx) {
					throw new Error('No target context available for reset.');
				}
				const pauseAllAfterReset = typeof args?.pauseAll === 'boolean' ? args.pauseAll : false;

				// Temporarily increase timeout for reset; reset can legitimately take longer.
				const oldTimeout = (this.tcfClient as any).commandTimeout;
				try {
					this.tcfClient.setCommandTimeout(Math.max(30_000, Number(oldTimeout) || 0));

					let lastError: unknown;
					for (const type of candidateTypes) {
						try {
							this.tcfLogger.log(`Reset: type='${type}', suspend=${suspend}`);
							await this.tcfClient.reset(ctx, type, suspend);
							lastError = undefined;
							break;
						} catch (e) {
							lastError = e;
							let errText = '';
							if (e instanceof Error) {
								errText = e.message;
							} else {
								try {
									errText = JSON.stringify(e);
								} catch {
									errText = String(e);
								}
							}
							this.tcfLogger.error(`Reset attempt failed for type='${type}': ${errText}`);
						}
					}
					if (lastError) {
						throw lastError;
					}

					if (pauseAllAfterReset) {
						// Some resets will cause one core to start running immediately.
						// If the user requested a paused post-reset state, explicitly pause all cores.
						await new Promise(resolve => setTimeout(resolve, 200));
						try {
							await this.pauseAllCoresBestEffort('post-reset');
						} catch (e) {
							this.tcfLogger.error(`Post-reset pause-all failed: ${String(e)}`);
						}
						this.beginResetTransition();
						await new Promise(resolve => setTimeout(resolve, 200));
						await this.emitStoppedForAllSuspendedAtStartup(ctx, { targetReason: StoppedEventReason.pause, otherReason: StoppedEventReason.pause });
					}
				} finally {
					if (typeof oldTimeout === 'number') {
						this.tcfClient.setCommandTimeout(oldTimeout);
					}
				}
			} catch (e) {
				this.tcfLogger.error(`Reset failed: ${String(e)}`);
			}
			this.sendResponse(response);
			return;
		}

		if (command === 'aurix-tcf/addGlobal') {
			const expression = typeof args?.expression === 'string' ? args.expression.trim() : '';
			if (expression !== '' && !this.configuredGlobals.includes(expression)) {
				this.configuredGlobals.push(expression);
			}
			this.sendResponse(response);
			return;
		}

		if (command === 'aurix-tcf/setLiveWatch') {
			this.setLiveWatchState(Boolean(args?.enabled), args?.intervalMs);
			this.sendResponse(response);
			return;
		}

		if (command === 'aurix-tcf/liveWatchEvaluate') {
			const expressions = Array.isArray(args?.expressions)
				? args.expressions.filter((value: unknown): value is string => typeof value === 'string' && value.trim() !== '')
				: [];
			const values = [] as Array<{ expression: string; result: string; available: boolean; error?: string }>;
			for (const expression of expressions) {
				try {
					const result = await this.evaluateGlobalExpressionValue(expression);
					values.push({
						expression,
						result: result ?? '',
						available: result !== undefined,
					});
				} catch (e) {
					values.push({
						expression,
						result: '',
						available: false,
						error: e instanceof Error ? e.message : String(e),
					});
				}
			}
			response.body = { values };
			this.sendResponse(response);
			return;
		}

		// Fall back to default behavior for unknown custom requests.
		await super.customRequestAsync(command, response, args, request);
	}
}
