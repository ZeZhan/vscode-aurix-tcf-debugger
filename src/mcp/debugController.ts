import * as path from 'path';
import { promises as fs } from 'fs';
import { z } from 'zod';
import { DapEvents } from '../dapEvents';
import { randomUUID } from 'crypto';
import { launchOptionsSchema, type DebugLaunchOptions, type DebugStartProgress } from './launch';
import type { DebugPreparation, DebugPrepareOptions, PreparationProgress } from './prepare';
import { performance } from 'perf_hooks';
import { setTimeout as delay } from 'timers/promises';
import { localInspectionDetailsSchema } from '../variables/inspectionDiagnostics';
import { breakpointEvidenceSchema } from '../breakpointInspection';
import { memoryReadSchema, memoryValueSchema } from '../memoryInspection';
import { peripheralNamesSchema, peripheralPageSchema, peripheralRegisterSchema, peripheralValueSchema, peripheralWriteInfoSchema, peripheralWriteResultSchema } from '../peripheralInspection';
import { globalLookupSchema, globalSourceMatches, globalSymbolSchema, globalValueSchema } from '../variables/globals';

export interface McpDebugSession {
	id: string;
	name: string;
	workspace?: string;
	program?: string;
	targetDevice?: string;
	launchId?: string;
	request(command: string, args?: object): PromiseLike<unknown>;
}

export interface SourceBreakpoint {
	id: string;
	source: string;
	line: number;
	column: number;
	enabled: boolean;
	condition?: string;
	hitCondition?: string;
	logMessage?: string;
}

export interface DebugHost {
	prepareLaunch(options: DebugPrepareOptions, signal: AbortSignal, onProgress?: (progress: PreparationProgress) => void): Promise<DebugPreparation>;
	confirmPeripheralWrite(approval: PeripheralWriteApproval, signal: AbortSignal): Promise<(() => void) | undefined>;
	breakpoints(): SourceBreakpoint[];
	validateSource(source: string): Promise<void>;
	addBreakpoint(source: string, line: number): SourceBreakpoint;
	removeBreakpoint(id: string): void;
	reserveStart(launchId: string, signal: AbortSignal, onProgress?: (progress: Partial<DebugStartProgress>) => void): () => void;
	startSession(options: DebugLaunchOptions, launchId: string): PromiseLike<boolean>;
	stopSession(id: string): PromiseLike<AgentRelease>;
	reportError(error: unknown): void;
}

export type PeripheralWriteApproval = Readonly<{
	sessionId: string; sessionName: string; targetDevice: string; workspace?: string;
	threadId: number; contextId: string; name: string; address: string; size: number; valueHex: string;
}>;

export type AgentRelease = {
	ownership: 'extension' | 'external';
	agentReleased: boolean;
	processExited?: boolean;
	portClosed?: boolean;
	deviceAccessVerified: false;
	message?: string;
};

export class DebugMcpError extends Error {
	constructor(readonly code: string, message: string, readonly details?: Record<string, unknown>) {
		super(message);
	}
}

export async function validateWorkspaceSource(source: string, roots: readonly string[]): Promise<void> {
	const inside = (root: string, file: string) => {
		const relative = path.relative(root, file);
		return relative !== '' && relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
	};
	if (!path.isAbsolute(source) || !roots.some(root => inside(root, source))) {
		throw new DebugMcpError('INVALID_SOURCE', 'An absolute source path inside an open workspace folder is required.');
	}
	const real = await fs.realpath(source);
	if (!(await fs.stat(real)).isFile()) { throw new DebugMcpError('INVALID_SOURCE', 'Source must be a regular file.'); }
	for (const root of roots) {
		if (inside(await fs.realpath(root), real)) { return; }
	}
	throw new DebugMcpError('INVALID_SOURCE', 'Source resolves outside the open workspace folders.');
}

const stateSchema = z.object({
	instructionStepping: z.boolean(),
	inspectionEpoch: z.number().int().nonnegative().optional(),
	threads: z.array(z.object({
		id: z.number().int().positive(),
		name: z.string(),
		contextId: z.string(),
		suspended: z.boolean(),
		stop: z.object({
			evidence: z.literal('RunControl.getState'),
			reason: z.string().max(4096).nullable(),
			instructionPointerReference: z.string().regex(/^0x[0-9a-f]{1,8}$/).nullable(),
			pcUnavailable: z.string().max(4096).optional(),
			breakpointIds: z.array(z.string().max(4096)).max(64).optional(),
		}).optional(),
	})).max(64),
});

const breakpointRequestSchema = z.object({
	type: z.literal('request'),
	seq: z.number().int(),
	command: z.literal('setBreakpoints'),
	arguments: z.object({
		source: z.object({ path: z.string() }),
		breakpoints: z.array(z.object({ line: z.number().int() })).default([]),
	}),
});

const eventSchema = z.object({
	type: z.literal('event'),
	seq: z.number(),
	event: z.string(),
	body: z.record(z.string(), z.unknown()).optional(),
});

const responseSchema = z.object({
	type: z.literal('response'),
	request_seq: z.number(),
	success: z.boolean(),
	message: z.string().optional(),
	body: z.object({
		breakpoints: z.array(z.object({
			id: z.number().optional(),
			verified: z.boolean(),
			line: z.number().optional(),
			message: z.string().optional(),
		})).optional(),
	}).optional(),
});

const frameSchema = z.object({
	id: z.number().int(),
	name: z.string(),
	line: z.number().int(),
	column: z.number().int(),
	source: z.object({ name: z.string().optional(), path: z.string().optional() }).optional(),
	instructionPointerReference: z.string().optional(),
});

const variableSchema = z.object({
	name: z.string(), value: z.string(), type: z.string().optional(),
	variablesReference: z.number().int().nonnegative(),
	unavailable: z.string().optional(), pointerDereferenceAllowed: z.literal(false).optional(),
	unavailableCode: z.string().max(64).optional(), unavailableDetails: localInspectionDetailsSchema.optional(),
});
const registerSchema = z.object({
	id: z.string(), name: z.string(), size: z.number().optional(), readable: z.boolean(),
	readOnce: z.boolean().optional(), allowed: z.boolean(),
	bytesHex: z.string().regex(/^[0-9a-f]{8}$/).optional(), encoding: z.literal('raw-bytes').optional(),
});
export const observationSchema = z.object({
	globals: z.array(globalLookupSchema).max(8).default([]),
	peripherals: peripheralNamesSchema.optional(),
}).strict().refine(input => input.globals.length > 0 || (input.peripherals?.length ?? 0) > 0, 'Select at least one value.')
	.refine(input => new Set(input.globals.map(query => JSON.stringify([query.name, query.source ?? null]))).size === input.globals.length,
		'Use distinct global selectors.');
type InspectionRequest = (command: string, args: object) => Promise<unknown>;
type GlobalIdentity = { symbol: z.infer<typeof globalSymbolSchema>; elfSha256: string };
type InspectionHandle = { kind: 'frame' | 'variable' | 'register' | 'peripheral' | 'global'; id: number | string; threadId: number; generation: number;
	peripheral?: z.infer<typeof peripheralRegisterSchema>;
	global?: GlobalIdentity };

type BreakpointRequest = z.infer<typeof breakpointRequestSchema>;
type Control = 'start' | 'continue' | 'pause' | 'next' | 'stepIn' | 'stepOut' | 'stop' | 'breakpoint' | 'peripheralWrite';
type LaunchAttempt = { launchId: string; abort: AbortController; sessionId?: string };
type Entry = {
	session: McpDebugSession;
	events: DapEvents;
	generation: number;
	control?: { kind: Control; abort: AbortController; expectedCommand?: string };
	pendingWrites: number;
	breakpointRequests: Map<number, BreakpointRequest>;
	latestBreakpointRequest: Map<string, number>;
	handles: Map<string, InspectionHandle>;
	inspectionEpoch?: number;
};

