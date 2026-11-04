import { randomBytes, randomUUID, timingSafeEqual } from 'crypto';
import * as http from 'http';
import { McpServer, createMcpHandler, isLegacyRequest, type CallToolResult, type McpHttpHandler } from '@modelcontextprotocol/server';
import { NodeStreamableHTTPServerTransport, toNodeHandler, toWebRequest, type NodeMcpRequestHandler } from '@modelcontextprotocol/node';
import { z } from 'zod';
import { prepareOptionsSchema } from './prepare';
import { DebugController, DebugMcpError, observationSchema } from './debugController';
import { launchOptionsSchema } from './launch';
import { memoryReadSchema } from '../memoryInspection';
import { globalLookupSchema } from '../variables/globals';

const MAX_BODY_BYTES = 64 * 1024;
const MAX_RESULT_BYTES = 256 * 1024;
const MAX_CLIENTS = 8;
const MAX_REQUESTS = 16;
const CLIENT_IDLE_MS = 15 * 60 * 1000;
const sessionId = z.string().min(1).max(128);
const threadId = z.number().int().positive();
const timeoutMs = z.number().int().min(100).max(60000).default(15000);
const sessionArgs = z.object({ sessionId }).strict();
const executionArgs = z.object({ sessionId, threadId, timeoutMs }).strict();
const inspectionHandle = z.string().uuid();

async function toolResult(run: () => Promise<object> | object, log: (message: string) => void): Promise<CallToolResult> {
	try {
		const result = await run();
		const text = JSON.stringify(result);
		if (Buffer.byteLength(text) > MAX_RESULT_BYTES) {
			throw new DebugMcpError('RESULT_TOO_LARGE', 'The result exceeds 256 KiB. Request fewer frames or reduce the breakpoint list.');
		}
		return { content: [{ type: 'text', text }], structuredContent: { ...result } };
	} catch (error) {
		const code = error instanceof DebugMcpError ? error.code : 'DEBUG_ERROR';
		const message = error instanceof Error ? error.message : String(error);
		log(`${code}: ${message}`);
		const result = { code, message, ...(error instanceof DebugMcpError ? error.details : {}) };
		return { isError: true, content: [{ type: 'text', text: JSON.stringify(result) }], structuredContent: result };
	}
}