function sourceKey(source: string): string {
	const normalized = path.normalize(source);
	return process.platform === 'win32' ? normalized.toLowerCase() : normalized;
}

function cancelled(signal: AbortSignal): Error {
	return signal.reason instanceof Error ? signal.reason : new DebugMcpError('CANCELLED', 'Request cancelled; hardware operations are not rolled back.');
}

export function abortable<T>(promise: PromiseLike<T>, signal: AbortSignal): Promise<T> {
	return new Promise((resolve, reject) => {
		const abort = () => reject(cancelled(signal));
		if (signal.aborted) {
			reject(cancelled(signal));
		} else {
			signal.addEventListener('abort', abort, { once: true });
		}
		void Promise.resolve(promise).then(resolve, reject).finally(() => signal.removeEventListener('abort', abort));
	});
}

export class DebugController {
	private readonly sessions = new Map<string, Entry>();
	private readonly lifecycleEvents = new DapEvents(16);
	private readonly stops = new Map<string, Promise<AgentRelease>>();
	private readonly endedSessions = new Map<string, Entry>();
	private starting?: LaunchAttempt;
	private preparing?: AbortController;

	constructor(private readonly host: DebugHost) {}

	addSession(session: McpDebugSession): void {
		if (!this.sessions.has(session.id)) {
			this.endedSessions.delete(session.id);
			this.stops.delete(session.id);
			this.sessions.set(session.id, {
				session, events: new DapEvents(128), generation: 0, pendingWrites: 0,
				breakpointRequests: new Map(), latestBreakpointRequest: new Map(),
				handles: new Map(),
			});
			if (session.launchId === this.starting?.launchId && this.starting) {
				this.starting.sessionId = session.id;
				this.sessions.get(session.id)!.control = { kind: 'start', abort: this.starting.abort };
			}
			this.lifecycleEvents.record({ type: 'event', seq: 0, event: 'sessionAdded', body: { sessionId: session.id, launchId: session.launchId } });
		}
	}

	endSession(id: string, error: Error = new DebugMcpError('SESSION_ENDED', 'The debug session has ended.')): void {
		const entry = this.sessions.get(id);
		if (!entry) { return; }
		this.sessions.delete(id);
		entry.handles.clear();
		this.endedSessions.set(id, entry);
		if (this.endedSessions.size > 64) {
			const oldest = this.endedSessions.keys().next().value;
			if (oldest !== undefined) { this.endedSessions.delete(oldest); }
		}
		entry.events.record({ type: 'event', seq: 0, event: 'sessionEnded' });
		entry.events.close(error);
		if (entry.control?.kind !== 'stop') { entry.control?.abort.abort(error); }
	}

	dispose(): void {
		this.preparing?.abort(new DebugMcpError('CANCELLED', 'Debug MCP is shutting down.'));
		this.starting?.abort.abort(new DebugMcpError('CANCELLED', 'Debug MCP is shutting down.'));
		for (const id of this.sessions.keys()) { this.endSession(id); }
		this.lifecycleEvents.close(new DebugMcpError('CANCELLED', 'Debug MCP is shutting down.'));
	}

	listSessions() {
		return { ...(this.starting ? { starting: { launchId: this.starting.launchId, sessionId: this.starting.sessionId } } : {}), sessions: [...this.sessions.values()].map(({ session, control }) => ({
			sessionId: session.id, name: session.name, workspace: session.workspace,
			program: session.program, targetDevice: session.targetDevice, operation: control?.kind,
		})) };
	}

	async prepare(options: DebugPrepareOptions, signal: AbortSignal, timeoutMs = 30000) {
		signal.throwIfAborted();
		const current = this.listSessions();
		const evidence = {
			preparedAt: new Date().toISOString(), advisoryOnly: true, debugStarted: false, targetMemoryRead: false,
			flashPerformed: false, firmwareMatchVerified: false, deviceAccessVerified: false,
			coreHardwareVerified: false, launchMayResetOrRun: true,
		};
		if (current.starting) { return { ...evidence, ...current, status: 'session-starting' as const }; }
		if (current.sessions.length) {
			const matching = current.sessions.filter(session =>
				(!options.workspaceFolder || (session.workspace && sourceKey(session.workspace) === sourceKey(options.workspaceFolder))) &&
				(!options.program || (session.program && sourceKey(session.program) === sourceKey(options.program))) &&
				(!options.targetDevice || session.targetDevice === options.targetDevice));
			return { ...evidence, ...current, status: matching.length === 1 ? 'reuse-session' as const : 'select-session' as const,
				...(matching.length === 1 ? { sessionId: matching[0].sessionId } : {}),
				requested: options, discoveryPerformed: false,
				message: 'Existing sessions take precedence. No ELF scan, DAS enumeration or DAP request was performed. Confirm core states with debug_status; do not start another backend.' };
		}
		if (this.preparing) { throw new DebugMcpError('BUSY', 'Another debug preparation is still running.'); }
		const preparation = new AbortController();
		this.preparing = preparation;
		let job: Promise<DebugPreparation> | undefined;
		let progress: PreparationProgress | undefined;
		const started = performance.now();
		let received = started;
		const onProgress = (value: PreparationProgress) => { progress = value; received = performance.now(); };
		const diagnostics = (includePartial = true) => {
			const snapshot = progress ? structuredClone(progress) : undefined;
			return {
				timeoutMs,
				stage: snapshot?.stage ?? 'host-preflight', currentPath: snapshot?.currentPath,
				completedStages: snapshot?.completedStages ?? [],
				elapsedMs: Math.round(performance.now() - started),
				stageElapsedMs: (snapshot?.stageElapsedMs ?? 0) + Math.round(performance.now() - received),
				...(includePartial && snapshot ? { partial: snapshot.partial } : {}),
				diagnosticOnly: true,
			};
		};
		const readOnlyEvidence = {
			debugStarted: false, flashPerformed: false, executionChanged: false, targetMemoryRead: false,
			targetRegisterRead: false, firmwareMatchVerified: false,
		};
		try {
			return await this.bounded(AbortSignal.any([signal, preparation.signal]), timeoutMs, async inner => {
				const mark = this.lifecycleEvents.mark();
				job = Promise.resolve().then(() => { inner.throwIfAborted(); return this.host.prepareLaunch(options, inner, onProgress); });
				const result = await abortable(job, inner);
				inner.throwIfAborted();
				if (mark !== this.lifecycleEvents.mark() || this.sessions.size || this.starting) {
					throw new DebugMcpError('STATE_CHANGED', 'The debug lifecycle changed during preparation. Inspect debug_sessions; no launch was performed.');
				}
				return { ...result, ...evidence, sessions: [], discoveryPerformed: true, diagnostics: diagnostics(false),
					message: 'Advisory snapshot, not a reservation or launch approval. Revalidate the selected artifacts/device when starting; no firmware match or core availability was probed.' };
			}, () => new DebugMcpError('PREPARE_TIMEOUT',
				`Read-only debug preparation timed out during ${progress?.stage ?? 'host-preflight'} after ${timeoutMs} ms. ` +
				'This preparation did not start a debug session, flash firmware, or change target execution. Partial findings are diagnostic only; do not automatically retry.',
				{ ...readOnlyEvidence, preparation: diagnostics() }));
		} catch (error) {
			if (error instanceof DebugMcpError && error.code === 'PREPARE_TIMEOUT') { throw error; }
			const code = error instanceof DebugMcpError ? error.code :
				(signal.aborted || preparation.signal.aborted ? 'CANCELLED' : 'PREPARE_FAILED');
			throw new DebugMcpError(code, `${error instanceof Error ? error.message : String(error)} ` +
				'Read-only preparation did not start a debug session, flash firmware, or change target execution.',
				{ ...(error instanceof DebugMcpError ? error.details : {}), ...readOnlyEvidence, preparation: diagnostics() });
		} finally {
			const release = () => { if (this.preparing === preparation) { this.preparing = undefined; } };
			if (job) { void job.then(release, release); } else { release(); }
		}
	}