function createMcpServer(controller: DebugController, version: string, log: (message: string) => void): McpServer {
	const server = new McpServer({ name: 'aurix-debug-mcp', version }, {
		instructions: 'Control AURIX sessions in this VS Code window, including UI-created sessions. Call debug_sessions first. If no session exists, debug_prepare can discover/validate ELF, DAS and SVD without launching; resolve needs-input explicitly, never choose the first ambiguous candidate. Its CPU0 default is unprobed and launchArguments are advisory, not permission to start or evidence of flashed firmware. Use debug_start only if no session exists, with an explicitly supplied workspace, built ELF, actual DAS device name and TriCore index. It never builds or runs launch tasks. Every new MCP session requires flashing and Agent -f, even after another tool has flashed the target. There is no flash input: both flash:true and flash:false are rejected before launch. Obtain authorization for programming this ELF/device, including the existing full-erase retry if the first flasher attempt fails. This reuses the UI flasher/download flow. A workflow may build and flash through AURIX MCP, then optionally flash again and debug through Debug MCP. If programming is forbidden or a fault scene must be preserved, do not call debug_start: reuse an existing suitable session or ask the user about a manual UI startup. Do not silently remove a rejected no-flash argument and retry with programming. entryFunction is unset by default; setting it requests Agent -e but does not disable flashing. Verify actual PC/stack, not just the requested function. Startup failures include phase and flash evidence: a completed flasher does not imply successful Agent startup or a verified firmware image. A launch can reset/run hardware before it is paused. Use returned sessionId and actual thread IDs, not core indices. Source breakpoints are shared with the VS Code UI. Do not retry execution or launch after uncertainty: inspect debug_sessions, then pause or debug_stop. Await debug_stop agent.agentReleased before separate flashing; external agents must be released separately. Physical DAS exclusivity is not probed. For locals use debug_stack frameHandle -> debug_scopes variablesHandle -> debug_variables. Prefer debug_observe for a bounded batch of known global/file-static identifiers with source qualifiers and exact peripheral names; it re-resolves metadata and returns values plus final core state without reusing handles or changing execution. On batch failure report the error; do not automatically retry or bypass a safety rejection with other tools. For global symbol discovery or individual reads use debug_global_variables with an exact name -> select the matching source/address candidate -> debug_read_global_variable with symbolHandle. Never pick the first same-name static automatically. Expand a captured global struct/array with debug_variables. Symbol lookup reads metadata only, missing/optimized-out symbols stay explicit; do not guess addresses or use source constants as runtime values. For CORE registers use debug_registers -> debug_read_registers. debug_read_memory is limited to readable ELF-backed ranges. Peripheral access shares the manual Viewer full SVD and native Registers implementation: debug_peripheral_registers -> debug_read_peripheral_registers, or debug_write_peripheral_register for exactly one whole-register write. Every peripheral write requires a fresh Debugger-hosted user confirmation; client always-allow settings cannot bypass it. Declined/cancelled approvals are not reusable. After a write failure or timeout, the outcome may be unknown: never automatically retry. No implicit read-modify-write or verification reads. Never use memory reads to bypass peripheral permissions/read-side-effect guards. Handles are session/execution-bound; obtain new ones after execution changes or writes. All data access requires all cores stopped and is not atomic with DMA/peripherals. Unavailable values are errors, never zeros. No arbitrary evaluate, pointer dereference, core-register writes, arbitrary-memory writes, standalone flashing/reset tool or arbitrary DAP is exposed.',
	});
	const read = { readOnlyHint: true, destructiveHint: false, openWorldHint: false };
	const control = { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false };
	server.registerTool('debug_sessions', {
		description: 'List existing AURIX debug sessions in this window. Does not create or connect to a new target.',
		inputSchema: z.object({}).strict(), annotations: read,
	}, () => toolResult(() => controller.listSessions(), log));
	server.registerTool('debug_prepare', {
		description: 'Read-only startup discovery and validation, never a launch. Prefer existing sessions: returns their metadata without DAP or device probes. Otherwise select an open workspace, scan bounded .elf candidates (or validate an explicit program), enumerate actual DAS names with bundled lsmcdd and validate the automatically matched SVD. No tasks, builds, flashing, settings writes, TCF connections or target memory/register access. A unique valid ELF/device/SVD yields advisory launchArguments for debug_start, not automatic execution or authorization. Multiple candidates/incomplete discovery require explicit selection. Core defaults to CPU0, explicitly unprobed; ELF hash does not verify loaded firmware. Optional inputs are literal absolute workspace/program paths, exact DAS targetDevice and TriCore index 0..5. The overall deadline defaults to 30 seconds; explicitly set timeoutMs up to 120000 for large SVDs such as TC4D. timeoutMs applies only to preparation, not launch. Failures include preparation.stage, timings and diagnostic-only partial findings: report them, do not infer the stalled stage, start a session or automatically retry.',
		inputSchema: prepareOptionsSchema.extend({ timeoutMs: z.number().int().min(100).max(120000).default(30000) }), annotations: read,
	}, ({ timeoutMs, ...options }, ctx) => toolResult(() => controller.prepare(options, ctx.mcpReq.signal, timeoutMs), log));
	server.registerTool('debug_start', {
		description: 'Start one shared VS Code AURIX session with mandatory flashing and Agent -f. No flash parameter is accepted, including true or false. Requires an open absolute workspaceFolder, existing built ELF inside it, exact DAS targetDevice name (not a board model/numeric ID) and TriCore core 0..5. Startup programs the ELF even if another tool already flashed it, using the UI flasher and Agent download path, including one full-erase retry on flasher failure. Obtain programming authorization for this ELF/device before starting. If reprogramming is forbidden, reuse an existing suitable session or ask the user about manual UI startup; do not call this tool. entryFunction is unset by default; an optional value (e.g. core0_main) passes Agent -e but does not disable flashing or verify the final location. No builds, tasks, saved launch configuration or arbitrary Agent arguments. Refuses existing/pending sessions. Waits for selected-core stopped evidence and fresh all-core stopped state; entryLocationVerified and firmwareMatchVerified remain false. Returns actual startup.stage, flashStatus, flashAttempts, eraseAllRetried, agentReady and flashPerformed (null means uncertain/possibly partial). Flasher completion is not Agent readiness or image verification. Overall timeout defaults to 180 seconds; optional timeoutMs up to 600000 does not change the separate 15-second Agent port-readiness limit. On failure, do not repeat flashing/launch automatically; inspect debug_sessions. An in-flight flasher may still be running after cancellation/timeout; wait for its launch reservation to settle before recovery.',
		inputSchema: launchOptionsSchema.extend({ timeoutMs: z.number().int().min(100).max(600000).optional() }),
		annotations: control,
	}, ({ timeoutMs, ...options }, ctx) => toolResult(() => controller.start(options, ctx.mcpReq.signal, timeoutMs), log));
	server.registerTool('debug_status', {
		description: 'Read fresh native core states and instruction-stepping mode. Stopped threads include stop evidence from RunControl.getState: native reason, current instructionPointerReference (or null with pcUnavailable), and optional native breakpointIds. Missing reason/IDs mean unknown, not no breakpoint. Running threads have no current-stop evidence. Thread IDs are not core indices.',
		inputSchema: sessionArgs, annotations: read,
	}, (args, ctx) => toolResult(() => controller.status(args.sessionId, ctx.mcpReq.signal), log));
	server.registerTool('debug_stack', {
		description: 'Read at most 100 stack frames of a stopped thread. Frame IDs are temporary; execution invalidates them.',
		inputSchema: z.object({ sessionId, threadId, levels: z.number().int().min(1).max(100).default(20) }).strict(),
		annotations: read,
	}, (args, ctx) => toolResult(() => controller.stack(args.sessionId, args.threadId, args.levels, ctx.mcpReq.signal), log));
	server.registerTool('debug_scopes', {
		description: 'Return local-variable scopes for a frameHandle returned by debug_stack. Requires all cores stopped. Raw DAP frame IDs and handles from another session or execution generation are rejected. CORE registers use separate tools.',
		inputSchema: sessionArgs.extend({ frameHandle: inspectionHandle }), annotations: read,
	}, (args, ctx) => toolResult(() => controller.scopes(args.sessionId, args.frameHandle, ctx.mcpReq.signal), log));
	server.registerTool('debug_variables', {
		description: 'Read a page of at most 100 locals/children using variablesHandle from debug_scopes, debug_read_global_variable or debug_variables. Agent-discovered locals accept plain names or exact TCF ${SymbolID} references; this is not arbitrary expression evaluation. Values are limited to 4096 bytes per root variable. Struct/array children expand lazily from captured bytes, not new target reads; pointers are shown but never dereferenced. Unreadable locals report unavailable, not a fabricated value. Local metadata-policy rejections also include unavailableCode and bounded unavailableDetails. For global/file-static roots first use debug_global_variables then debug_read_global_variable. No arbitrary expressions.',
		inputSchema: sessionArgs.extend({
			variablesHandle: inspectionHandle, start: z.number().int().min(0).max(1000000).default(0),
			count: z.number().int().min(1).max(100).default(20),
		}), annotations: read,
	}, (args, ctx) => toolResult(() => controller.variables(args.sessionId, args.variablesHandle, args.start, args.count, ctx.mcpReq.signal), log));
	server.registerTool('debug_global_variables', {
		description: 'Look up an exact C identifier (e.g. g_fadeValue or g_atomConfig) in native global symbol tables, independent of the current stack frame. Includes file-static variables from other compilation units. Optional source is a compilation-unit name/path suffix, e.g. Blinky_LED.c; no source file is read. Returns up to 64 candidates with source/type/storage metadata and execution-bound symbolHandle when readable; no variable values are read. Multiple same-name symbols remain separate: select by source/address or ask the user, never pick the first. Unknown source/scope is reported, not inferred. Requires all cores stopped and a selected ELF. Missing type/storage, optimized-out/unavailable variables and non-data symbols are explicit; no expression fallback or guessed addresses.',
		inputSchema: globalLookupSchema.extend({ sessionId, threadId }), annotations: read,
	}, ({ sessionId, threadId, ...query }, ctx) => toolResult(() => controller.globals(sessionId, threadId, query, ctx.mcpReq.signal), log));
	server.registerTool('debug_observe', {
		description: 'Prefer this read-only batch for repeated observations of known globals/file-statics and peripheral registers. Select up to 8 exact global identifiers with optional source suffixes and/or 32 distinct exact SVD register names. No handles needed: re-resolves metadata on every call, rejects ambiguous/missing or catalog-disallowed selections before value reads, and revalidates native identities and read permissions when reading. Use the existing catalog tools first only when names/source selection are unknown. All cores must remain stopped in one inspection generation; returns fresh final core state, ordered globals and peripherals, raw bytes and evidence. Global structs/arrays return a captured-byte variablesHandle for debug_variables. One 10-second overall deadline; any failure rejects the whole observation, without partial values, automatic retries or zero defaults. Not an atomic snapshot with DMA/peripherals; constants are labeled, ELF hash is not firmware-match proof. Never continues, pauses, writes, polls, evaluates expressions or dereferences pointers.',
		inputSchema: observationSchema.safeExtend({ sessionId, threadId }), annotations: read,
	}, ({ sessionId, threadId, ...query }, ctx) => toolResult(() => controller.observe(sessionId, threadId, query, ctx.mcpReq.signal), log));
	server.registerTool('debug_read_global_variable', {
		description: 'Read one global/file-static variable selected by symbolHandle from debug_global_variables. Revalidates exact native symbol ID/name/source/type/address/size and ELF hash. Reads at most 4096 bytes from bounded ELF-backed RAM/flash through the existing Memory.get connection, never MMIO. Native constant values are labeled storage=constant and are not runtime memory measurements. Returns typed display, bytesHex, size, byteOrder and evidence; structs/arrays get variablesHandle for debug_variables captured-byte expansion. Pointer values are displayed but never dereferenced. All cores must stay stopped. Stale handles, changed ELF/metadata, invalid or partial values fail explicitly; no zeros, arbitrary expressions, writes or retry. ELF hash is local artifact identity, not firmware-match proof.',
		inputSchema: sessionArgs.extend({ symbolHandle: inspectionHandle }), annotations: read,
	}, (args, ctx) => toolResult(() => controller.readGlobal(args.sessionId, args.symbolHandle, ctx.mcpReq.signal), log));
	server.registerTool('debug_registers', {
		description: 'List metadata of the selected thread CORE registers without reading values. Only explicitly recognized CORE groups are traversed; no peripheral fallback. Allowed 32-bit architectural registers have a registerHandle for debug_read_registers. All cores must be stopped.',
		inputSchema: sessionArgs.extend({ threadId }), annotations: read,
	}, (args, ctx) => toolResult(() => controller.registers(args.sessionId, args.threadId, ctx.mcpReq.signal), log));
	server.registerTool('debug_read_memory', {
		description: 'Read 1..4096 bytes at an explicit hexadecimal address using the existing connection. Requires all cores stopped and a valid thread. Only readable ELF PT_LOAD ranges intersecting 0x30000000..0x9fffffff are allowed; no MMIO, local/uncached aliases or unmapped gaps. Rejects the entire result on unreadable/short data or an execution change; no zero padding or retry. Returns raw bytes, not inferred values. Address validity does not verify firmware identity or atomicity with DMA.',
		inputSchema: memoryReadSchema.extend({ sessionId, threadId }), annotations: read,
	}, (args, ctx) => toolResult(() => controller.readMemory(args.sessionId, args.threadId, args.address, args.count, ctx.mcpReq.signal), log));
	server.registerTool('debug_peripheral_registers', {
		description: 'Page the full matching SVD catalog, optionally filtering by register-name substring (e.g. GTM_ATOM0_CH4 or P00). All cores must be stopped. Returns execution-bound handles and SVD permissions/width/readAction metadata only: no native value read and no claim the backend supports every entry. writable describes SVD permission; backend Writeable is checked before confirmation and again before writing. allowed means eligible for automatic reading; readAction/write-only entries remain visible but are not automatically read. Widths up to 8 bytes are supported. No fixed 674-register whitelist in auto mode; an explicitly selected legacy profile remains read-only. At most 4096 distinct inspection handles per execution; use filters rather than enumerating everything.',
		inputSchema: sessionArgs.extend({ threadId, start: z.number().int().min(0).max(131072).default(0),
			count: z.number().int().min(1).max(100).default(20), filter: z.string().max(128).default('') }), annotations: read,
	}, (args, ctx) => toolResult(() => controller.peripherals(args.sessionId, args.threadId, ctx.mcpReq.signal,
		{ start: args.start, count: args.count, filter: args.filter }), log));
	server.registerTool('debug_read_peripheral_registers', {
		description: 'Read 1..32 selected peripheral handles from one core via the shared native TCF Registers.get implementation, never Memory.get. Uses the same SVD/native readability and read-side-effect guards as the manual Viewer. Verifies identity, width (1..8 bytes) and any reported address. Rejects ReadOnce/readAction/unreadable/mismatched registers and stale handles. bytesHex is raw native byte order; use byteOrder and size to decode. No writes, polling or automatic retries. Peripherals may keep running while CPUs are stopped.',
		inputSchema: sessionArgs.extend({ registerHandles: z.array(inspectionHandle).min(1).max(32) }), annotations: read,
	}, (args, ctx) => toolResult(() => controller.readPeripherals(args.sessionId, args.registerHandles, ctx.mcpReq.signal), log));
	server.registerTool('debug_write_peripheral_register', {
		description: 'Request exactly one whole-register peripheral write using a registerHandle from debug_peripheral_registers and an unsigned decimal or hexadecimal value STRING, e.g. "50" or "0x32". Requires all cores stopped and valid SVD/native write permission. The Debugger always displays device/session/core/register/address/value in a modal; only an explicit Write once authorizes the operation (up to 120 seconds). Client approvals or approved:true cannot bypass it. Denial/cancellation/state/target/configuration changes invalidate approval. Uses one Registers.set without old-value read, RMW, verification read or automatic retry. Failure/timeout after dispatch may mean the write occurred: never repeat automatically. Successful writes invalidate all inspection handles. Does not write CORE registers or arbitrary memory.',
		inputSchema: sessionArgs.extend({ registerHandle: inspectionHandle, value: z.string().max(128).regex(/^(?:0x[0-9a-f]+|[0-9]+)$/i) }),
		annotations: control,
	}, (args, ctx) => toolResult(() => controller.writePeripheral(args.sessionId, args.registerHandle, args.value, ctx.mcpReq.signal), log));
	server.registerTool('debug_read_registers', {
		description: 'Read 1..32 distinct allowed CORE registers from one core using registerHandles returned by debug_registers. Revalidates metadata; rejects ReadOnce, unreadable, non-32-bit and non-allowlisted registers. Uses TCF Registers.get, never Memory.get. bytesHex is raw byte order, not an endian-decoded numeric value. CORE register writes are not exposed.',
		inputSchema: sessionArgs.extend({ registerHandles: z.array(inspectionHandle).min(1).max(32) }), annotations: read,
	}, (args, ctx) => toolResult(() => controller.readRegisters(args.sessionId, args.registerHandles, ctx.mcpReq.signal), log));
	server.registerTool('debug_continue', {
		description: 'Continue the selected stopped thread. Wait for a continued event and return fresh state, not the next breakpoint. A fast breakpoint can already have stopped the target again. If execution events race the final state query, only that read is resampled within timeoutMs; continue is never resent. event describes the acknowledged continued event; state and threads[].stop describe the later native snapshot. UI interference, cancellation and timeouts still fail explicitly.',
		inputSchema: executionArgs, annotations: control,
	}, (args, ctx) => toolResult(() => controller.execute(args.sessionId, args.threadId, 'continue', ctx.mcpReq.signal, args.timeoutMs), log));
	server.registerTool('debug_pause', {
		description: 'Pause all cores using the existing debugger behavior, with the selected thread as focus. Can interrupt a pending step. Verify all cores stopped before returning.',
		inputSchema: executionArgs, annotations: control,
	}, (args, ctx) => toolResult(() => controller.execute(args.sessionId, args.threadId, 'pause', ctx.mcpReq.signal, args.timeoutMs), log));
	server.registerTool('debug_step', {
		description: 'Step a stopped thread and wait for its stop event and fresh stopped state. Uses the current VS Code instruction/source stepping mode. The actual stop reason can be a user breakpoint.',
		inputSchema: executionArgs.extend({ mode: z.enum(['over', 'in', 'out']) }), annotations: control,
	}, (args, ctx) => toolResult(() => controller.execute(args.sessionId, args.threadId,
		args.mode === 'over' ? 'next' : args.mode === 'in' ? 'stepIn' : 'stepOut', ctx.mcpReq.signal, args.timeoutMs), log));
	server.registerTool('debug_stop', {
		description: 'End the selected VS Code session and await owned Agent process exit and TCP port closure. Returns agent.agentReleased=false for external agents; physical DAS exclusivity is not probed. This is not a CPU pause and does not guarantee the target stays halted. If the caller times out, shutdown continues; call debug_stop with the same ID to wait for it, not debug_start or flash.',
		inputSchema: sessionArgs.extend({ timeoutMs }), annotations: control,
	}, (args, ctx) => toolResult(() => controller.stop(args.sessionId, ctx.mcpReq.signal, args.timeoutMs), log));
	server.registerTool('debug_breakpoints', {
		description: 'List source breakpoints from the VS Code UI, including user-created breakpoints. This list is window-wide, not session-local.',
		inputSchema: z.object({
			start: z.number().int().min(0).default(0), count: z.number().int().min(1).max(200).default(100),
		}).strict(), annotations: read,
	}, (args) => toolResult(() => controller.listBreakpoints(args.start, args.count), log));
	server.registerTool('debug_breakpoint_status', {
		description: 'Read native evidence for one current VS Code source breakpoint ID in a selected session, without modifying breakpoints or execution. Returns requested breakpoint separately from Breakpoints.getStatus installed instances, reported addresses/counts/errors and bounded LineNumbers.mapToSource results. DAP verified and its line are not actual-location proof. resolution describes installation, not source-map success or a future hit. reportedHitCount is not proof of this stop; currentStop association uses fresh RunControl.getState.BPs and is unknown when not reported. Works while running, but rejects execution/breakpoint changes during lookup. Do not use raw native or adapter IDs.',
		inputSchema: sessionArgs.extend({ breakpointId: z.string().min(1).max(128) }), annotations: read,
	}, (args, ctx) => toolResult(() => controller.breakpointStatus(args.sessionId, args.breakpointId, ctx.mcpReq.signal), log));
	server.registerTool('debug_add_breakpoint', {
		description: 'Add a source breakpoint through VS Code without replacing other breakpoints. source must be an absolute existing file inside this workspace; line is 1-based. Existing breakpoints on that line are preserved unchanged. confirmation=dap-response and locationEvidence=not-queried: verified does not establish the actual installed address/line. Use debug_breakpoint_status with the returned breakpoint.id for native installation evidence.',
		inputSchema: sessionArgs.extend({ source: z.string().min(1).max(4096), line: z.number().int().min(1).max(10000000), timeoutMs }),
		annotations: control,
	}, (args, ctx) => toolResult(() => controller.changeBreakpoint(args.sessionId,
		{ source: args.source, line: args.line }, ctx.mcpReq.signal, args.timeoutMs), log));
	server.registerTool('debug_remove_breakpoint', {
		description: 'Remove exactly one source breakpoint by its VS Code breakpoint ID. The UI change is window-wide. Never clears other breakpoints.',
		inputSchema: sessionArgs.extend({ breakpointId: z.string().min(1).max(128), timeoutMs }), annotations: control,
	}, (args, ctx) => toolResult(() => controller.changeBreakpoint(args.sessionId,
		{ breakpointId: args.breakpointId }, ctx.mcpReq.signal, args.timeoutMs), log));
	return server;
}