	async start(options: DebugLaunchOptions, signal: AbortSignal, timeoutMs = 180000) {
		options = launchOptionsSchema.parse(options);
		if (this.sessions.size || this.starting) {
			throw new DebugMcpError('BUSY', 'An AURIX session already exists or is starting. Select it using debug_sessions; do not launch another backend.');
		}
		const attempt: LaunchAttempt = { launchId: randomUUID(), abort: new AbortController() };
		this.starting = attempt;
		let entry: Entry | undefined;
		let launched = false;
		let progress: DebugStartProgress = {
			stage: 'configuration', flashStatus: 'pending',
			flashAttempts: 0, eraseAllRetried: false, agentReady: false,
		};
		const startupEvidence = () => ({
			flashRequested: true,
			flashPerformed: progress.flashStatus === 'completed' ? true :
				(progress.flashStatus === 'running' || progress.flashStatus === 'failed' ? null : false),
			requestedEntryFunction: options.entryFunction ?? null,
			startup: { ...progress },
		});
		try {
			return await this.bounded(AbortSignal.any([signal, attempt.abort.signal]), timeoutMs, async inner => {
				const release = this.host.reserveStart(attempt.launchId, inner, update => { progress = { ...progress, ...update }; });
				const mark = this.lifecycleEvents.mark();
				const launch = Promise.resolve().then(() => {
					inner.throwIfAborted();
					return this.host.startSession(options, attempt.launchId);
				});
				launched = true;
				try {
					const added = this.lifecycleEvents.waitFor('sessionAdded', mark, timeoutMs,
						event => event.body?.launchId === attempt.launchId, inner);
					const [, event] = await Promise.all([
						abortable(launch.then(accepted => {
							if (!accepted) { throw new DebugMcpError('START_REJECTED', 'VS Code rejected the debug launch. Check the Debug Console and AURIX TCF Agent output.'); }
							return accepted;
						}), inner), added,
					]);
					entry = this.entry(String(event.body?.sessionId));
					const readyEntry = entry;
					progress.stage = 'waiting-for-stop';
					if (progress.flashStatus !== 'completed') {
						throw new DebugMcpError('FLASH_NOT_CONFIRMED', 'The launch returned without confirmation that the requested flasher operation completed.');
					}
					await readyEntry.events.waitFor('stopped', 0, timeoutMs, () => true, inner);
					for (;;) {
						inner.throwIfAborted();
						const state = await this.controlSnapshot(readyEntry, inner);
						const cores = state.threads.filter(thread => new RegExp(`(?:^|\\.)C${options.core}$`, 'i').test(thread.contextId));
						if (cores.length > 1) {
							throw new DebugMcpError('CORE_AMBIGUOUS', 'The requested core does not have a unique native context. No fallback core was selected.');
						}
						const thread = cores[0];
						const selectedStop = thread && readyEntry.events.since(0, 'stopped').filter(event => event.body?.threadId === thread.id).pop();
						if (state.state === 'stopped' && thread?.suspended && selectedStop) {
							progress.stage = 'stopped';
							return { ...state, threadId: thread.id, core: options.core,
								program: options.program, workspaceFolder: options.workspaceFolder, targetDevice: options.targetDevice,
								...startupEvidence(), firmwareMatchVerified: false,
								stopMode: 'pauseAfterLaunch', entryLocationVerified: false,
								event: { name: selectedStop.event, reason: selectedStop.body?.reason } };
						}
						await abortable(delay(50), inner);
					}
				} finally {
					// A timeout cancels waiting, not VS Code's pending launch. Keep the factory reserved
					// until that request settles; the aborted reservation rejects late factory starts.
					const finished = () => {
						release();
						if (this.starting === attempt) { this.starting = undefined; }
						const late = [...this.sessions.values()].find(value => value.session.launchId === attempt.launchId);
						if (late?.control?.abort === attempt.abort) { late.control = undefined; }
					};
					void launch.then(finished, error => { finished(); this.host.reportError(error); });
				}
			});
		} catch (error) {
			const session = entry?.session ?? [...this.sessions.values()].find(value => value.session.launchId === attempt.launchId)?.session;
			throw new DebugMcpError(error instanceof DebugMcpError ? error.code : 'START_FAILED',
				`${error instanceof Error ? error.message : String(error)} Launch is not retried or rolled back. Use debug_sessions and debug_stop to recover.`,
				{ ...(error instanceof DebugMcpError ? error.details : {}),
					...startupEvidence(), firmwareMatchVerified: false, launchId: attempt.launchId, sessionId: session?.id ?? attempt.sessionId });
		} finally {
			// reserveStart can reject before there is a launch promise to release it.
			if (!launched && this.starting === attempt) { this.starting = undefined; }
			const started = entry ?? [...this.sessions.values()].find(value => value.session.launchId === attempt.launchId);
			if (started?.control?.abort === attempt.abort) { started.control = undefined; }
		}
	}

	observeRequest(id: string, message: unknown): void {
		const entry = this.sessions.get(id);
		if (!entry) { return; }
		const request = z.object({ type: z.literal('request'), command: z.string() }).safeParse(message);
		if (request.success && /^(continue|next|stepIn|stepOut|pause|restart|disconnect|terminate|setVariable|setExpression|writeMemory|aurix-tcf\/(reset|halt))$/.test(request.data.command)) {
			this.invalidateHandles(entry);
			if (entry.control?.expectedCommand === request.data.command) {
				entry.control.expectedCommand = undefined;
			} else if (entry.control && entry.control.kind !== 'stop') {
				entry.control.abort.abort(new DebugMcpError('STATE_CHANGED', 'Another debugger client or the VS Code UI changed execution state.'));
			}
		}
		const parsed = breakpointRequestSchema.safeParse(message);
		if (parsed.success) {
			if (entry.breakpointRequests.size >= 128) {
				const oldest = entry.breakpointRequests.keys().next().value;
				if (oldest !== undefined) {
					const source = entry.breakpointRequests.get(oldest)?.arguments.source.path;
					if (source && entry.latestBreakpointRequest.get(sourceKey(source)) === oldest) {
						entry.latestBreakpointRequest.delete(sourceKey(source));
					}
					entry.breakpointRequests.delete(oldest);
				}
			}
			entry.breakpointRequests.set(parsed.data.seq, parsed.data);
			entry.latestBreakpointRequest.set(sourceKey(parsed.data.arguments.source.path), parsed.data.seq);
		}
	}