class HttpError extends Error {
	constructor(readonly status: number, message: string) { super(message); }
}

function readBody(request: http.IncomingMessage): Promise<unknown> {
	if (!/^application\/json(?:;|$)/i.test(request.headers['content-type'] ?? '')) {
		return Promise.reject(new HttpError(415, 'Content-Type must be application/json.'));
	}
	if (Number(request.headers['content-length']) > MAX_BODY_BYTES) {
		return Promise.reject(new HttpError(413, 'Request exceeds 64 KiB.'));
	}
	return new Promise((resolve, reject) => {
		const chunks: Buffer[] = [];
		let length = 0;
		const cleanup = () => {
			request.off('data', data);
			request.off('end', end);
			request.off('error', fail);
			request.off('aborted', aborted);
		};
		const fail = (error: Error) => { cleanup(); reject(error); };
		const aborted = () => fail(new HttpError(400, 'Request aborted.'));
		const data = (chunk: Buffer) => {
			length += chunk.length;
			if (length > MAX_BODY_BYTES) {
				fail(new HttpError(413, 'Request exceeds 64 KiB.'));
				return;
			}
			chunks.push(chunk);
		};
		const end = () => {
			cleanup();
			try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8'))); }
			catch { reject(new HttpError(400, 'Invalid JSON.')); }
		};
		request.on('data', data);
		request.once('end', end);
		request.once('error', fail);
		request.once('aborted', aborted);
	});
}

type Client = {
	server: McpServer;
	transport: NodeStreamableHTTPServerTransport;
	lastUsed: number;
	active: number;
};

export class DebugMcpHttpServer {
	readonly token = randomBytes(32).toString('hex');
	private readonly clients = new Map<string, Client>();
	private readonly http: http.Server;
	private readonly modern: McpHttpHandler;
	private readonly handleModern: NodeMcpRequestHandler;
	private readonly expiry: NodeJS.Timeout;
	private requests = 0;
	private closing?: Promise<void>;
	private address?: string;

	constructor(
		private readonly controller: DebugController,
		private readonly version: string,
		private readonly allowed: () => boolean,
		private readonly log: (message: string) => void,
	) {
		this.modern = createMcpHandler(() => createMcpServer(this.controller, this.version, this.log), {
			legacy: 'reject', responseMode: 'auto', maxRequestBodySize: MAX_BODY_BYTES, maxSubscriptions: 0,
			onerror: error => this.log(`MCP protocol: ${error.message}`),
		});
		this.handleModern = toNodeHandler(this.modern, {
			maxRequestBodySize: MAX_BODY_BYTES, onerror: error => this.log(`MCP transport: ${error.message}`),
		});
		this.http = http.createServer((request, response) => {
			void this.handle(request, response).catch(error => {
				this.log(`HTTP: ${error instanceof Error ? error.message : String(error)}`);
				if (!response.headersSent && !response.destroyed) {
					this.reply(response, error instanceof HttpError ? error.status : 500,
						error instanceof HttpError ? error.message : 'MCP request failed. See AURIX Debug MCP output.');
				} else { response.destroy(); }
			});
		});
		this.http.headersTimeout = 10000;
		this.http.requestTimeout = 70000;
		this.http.keepAliveTimeout = 5000;
		this.http.maxConnections = 32;
		this.http.on('error', error => this.log(`HTTP listener: ${error.message}`));
		this.expiry = setInterval(() => {
			for (const [id, client] of this.clients) {
				if (client.active === 0 && Date.now() - client.lastUsed > CLIENT_IDLE_MS) {
					void this.removeClient(id).catch(error => this.log(`Client cleanup: ${String(error)}`));
				}
			}
		}, 60000);
		this.expiry.unref();
	}