	observeMessage(id: string, message: unknown): void {
		const entry = this.sessions.get(id);
		if (!entry) { return; }
		const event = eventSchema.safeParse(message);
		if (event.success) {
			if (['stopped', 'continued', 'invalidated', 'thread'].includes(event.data.event)) {
				this.invalidateHandles(entry);
				entry.events.record(event.data);
			}
			if (event.data.event === 'terminated') { this.endSession(id); }
			return;
		}
		const response = responseSchema.safeParse(message);
		if (!response.success) { return; }
		const request = entry.breakpointRequests.get(response.data.request_seq);
		if (!request) { return; }
		entry.breakpointRequests.delete(request.seq);
		if (entry.latestBreakpointRequest.get(sourceKey(request.arguments.source.path)) !== request.seq) { return; }
		entry.latestBreakpointRequest.delete(sourceKey(request.arguments.source.path));
		entry.events.record({
			type: 'event', seq: 0, event: 'breakpointsApplied',
			body: { request: request.arguments, response: response.data },
		});
	}

	private entry(id: string): Entry {
		const entry = this.sessions.get(id);
		if (!entry) { throw new DebugMcpError('SESSION_NOT_FOUND', 'Select an existing AURIX session using debug_sessions.'); }
		return entry;
	}

	private async bounded<T>(signal: AbortSignal, timeoutMs: number, run: (signal: AbortSignal) => Promise<T>,
		timeoutError = () => new DebugMcpError('TIMEOUT',
			'Timed out. The hardware operation may have executed. Query debug_status; do not automatically repeat it.')): Promise<T> {
		const abort = new AbortController();
		const forward = () => abort.abort(cancelled(signal));
		if (signal.aborted) { forward(); } else { signal.addEventListener('abort', forward, { once: true }); }
		const timer = setTimeout(() => abort.abort(timeoutError()), timeoutMs);
		try {
			abort.signal.throwIfAborted();
			return await run(abort.signal);
		} finally {
			clearTimeout(timer);
			signal.removeEventListener('abort', forward);
			abort.abort(new DebugMcpError('CANCELLED', 'Operation finished.'));
		}
	}

	private async snapshot(entry: Entry, signal: AbortSignal) {
		const generation = entry.generation;
		const state = stateSchema.parse(await abortable(entry.session.request('aurix-tcf/mcpState'), signal));
		if (!this.sessions.has(entry.session.id)) { throw new DebugMcpError('SESSION_ENDED', 'The debug session ended during state inspection.'); }
		if (generation !== entry.generation) { throw new DebugMcpError('STATE_CHANGED', 'Execution state changed during inspection. Query debug_status again.'); }
		if (entry.inspectionEpoch !== undefined && entry.inspectionEpoch !== state.inspectionEpoch) {
			this.invalidateHandles(entry);
			entry.inspectionEpoch = state.inspectionEpoch;
			throw new DebugMcpError('STATE_CHANGED', 'The adapter invalidated its references. Obtain a new stack or register list.');
		}
		entry.inspectionEpoch = state.inspectionEpoch;
		const stopped = state.threads.filter(thread => thread.suspended).length;
		return {
			sessionId: entry.session.id, generation, ...state,
			state: state.threads.length === 0 ? 'unknown' : stopped === 0 ? 'running' : stopped === state.threads.length ? 'stopped' : 'mixed',
		};
	}

	async status(id: string, signal: AbortSignal, timeoutMs = 10000) {
		return this.bounded(signal, timeoutMs, inner => this.snapshot(this.entry(id), inner));
	}

	private async controlSnapshot(entry: Entry, signal: AbortSignal) {
		for (;;) {
			signal.throwIfAborted();
			try {
				const state = await this.snapshot(entry, signal);
				signal.throwIfAborted();
				return state;
			} catch (error) {
				// Expected execution events can race a state read; only resample metadata, never replay the command.
				signal.throwIfAborted();
				if (!(error instanceof DebugMcpError) || error.code !== 'STATE_CHANGED') { throw error; }
				await abortable(delay(50), signal);
			}
		}
	}

	async stack(id: string, threadId: number, levels: number, signal: AbortSignal) {
		return this.bounded(signal, 10000, async inner => {
			const entry = this.entry(id);
			const before = await this.snapshot(entry, inner);
			if (!before.threads.some(thread => thread.id === threadId && thread.suspended)) {
				throw new DebugMcpError('THREAD_NOT_STOPPED', 'The requested thread must exist and be stopped.');
			}
			const body = z.object({ stackFrames: z.array(frameSchema), totalFrames: z.number().optional() }).parse(
				await abortable(entry.session.request('stackTrace', { threadId, startFrame: 0, levels }), inner)
			);
			const after = await this.snapshot(entry, inner);
			if (before.generation !== after.generation || !after.threads.find(thread => thread.id === threadId)?.suspended) {
				throw new DebugMcpError('STATE_CHANGED', 'The stack became stale during inspection.');
			}
			return { sessionId: id, threadId, generation: after.generation, ...body,
				stackFrames: body.stackFrames.slice(0, levels).map(frame => ({
					...frame, frameHandle: this.handle(entry, 'frame', frame.id, threadId),
				})) };
		});
	}

	private invalidateHandles(entry: Entry): void {
		entry.generation++;
		entry.handles.clear();
		entry.inspectionEpoch = undefined;
	}

	private handle(entry: Entry, kind: InspectionHandle['kind'], id: number | string, threadId: number,
		peripheral?: z.infer<typeof peripheralRegisterSchema>): string {
		for (const [token, handle] of entry.handles) {
			if (handle.kind === kind && handle.id === id && handle.threadId === threadId && handle.generation === entry.generation &&
				JSON.stringify(handle.peripheral) === JSON.stringify(peripheral)) { return token; }
		}
		if (entry.handles.size >= 4096) {
			throw new DebugMcpError('REFERENCE_LIMIT', 'Inspection reference limit reached. Old references are discarded on execution changes.');
		}
		const handle = randomUUID();
		entry.handles.set(handle, { kind, id, threadId, generation: entry.generation, peripheral });
		return handle;
	}

	private resolveHandle(entry: Entry, token: string, kind: InspectionHandle['kind']): InspectionHandle {
		const reference = entry.handles.get(token);
		if (!reference || reference.kind !== kind || reference.generation !== entry.generation) {
			throw new DebugMcpError('STALE_REFERENCE', 'Unknown, cross-session or expired inspection handle. Obtain a new stack/scopes/register list after execution changes.');
		}
		return reference;
	}

	private async inspect<T>(entry: Entry, threadId: number, signal: AbortSignal,
		run: (request: InspectionRequest) => Promise<T>) {
		return this.bounded(signal, 10000, async inner => {
			if (entry.control || entry.pendingWrites) { throw new DebugMcpError('BUSY', 'Wait for the pending debugger control operation before inspecting data.'); }
			const expiresAt = Date.now() + 9500;
			const before = await this.snapshot(entry, inner);
			if (before.state !== 'stopped' || !before.threads.some(thread => thread.id === threadId && thread.suspended)) {
				throw new DebugMcpError('THREAD_NOT_STOPPED', 'Data inspection requires all reported cores stopped and an explicit valid thread.');
			}
			if (before.inspectionEpoch === undefined) { throw new DebugMcpError('UNSUPPORTED_ADAPTER', 'Reload VS Code with the updated AURIX Debugger to use data inspection.'); }
			const aurixMcp = { threadId, epoch: before.inspectionEpoch, expiresAt };
			const result = await run(async (command, args) => {
				inner.throwIfAborted();
				if (entry.generation !== before.generation) { throw new DebugMcpError('STALE_REFERENCE', 'Execution changed before the inspection request.'); }
				return abortable(entry.session.request(command, { ...args, aurixMcp }), inner);
			});
			const after = await this.snapshot(entry, inner);
			if (before.generation !== after.generation || before.inspectionEpoch !== after.inspectionEpoch || after.state !== 'stopped') {
				throw new DebugMcpError('STATE_CHANGED', 'Inspection became stale during the read. Obtain new references; no value is returned as current.');
			}
			return { result, generation: after.generation, state: after };
		});
	}