	get url(): string {
		if (!this.address) { throw new Error('MCP server is not listening.'); }
		return this.address;
	}

	async listen(): Promise<void> {
		if (this.address || this.closing) { throw new Error('MCP server cannot be started twice.'); }
		await new Promise<void>((resolve, reject) => {
			this.http.once('error', reject);
			this.http.listen(0, '127.0.0.1', () => {
				this.http.off('error', reject);
				resolve();
			});
		});
		const address = this.http.address();
		if (!address || typeof address === 'string') { throw new Error('Missing loopback listener address.'); }
		this.address = `http://127.0.0.1:${address.port}/mcp`;
	}

	private reply(response: http.ServerResponse, status: number, message: string): void {
		response.writeHead(status, { 'Content-Type': 'application/json', 'Connection': 'close' });
		response.end(JSON.stringify({ jsonrpc: '2.0', id: null, error: { code: -32000, message } }));
	}

	private async handle(request: http.IncomingMessage, response: http.ServerResponse): Promise<void> {
		if (this.closing || !this.allowed()) { throw new HttpError(403, 'Debug MCP is disabled or this workspace is not trusted.'); }
		const endpoint = new URL(this.url);
		if (request.headers.host !== endpoint.host ||
			(request.headers.origin !== undefined && request.headers.origin !== endpoint.origin)) {
			throw new HttpError(403, 'Host or Origin is not allowed.');
		}
		const supplied = Buffer.from(request.headers.authorization ?? '');
		const expected = Buffer.from(`Bearer ${this.token}`);
		if (supplied.length !== expected.length || !timingSafeEqual(supplied, expected)) {
			throw new HttpError(401, 'Invalid window credential.');
		}
		if (request.url !== '/mcp') { throw new HttpError(404, 'Unknown endpoint.'); }
		if (request.method !== 'POST' && request.method !== 'DELETE') {
			response.setHeader('Allow', 'POST, DELETE');
			throw new HttpError(405, 'Use MCP Streamable HTTP POST. Standalone SSE is not provided.');
		}
		if (this.requests >= MAX_REQUESTS + 2) { throw new HttpError(429, 'Too many pending MCP requests.'); }
		this.requests++;
		let client: Client | undefined;
		let newId: string | undefined;
		try {
			const body = request.method === 'POST' ? await readBody(request) : undefined;
			const recovery = request.method === 'DELETE' ||
				z.object({ method: z.literal('notifications/cancelled') }).safeParse(body).success ||
				z.object({ method: z.literal('tools/call'), params: z.object({ name: z.enum(['debug_pause', 'debug_stop']) }) }).safeParse(body).success;
			if (this.requests > MAX_REQUESTS && !recovery) { throw new HttpError(429, 'Too many pending MCP requests.'); }
			const probe = await toWebRequest(request, body, { maxRequestBodySize: MAX_BODY_BYTES });
			if (!await isLegacyRequest(probe, body, { maxRequestBodySize: MAX_BODY_BYTES })) {
				await this.handleModern(request, response, body);
				return;
			}
			const id = request.headers['mcp-session-id'];
			if (typeof id === 'string') {
				client = this.clients.get(id);
				if (!client) { throw new HttpError(404, 'MCP connection expired; initialize again. The hardware session is unchanged.'); }
			} else {
				if (id !== undefined || !z.object({ method: z.literal('initialize') }).safeParse(body).success) {
					throw new HttpError(400, 'Initialize an MCP connection first.');
				}
				if (this.clients.size >= MAX_CLIENTS) { throw new HttpError(429, 'Too many MCP clients.'); }
				newId = randomUUID();
				const clientId = newId;
				const server = createMcpServer(this.controller, this.version, this.log);
				const transport = new NodeStreamableHTTPServerTransport({
					sessionIdGenerator: () => clientId,
					enableJsonResponse: true,
					onsessionclosed: () => this.removeClient(clientId),
				});
				client = { server, transport, lastUsed: Date.now(), active: 0 };
				this.clients.set(clientId, client);
				await server.connect(transport);
			}
			client.active++;
			client.lastUsed = Date.now();
			await client.transport.handleRequest(request, response, body);
		} finally {
			this.requests--;
			if (client) { client.active = Math.max(0, client.active - 1); client.lastUsed = Date.now(); }
			if (newId && !client?.transport.sessionId) { await this.removeClient(newId); }
		}
	}

	private async removeClient(id: string): Promise<void> {
		const client = this.clients.get(id);
		this.clients.delete(id);
		await client?.server.close();
	}

	close(): Promise<void> {
		if (!this.closing) {
			clearInterval(this.expiry);
			this.closing = (async () => {
				const closed = new Promise<void>((resolve, reject) => this.http.close(error => {
					if (error && 'code' in error && error.code !== 'ERR_SERVER_NOT_RUNNING') { reject(error); } else { resolve(); }
				}));
				this.http.closeAllConnections();
				const results = await Promise.allSettled([
					this.modern.close(), ...[...this.clients.keys()].map(id => this.removeClient(id)),
				]);
				for (const result of results) {
					if (result.status === 'rejected') { this.log(`MCP client shutdown failed: ${String(result.reason)}`); }
				}
				await closed;
			})();
		}
		return this.closing;
	}
}