	async scopes(id: string, frameHandle: string, signal: AbortSignal) {
		const entry = this.entry(id);
		const frame = this.resolveHandle(entry, frameHandle, 'frame');
		const { result, generation } = await this.inspect(entry, frame.threadId, signal, async request =>
			z.object({ scopes: z.array(z.object({
				name: z.string(), variablesReference: z.number().int().positive(), expensive: z.boolean(),
			})).max(16) }).parse(await request('scopes', { frameId: frame.id })));
		this.resolveHandle(entry, frameHandle, 'frame');
		return { sessionId: id, threadId: frame.threadId, generation,
			scopes: result.scopes.map(({ variablesReference, ...scope }) => ({
				...scope, variablesHandle: this.handle(entry, 'variable', variablesReference, frame.threadId),
			})) };
	}

	async variables(id: string, variablesHandle: string, start: number, count: number, signal: AbortSignal) {
		z.object({ start: z.number().int().min(0).max(1000000), count: z.number().int().min(1).max(100) }).parse({ start, count });
		const entry = this.entry(id);
		const reference = this.resolveHandle(entry, variablesHandle, 'variable');
		const { result, generation } = await this.inspect(entry, reference.threadId, signal, async request =>
			z.object({ variables: z.array(variableSchema).max(count), totalVariables: z.number().int().nonnegative(), start: z.literal(start) })
				.parse(await request('variables', { variablesReference: reference.id, start, count })));
		this.resolveHandle(entry, variablesHandle, 'variable');
		return { sessionId: id, threadId: reference.threadId, generation, start, total: result.totalVariables,
			nextStart: start + result.variables.length < result.totalVariables ? start + result.variables.length : undefined,
			variables: result.variables.map(({ variablesReference, ...variable }) => ({
				...variable, variablesHandle: variablesReference > 0 ? this.handle(entry, 'variable', variablesReference, reference.threadId) : undefined,
			})) };
	}

	async registers(id: string, threadId: number, signal: AbortSignal) {
		const entry = this.entry(id);
		const { result, generation } = await this.inspect(entry, threadId, signal, async request =>
			z.object({ registers: z.array(registerSchema).max(128) }).parse(await request('aurix-tcf/mcpRegisters', {})));
		if (!this.sessions.has(id) || entry.generation !== generation) { throw new DebugMcpError('STATE_CHANGED', 'The register metadata became stale.'); }
		return { sessionId: id, threadId, generation, valuesRead: false,
			registers: result.registers.map(({ id: registerId, bytesHex: _bytes, encoding: _encoding, ...metadata }) => ({
				...metadata, registerHandle: metadata.allowed ? this.handle(entry, 'register', registerId, threadId) : undefined,
			})) };
	}

	private async lookupGlobals(request: InspectionRequest, input: z.infer<typeof globalLookupSchema>) {
		const result = z.object({ name: z.literal(input.name), source: z.string().optional(), elfSha256: z.string().regex(/^[0-9a-f]{64}$/),
			symbols: z.array(globalSymbolSchema).min(1).max(64) }).parse(await request('aurix-tcf/mcpGlobals', input));
		if (result.source !== input.source || result.symbols.some(symbol => symbol.name !== input.name ||
			!globalSourceMatches(symbol.source, input.source) ||
			symbol.readable !== (symbol.reference > 0) || symbol.readable !== (symbol.unavailable === null)) ||
			new Set(result.symbols.filter(symbol => symbol.readable).map(symbol => symbol.reference)).size !== result.symbols.filter(symbol => symbol.readable).length) {
			throw new DebugMcpError('INVALID_RESPONSE', 'Global symbol lookup response does not match the request.');
		}
		return result;
	}

	async globals(id: string, threadId: number, raw: unknown, signal: AbortSignal) {
		const input = globalLookupSchema.parse(raw), entry = this.entry(id);
		const { result, generation } = await this.inspect(entry, threadId, signal, request => this.lookupGlobals(request, input));
		if (!this.sessions.has(id) || generation !== entry.generation) { throw new DebugMcpError('STATE_CHANGED', 'Global symbol metadata became stale.'); }
		return { sessionId: id, threadId, generation, name: input.name, source: input.source, elfSha256: result.elfSha256,
			lookupEvidence: 'Symbols.findByName', valuesRead: false, firmwareMatchVerified: false,
			symbols: result.symbols.map(symbol => {
				let symbolHandle: string | undefined;
				if (symbol.readable) {
					symbolHandle = this.handle(entry, 'global', symbol.reference, threadId);
					entry.handles.get(symbolHandle)!.global = { symbol, elfSha256: result.elfSha256 };
				}
				const { reference: _reference, ...metadata } = symbol;
				return { ...metadata, symbolHandle };
			}) };
	}

	private async readGlobalValue(request: InspectionRequest, expected: GlobalIdentity) {
		const result = z.object({ elfSha256: z.string(), variable: globalValueSchema })
			.parse(await request('aurix-tcf/mcpReadGlobal', { reference: expected.symbol.reference }));
		const variable = result.variable;
		if (result.elfSha256 !== expected.elfSha256 || variable.name !== expected.symbol.name ||
			variable.source !== expected.symbol.source || variable.address !== expected.symbol.address ||
			variable.size !== expected.symbol.size || variable.storage !== expected.symbol.storage ||
			(variable.variablesReference > 0) !== expected.symbol.expandable ||
			(variable.type ?? null) !== expected.symbol.type ||
			variable.evidence !== (variable.storage === 'memory' ? 'Memory.get' : 'Symbols.getContext')) {
			throw new DebugMcpError('INVALID_RESPONSE', 'Global value does not match the selected symbol identity.');
		}
		return result;
	}

	private capturedGlobal(entry: Entry, threadId: number, value: z.infer<typeof globalValueSchema>) {
		const { variablesReference, ...variable } = value;
		return { ...variable, variablesHandle: variablesReference > 0 ? this.handle(entry, 'variable', variablesReference, threadId) : undefined };
	}

	async readGlobal(id: string, symbolHandle: string, signal: AbortSignal) {
		const entry = this.entry(id), reference = this.resolveHandle(entry, symbolHandle, 'global');
		const expected = reference.global;
		if (!expected) { throw new DebugMcpError('STALE_REFERENCE', 'Global symbol identity is unavailable; look it up again.'); }
		const { result, generation } = await this.inspect(entry, reference.threadId, signal, request => this.readGlobalValue(request, expected));
		this.resolveHandle(entry, symbolHandle, 'global');
		return { sessionId: id, threadId: reference.threadId, generation, symbolHandle, elfSha256: result.elfSha256,
			firmwareMatchVerified: false, atomicWithPeripherals: false,
			variable: this.capturedGlobal(entry, reference.threadId, result.variable) };
	}

	async readMemory(id: string, threadId: number, address: string, count: number, signal: AbortSignal) {
		const args = memoryReadSchema.parse({ address, count });
		const entry = this.entry(id);
		const { result, generation } = await this.inspect(entry, threadId, signal, async request =>
			memoryValueSchema.parse(await request('aurix-tcf/mcpReadMemory', args)));
		if (Number(result.address) !== Number(address) || result.count !== count) {
			throw new DebugMcpError('INVALID_RESPONSE', 'Memory response does not match the requested address and size.');
		}
		return { sessionId: id, threadId, generation, ...result, atomicWithPeripherals: false };
	}

	private async lookupPeripherals(request: InspectionRequest, input: z.infer<typeof peripheralPageSchema>) {
		const result = z.object({
			registers: z.array(peripheralRegisterSchema).max(input.count), start: z.literal(input.start),
			total: z.number().int().min(0).max(131072), catalogTotal: z.number().int().min(0).max(131072),
			excludedDefinitions: z.number().int().nonnegative(),
		}).parse(await request('aurix-tcf/mcpPeripherals', input));
		if (result.total > result.catalogTotal || result.registers.length !== Math.min(input.count, Math.max(0, result.total - input.start)) ||
			new Set(result.registers.map(register => register.id)).size !== result.registers.length ||
			result.registers.some(register => register.evidence !== 'SVD' || !register.name.toLowerCase().includes(input.filter.toLowerCase()) ||
				(input.exactNames !== undefined && !input.exactNames.includes(register.name)))) {
			throw new DebugMcpError('INVALID_RESPONSE', 'Peripheral catalog response does not match the requested page.');
		}
		return result;
	}

	async peripherals(id: string, threadId: number, signal: AbortSignal, page: unknown = {}) {
		const input = peripheralPageSchema.strict().parse(page);
		const entry = this.entry(id);
		const { result, generation } = await this.inspect(entry, threadId, signal, request => this.lookupPeripherals(request, input));
		if (!this.sessions.has(id) || entry.generation !== generation) { throw new DebugMcpError('STATE_CHANGED', 'Peripheral metadata became stale.'); }
		return { sessionId: id, threadId, generation, valuesRead: false, nativeMetadataVerified: false,
			start: result.start, total: result.total, catalogTotal: result.catalogTotal, excludedDefinitions: result.excludedDefinitions,
			nextStart: input.start + result.registers.length < result.total ? input.start + result.registers.length : null,
			registers: result.registers.map(({ id: registerId, ...metadata }) => ({
				...metadata, registerHandle: this.handle(entry, 'peripheral', registerId, threadId, { id: registerId, ...metadata }),
			})) };
	}

	private async readPeripheralValues(request: InspectionRequest, expected: z.infer<typeof peripheralRegisterSchema>[]) {
		const result = z.object({ registers: z.array(peripheralValueSchema).length(expected.length) })
			.parse(await request('aurix-tcf/mcpPeripherals', { registerIds: expected.map(register => register.id) }));
		if (result.registers.some((register, index) => register.id !== expected[index].id ||
			register.name !== expected[index].name || register.address !== expected[index].address ||
			register.size !== expected[index].size)) {
			throw new DebugMcpError('INVALID_RESPONSE', 'Peripheral response does not match the requested registers.');
		}
		return result;
	}

	async readPeripherals(id: string, handles: string[], signal: AbortSignal) {
		z.array(z.string()).min(1).max(32).refine(values => new Set(values).size === values.length, 'Use distinct peripheral handles.').parse(handles);
		const entry = this.entry(id);
		const references = handles.map(handle => this.resolveHandle(entry, handle, 'peripheral'));
		const threadId = references[0].threadId;
		if (references.some(reference => reference.threadId !== threadId)) { throw new DebugMcpError('INVALID_CORE', 'One peripheral read cannot mix cores.'); }
		const expected = references.map(reference => {
			if (!reference.peripheral) { throw new DebugMcpError('STALE_REFERENCE', 'Peripheral identity is unavailable; look it up again.'); }
			return reference.peripheral;
		});
		const { result, generation } = await this.inspect(entry, threadId, signal, request => this.readPeripheralValues(request, expected));
		for (const handle of handles) { this.resolveHandle(entry, handle, 'peripheral'); }
		return { sessionId: id, threadId, generation, evidence: 'Registers.get', atomicWithPeripherals: false,
			registers: result.registers.map(({ id: _id, ...register }, index) => ({ ...register, registerHandle: handles[index] })) };
	}

	async observe(id: string, threadId: number, raw: unknown, signal: AbortSignal) {
		const input = observationSchema.parse(raw), entry = this.entry(id);
		const { result, state } = await this.inspect(entry, threadId, signal, async request => {
			const globals: GlobalIdentity[] = [];
			for (const query of input.globals) {
				const found = await this.lookupGlobals(request, query);
				if (found.symbols.length !== 1) {
					throw new DebugMcpError('AMBIGUOUS_GLOBAL', `Select an unambiguous source for ${query.name} using debug_global_variables.`);
				}
				const symbol = found.symbols[0];
				if (!symbol.readable) { throw new DebugMcpError('GLOBAL_UNAVAILABLE', `${query.name}: ${symbol.unavailable}`); }
				if (globals.length && found.elfSha256 !== globals[0].elfSha256) {
					throw new DebugMcpError('INVALID_RESPONSE', 'Global selections do not refer to the same ELF.');
				}
				globals.push({ symbol, elfSha256: found.elfSha256 });
			}
			let peripherals: z.infer<typeof peripheralRegisterSchema>[] = [];
			if (input.peripherals) {
				const found = await this.lookupPeripherals(request, peripheralPageSchema.parse({ exactNames: input.peripherals, count: 100 }));
				if (found.total > found.registers.length) {
					throw new DebugMcpError('AMBIGUOUS_PERIPHERAL', 'Exact register selection exceeds the bounded catalog result.');
				}
				peripherals = input.peripherals.map(name => {
					const matches = found.registers.filter(register => register.name === name);
					if (matches.length !== 1) {
						throw new DebugMcpError(matches.length ? 'AMBIGUOUS_PERIPHERAL' : 'PERIPHERAL_NOT_FOUND',
							`Select an exact unique register name using debug_peripheral_registers: ${name}`);
					}
					const register = matches[0];
					if (!register.allowed || !register.readable || register.readAction || register.size > 8) {
						throw new DebugMcpError('PERIPHERAL_NOT_READABLE', `Automatic reading is not allowed for ${name}.`);
					}
					return register;
				});
			}
			const values = [];
			for (const expected of globals) { values.push(await this.readGlobalValue(request, expected)); }
			const registers = peripherals.length ? (await this.readPeripheralValues(request, peripherals)).registers : [];
			return { values, registers };
		});
		if (!this.sessions.has(id) || entry.generation !== state.generation || entry.control || entry.pendingWrites) {
			throw new DebugMcpError('STATE_CHANGED', 'The batch observation became stale before returning values.');
		}
		return { ...state, threadId, firmwareMatchVerified: false, atomicWithPeripherals: false,
			globals: result.values.map(value => ({
				elfSha256: value.elfSha256, variable: this.capturedGlobal(entry, threadId, value.variable),
			})),
			peripherals: result.registers.map(({ id: _id, ...register }) => ({ ...register, readEvidence: 'Registers.get' as const })) };
	}

	async writePeripheral(id: string, handle: string, value: string, signal: AbortSignal) {
		const rawValue = z.string().max(128).regex(/^(?:0x[0-9a-f]+|[0-9]+)$/i).parse(value);
		const entry = this.entry(id);
		const reference = this.resolveHandle(entry, handle, 'peripheral'), register = reference.peripheral;
		if (!register?.writable || !register.writeRequiresApproval || register.policy !== 'svd-native-v1' || register.size > 8) {
			throw new DebugMcpError('WRITE_NOT_ALLOWED', 'This register is not writable under the session SVD policy.');
		}
		if (!entry.session.targetDevice) { throw new DebugMcpError('TARGET_UNKNOWN', 'The actual DAS device must be known before a peripheral write.'); }
		const numeric = BigInt(rawValue);
		if (numeric >= (1n << BigInt(register.size * 8))) { throw new DebugMcpError('INVALID_VALUE', 'Write value exceeds the register width.'); }
		const valueHex = `0x${numeric.toString(16).padStart(register.size * 2, '0')}`;
		let prepared: z.infer<typeof peripheralWriteInfoSchema> | undefined;
		try {
			await this.inspect(entry, reference.threadId, signal, async request => {
				prepared = peripheralWriteInfoSchema.parse(await request('aurix-tcf/mcpPreparePeripheralWrite', { registerId: reference.id, value: valueHex }));
			});
			const plan = prepared;
			if (!plan || plan.id !== reference.id || plan.name !== register.name || plan.address !== register.address ||
				plan.size !== register.size || plan.valueHex !== valueHex || plan.threadId !== reference.threadId ||
				plan.epoch !== entry.inspectionEpoch || plan.expiresAt <= Date.now() || plan.expiresAt > Date.now() + 120000) {
				throw new DebugMcpError('INVALID_RESPONSE', 'Peripheral write preflight does not match the requested operation.');
			}
			const approval = Object.freeze({ sessionId: id, sessionName: entry.session.name, targetDevice: entry.session.targetDevice,
				workspace: entry.session.workspace, threadId: plan.threadId, contextId: plan.contextId,
				name: plan.name, address: plan.address, size: plan.size, valueHex: plan.valueHex });
			return await this.exclusive(entry, 'peripheralWrite', signal, Math.min(120000, plan.expiresAt - Date.now()), async inner => {
				this.resolveHandle(entry, handle, 'peripheral');
				const approved = await abortable(this.host.confirmPeripheralWrite(approval, inner), inner);
				if (!approved) { throw new DebugMcpError('USER_DECLINED', 'User declined the peripheral write. No write was sent.'); }
				inner.throwIfAborted();
				const state = await this.snapshot(entry, inner);
				this.resolveHandle(entry, handle, 'peripheral');
				if (state.state !== 'stopped' || state.inspectionEpoch !== plan.epoch ||
					!state.threads.some(thread => thread.id === plan.threadId && thread.contextId === plan.contextId && thread.suspended) ||
					Date.now() >= plan.expiresAt) {
					throw new DebugMcpError('STATE_CHANGED', 'Peripheral write approval expired or the target/core state changed. No write was sent.');
				}
				let submitted = false;
				try {
					const result = peripheralWriteResultSchema.parse(await this.bounded(inner, 10000, writing => this.write(entry, 'aurix-tcf/mcpCommitPeripheralWrite', {
						token: plan.token, aurixMcp: { threadId: plan.threadId, epoch: plan.epoch, expiresAt: Date.now() + 9500 },
					}, writing, () => { approved(); submitted = true; })));
					if (result.id !== plan.id || result.name !== plan.name || result.address !== plan.address ||
						result.size !== plan.size || result.valueHex !== plan.valueHex) {
						throw new DebugMcpError('INVALID_RESPONSE', 'Peripheral write acknowledgement does not match the approved operation.');
					}
					return { ...approval, evidence: result.evidence, writes: result.writes, userApproved: true, readBackPerformed: false,
						inspectionEpoch: result.inspectionEpoch };
				} catch (error) {
					if (!submitted) { throw error; }
					throw new DebugMcpError('WRITE_OUTCOME_UNKNOWN',
						'The peripheral write may have taken effect; it was not retried. Inspect state before requesting another separately approved write.',
						{ cause: error instanceof Error ? error.message : String(error), ...approval });
				}
			});
		} finally {
			if (prepared && this.sessions.get(id) === entry) {
				const token = prepared.token;
				try {
					await this.bounded(new AbortController().signal, 2000, inner =>
						abortable(entry.session.request('aurix-tcf/mcpRevokePeripheralWrite', { token }), inner));
				} catch (error) { this.host.reportError(error); }
			}
		}
	}

	async readRegisters(id: string, handles: string[], signal: AbortSignal) {
		z.array(z.string()).min(1).max(32).refine(values => new Set(values).size === values.length, 'Use distinct register handles.').parse(handles);
		const entry = this.entry(id);
		const references = handles.map(handle => this.resolveHandle(entry, handle, 'register'));
		const threadId = references[0].threadId;
		if (references.some(reference => reference.threadId !== threadId)) { throw new DebugMcpError('INVALID_CORE', 'One register read cannot mix cores.'); }
		const { result, generation } = await this.inspect(entry, threadId, signal, async request =>
			z.object({ registers: z.array(registerSchema.extend({ bytesHex: z.string().regex(/^[0-9a-f]{8}$/), encoding: z.literal('raw-bytes') })).length(handles.length) })
				.parse(await request('aurix-tcf/mcpRegisters', { registerIds: references.map(reference => reference.id) })));
		if (result.registers.some((register, index) => register.id !== references[index].id || !register.allowed)) {
			throw new DebugMcpError('INVALID_RESPONSE', 'Register response does not match the requested CORE registers.');
		}
		for (const handle of handles) { this.resolveHandle(entry, handle, 'register'); }
		return { sessionId: id, threadId, generation,
			registers: result.registers.map(({ id: _id, ...register }, index) => ({ ...register, registerHandle: handles[index] })) };
	}

	private async exclusive<T>(entry: Entry, kind: Control, signal: AbortSignal, timeoutMs: number, run: (signal: AbortSignal) => Promise<T>): Promise<T> {
		const interrupts = kind === 'pause' || kind === 'stop';
		if ((entry.control || entry.pendingWrites) && !interrupts) {
			throw new DebugMcpError('BUSY', 'Another control operation is pending. Pause or stop can interrupt it.');
		}
		if (entry.control && (entry.control.kind === 'pause' || entry.control.kind === 'stop')) {
			throw new DebugMcpError('BUSY', 'A pause or stop operation is already pending.');
		}
		entry.control?.abort.abort(new DebugMcpError('INTERRUPTED', `Operation interrupted by ${kind}.`));
		const operation = { kind, abort: new AbortController() };
		entry.control = operation;
		const combined = AbortSignal.any([signal, operation.abort.signal]);
		try {
			return await this.bounded(combined, timeoutMs, run);
		} finally {
			if (entry.control === operation) { entry.control = undefined; }
		}
	}

	private async write(entry: Entry, command: string, args: object, signal: AbortSignal, beforeDispatch?: () => void): Promise<unknown> {
		signal.throwIfAborted();
		beforeDispatch?.();
		this.invalidateHandles(entry);
		entry.pendingWrites++;
		const request = Promise.resolve().then(() => {
			signal.throwIfAborted();
			if (entry.control) { entry.control.expectedCommand = command; }
			return entry.session.request(command, args);
		}).finally(() => { entry.pendingWrites--; });
		return abortable(request, signal);
	}

	cancelPending(reason: Error): void {
		this.preparing?.abort(reason);
		for (const entry of this.sessions.values()) { entry.control?.abort.abort(reason); }
	}

	async execute(id: string, threadId: number, command: 'continue' | 'pause' | 'next' | 'stepIn' | 'stepOut', signal: AbortSignal, timeoutMs = 15000) {
		const entry = this.entry(id);
		return this.exclusive(entry, command, signal, timeoutMs, async inner => {
			const before = await this.snapshot(entry, inner);
			const thread = before.threads.find(thread => thread.id === threadId);
			if (!thread) { throw new DebugMcpError('THREAD_NOT_FOUND', 'Use a thread ID returned by debug_status, not a core index.'); }
			if (command !== 'pause' && !thread.suspended) {
				throw new DebugMcpError('THREAD_NOT_STOPPED', 'The selected thread is already running.');
			}
			if (command === 'pause' && before.state === 'stopped') { return { ...before, alreadyStopped: true }; }
			const mark = entry.events.mark();
			await this.write(entry, command, { threadId }, inner);
			const eventName = command === 'continue' ? 'continued' : 'stopped';
			const event = await entry.events.waitFor(eventName, mark, timeoutMs, event =>
				event.body?.threadId === threadId ||
				(command === 'continue' && event.body?.allThreadsContinued === true) ||
				(command === 'pause' && event.body?.allThreadsStopped === true),
				inner);
			const state = await this.controlSnapshot(entry, inner);
			inner.throwIfAborted();
			if (command !== 'continue' && !state.threads.find(thread => thread.id === threadId)?.suspended) {
				throw new DebugMcpError('STATE_CHANGED', 'A stop was observed but the selected core is no longer stopped.');
			}
			if (command === 'pause' && state.state !== 'stopped') {
				throw new DebugMcpError('PAUSE_INCOMPLETE', 'Pause did not stop every core.');
			}
			return { ...state, threadId, event: { name: event.event, reason: event.body?.reason } };
		});
	}

	async stop(id: string, signal: AbortSignal, timeoutMs = 15000) {
		const previous = this.stops.get(id);
		if (previous) {
			return this.bounded(signal, timeoutMs, async inner => ({
				sessionId: id, state: 'terminated', agent: await abortable(previous, inner),
			}));
		}
		const entry = this.sessions.get(id) ?? this.endedSessions.get(id) ?? this.entry(id);
		return this.exclusive(entry, 'stop', signal, timeoutMs, async inner => {
			entry.pendingWrites++;
			const stopping = Promise.resolve().then(() => {
				inner.throwIfAborted();
				return this.host.stopSession(id);
			}).then(agent => {
				if (this.sessions.has(id)) { throw new DebugMcpError('STOP_INCOMPLETE', 'The host did not confirm session termination.'); }
				return agent;
			}).finally(() => { entry.pendingWrites--; });
			this.stops.set(id, stopping);
			void stopping.then(() => { this.stops.delete(id); }, () => { this.stops.delete(id); });
			const agent = await abortable(stopping, inner);
			return { sessionId: id, state: 'terminated', agent };
		});
	}

	listBreakpoints(start = 0, count = 100) {
		const all = this.host.breakpoints();
		return { breakpoints: all.slice(start, start + count), total: all.length, start,
			scope: 'VS Code source breakpoints shared by all debug sessions in this window' };
	}

	async breakpointStatus(id: string, breakpointId: string, signal: AbortSignal) {
		return this.bounded(signal, 10000, async inner => {
			const entry = this.entry(id);
			if (entry.control || entry.pendingWrites || entry.breakpointRequests.size) {
				throw new DebugMcpError('BUSY', 'Wait for pending execution and breakpoint updates before reading evidence.');
			}
			const breakpoint = this.host.breakpoints().find(bp => bp.id === breakpointId);
			if (!breakpoint) { throw new DebugMcpError('BREAKPOINT_NOT_FOUND', 'Use a current VS Code breakpoint ID from debug_breakpoints.'); }
			const expiresAt = Date.now() + 9500;
			const mark = entry.events.mark();
			const before = await this.snapshot(entry, inner);
			const evidence = breakpointEvidenceSchema.parse(await abortable(entry.session.request('aurix-tcf/mcpBreakpointStatus', {
				source: breakpoint.source, line: breakpoint.line, expiresAt,
			}), inner));
			const after = await this.snapshot(entry, inner);
			if (before.generation !== after.generation || JSON.stringify(before.threads) !== JSON.stringify(after.threads) ||
				entry.breakpointRequests.size || entry.events.since(mark, 'breakpointsApplied').length ||
				JSON.stringify(this.host.breakpoints().find(bp => bp.id === breakpointId)) !== JSON.stringify(breakpoint)) {
				throw new DebugMcpError('STATE_CHANGED', 'Execution or the selected UI breakpoint changed during evidence lookup.');
			}
			const threadIds = after.threads.filter(thread => thread.suspended && thread.stop?.breakpointIds?.includes(evidence.nativeId))
				.map(thread => thread.id);
			return { sessionId: id, generation: after.generation, breakpoint, ...evidence,
				currentStop: { evidence: 'RunControl.getState.BPs', association: threadIds.length ? 'reported' : 'unknown', threadIds } };
		});
	}

	async changeBreakpoint(id: string, change: { source: string; line: number } | { breakpointId: string }, signal: AbortSignal, timeoutMs = 10000) {
		const entry = this.entry(id);
		return this.exclusive(entry, 'breakpoint', signal, timeoutMs, async inner => {
			const adding = 'source' in change;
			let breakpoint: SourceBreakpoint;
			if (adding) {
				await abortable(this.host.validateSource(change.source), inner);
				const existing = this.host.breakpoints().find(bp => sourceKey(bp.source) === sourceKey(change.source) && bp.line === change.line);
				if (existing) { return { breakpoint: existing, status: 'alreadyPresent', verified: 'unknown', locationEvidence: 'not-queried' }; }
				inner.throwIfAborted();
				breakpoint = { id: '', source: change.source, line: change.line, column: 1, enabled: true };
			} else {
				const existing = this.host.breakpoints().find(bp => bp.id === change.breakpointId);
				if (!existing) { throw new DebugMcpError('BREAKPOINT_NOT_FOUND', 'The source breakpoint no longer exists.'); }
				breakpoint = existing;
			}
			const mark = entry.events.mark();
			if (adding) {
				breakpoint = this.host.addBreakpoint(breakpoint.source, breakpoint.line);
			} else {
				this.host.removeBreakpoint(breakpoint.id);
			}
			const fileBreakpoints = () => this.host.breakpoints().filter(bp => sourceKey(bp.source) === sourceKey(breakpoint.source));
			const expectedUi = JSON.stringify(fileBreakpoints());
			const expectedLines = fileBreakpoints().filter(bp => bp.enabled).map(bp => bp.line).sort((a, b) => a - b);
			try {
				const applied = await entry.events.waitFor('breakpointsApplied', mark, timeoutMs, event => {
					const request: BreakpointRequest['arguments'] = event.body.request;
					return sourceKey(request.source.path) === sourceKey(breakpoint.source) &&
						JSON.stringify(request.breakpoints.map(bp => bp.line).sort((a, b) => a - b)) === JSON.stringify(expectedLines);
				}, inner);
				if (JSON.stringify(fileBreakpoints()) !== expectedUi) {
					throw new DebugMcpError('STATE_CHANGED', 'VS Code breakpoints changed while waiting for confirmation.');
				}
				const response: z.infer<typeof responseSchema> = applied.body.response;
				if (!response.success) { throw new DebugMcpError('DAP_ERROR', response.message ?? 'The adapter rejected the breakpoint update.'); }
				if (!adding) { return { breakpoint, status: 'removed' }; }
				const request: BreakpointRequest['arguments'] = applied.body.request;
				const index = request.breakpoints.findIndex(bp => bp.line === breakpoint.line);
				const actual = response.body?.breakpoints?.[index];
				if (!actual) { throw new DebugMcpError('DAP_ERROR', 'The adapter did not return the requested breakpoint.'); }
				return { breakpoint, status: actual.verified ? 'verified' : 'unverified', adapter: actual,
					confirmation: 'dap-response', locationEvidence: 'not-queried' };
			} catch (error) {
				throw new DebugMcpError('BREAKPOINT_UNCONFIRMED',
					`The VS Code breakpoint was ${adding ? 'added' : 'removed'}, but adapter confirmation failed: ${error instanceof Error ? error.message : String(error)}. Do not automatically repeat the change.`,
					{ breakpointId: breakpoint.id, uiChanged: true });
			}
		});
	}
}
