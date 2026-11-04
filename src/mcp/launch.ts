import * as path from 'path';
import { promises as fs } from 'fs';
import { z } from 'zod';
import { DebugMcpError, validateWorkspaceSource } from './debugController';
import { peripheralProfileName } from '../peripheralProfile';

const literal = z.string().min(1).max(4096).refine(value => !/[\x00-\x1f]|\$\{/.test(value), 'Use literal values, not VS Code substitutions or control characters.');
export const launchOptionsSchema = z.object({
	workspaceFolder: literal,
	program: literal,
	targetDevice: literal.max(256).refine(value => value === value.trim() && !/^\d+$/.test(value), 'Use the exact DAS device name, not a board model or numeric ID.'),
	core: z.number().int().min(0).max(5),
	entryFunction: z.string().min(1).max(256).regex(/^[A-Za-z_][A-Za-z0-9_]*$/).optional()
		.describe('Optional exact C function identifier passed to the Agent as -e, e.g. core0_main. Startup always flashes and passes -f, with or without this option. Requested location only; inspect actual PC/stack after startup.'),
	peripheralReadProfile: z.enum(['auto', 'disabled', peripheralProfileName]).optional().describe('MCP-only policy: auto shares the full matching SVD with the manual Viewer, preserving access/read-side-effect guards and requiring individual user approval for each write. disabled blocks MCP peripheral access; explicit legacy profile remains four-register read-only. No effect on manual access or flashing.'),
}).strict();
export type DebugLaunchOptions = z.input<typeof launchOptionsSchema>;
export type DebugStartStage = 'configuration' | 'device-validation' | 'flashing' | 'agent-startup' | 'adapter-startup' | 'waiting-for-stop' | 'stopped';
export type DebugStartProgress = {
	stage: DebugStartStage;
	flashStatus: 'not-requested' | 'pending' | 'running' | 'completed' | 'failed';
	flashAttempts: number;
	eraseAllRetried: boolean;
	agentReady: boolean;
};

export async function createMcpLaunchConfiguration(options: DebugLaunchOptions, roots: readonly string[], launchId: string) {
	const input = launchOptionsSchema.parse(options);
	if (!path.isAbsolute(input.workspaceFolder) || !roots.some(root => path.relative(root, input.workspaceFolder) === '')) {
		throw new DebugMcpError('INVALID_WORKSPACE', 'workspaceFolder must be the absolute path of an open local workspace folder.');
	}
	await validateWorkspaceSource(input.program, [input.workspaceFolder]);
	const file = await fs.open(input.program, 'r');
	try {
		const header = Buffer.alloc(4);
		const { bytesRead } = await file.read(header, 0, header.length, 0);
		if (bytesRead !== 4 || !header.equals(Buffer.from([0x7f, 0x45, 0x4c, 0x46]))) {
			throw new DebugMcpError('INVALID_PROGRAM', 'program must be an existing ELF file. Build it before starting; flashing requires explicit authorization.');
		}
	} finally {
		await file.close();
	}
	return {
		type: 'aurix-tcf', request: 'launch', name: `AURIX MCP: ${input.targetDevice}`, noDebug: false,
		workspace: input.workspaceFolder, program: input.program, targetDevice: input.targetDevice, core: input.core,
		host: '127.0.0.1', port: 1534, autoStartAgent: true,
		enableFlashing: true, flashDownload: true, stopOnEntry: true, resumeOtherCoresOnEntry: false,
		instructionStepping: false, liveWatchEnabled: false, enableConsoleLog: false,
		__aurixMcpLaunchId: launchId,
		...(input.entryFunction ? { entryFunction: input.entryFunction } : {}),
		...(input.peripheralReadProfile ? { peripheralReadProfile: input.peripheralReadProfile } : {}),
	};
}

// Shared with the normal factory: MCP must never restart an existing UI session's agent.
export class DebugLifecycleGate {
	private readonly sessions = new Set<string>();
	private start?: { id: string; signal: AbortSignal; configuration?: Record<string, unknown>; sessionId?: string;
		failure?: DebugMcpError; onProgress?: (progress: Partial<DebugStartProgress>) => void };
	private releasing?: string;

	get busy(): boolean { return this.start !== undefined || this.releasing !== undefined; }

	reserveStart(id: string, signal: AbortSignal, onProgress?: (progress: Partial<DebugStartProgress>) => void): () => void {
		if (this.busy || this.sessions.size) {
			throw new DebugMcpError('BUSY', 'An AURIX session is active, starting or releasing its agent. Use the existing session or wait for debug_stop.');
		}
		signal.throwIfAborted();
		const reservation = { id, signal, onProgress };
		this.start = reservation;
		return () => { if (this.start === reservation) { this.start = undefined; } };
	}

	reportStartProgress(id: unknown, progress: Partial<DebugStartProgress>): void {
		if (this.start && this.start.id === id) { this.start.onProgress?.(progress); }
	}

	reportStartFailure(id: unknown, error: unknown, stage: DebugStartStage): void {
		if (!this.start || this.start.id !== id) { return; }
		const code = stage === 'flashing' ? 'FLASH_FAILED' : stage === 'agent-startup' ? 'AGENT_START_FAILED' : 'START_FAILED';
		this.start.failure ??= error instanceof DebugMcpError ? error :
			new DebugMcpError(code, error instanceof Error ? error.message : String(error), { stage });
	}

	startFailure(id: string): DebugMcpError | undefined {
		return this.start?.id === id ? this.start.failure : undefined;
	}

	setConfiguration(id: string, configuration: Record<string, unknown>): void {
		if (this.start?.id !== id) { throw new DebugMcpError('START_CANCELLED', 'The MCP launch reservation no longer exists.'); }
		this.start.configuration = { ...configuration };
	}

	checkConfiguration(configuration: Record<string, unknown>): void {
		if (this.releasing) { throw new DebugMcpError('BUSY', 'Wait for the owned agent to finish shutting down before starting another session.'); }
		const id = configuration.__aurixMcpLaunchId;
		if (!this.start && id === undefined) { return; }
		if (!this.start || id !== this.start.id) {
			throw new DebugMcpError('BUSY', 'Another MCP launch is pending, or this launch reservation has expired.');
		}
		this.start.signal.throwIfAborted();
		const expected = this.start.configuration;
		if (!expected) { throw new DebugMcpError('INVALID_LAUNCH', 'MCP launch configuration has not been validated.'); }
		for (const [key, value] of Object.entries(expected)) {
			if (configuration[key] !== value) { throw new DebugMcpError('INVALID_LAUNCH', `MCP launch field '${key}' changed during configuration resolution.`); }
		}
		if (configuration.enableFlashing !== true || configuration.flashDownload !== true || configuration.autoStartAgent !== true) {
			throw new DebugMcpError('INVALID_LAUNCH', 'MCP startup requires flashing and an owned Agent with -f. Reuse an existing session if programming is not authorized.');
		}
		for (const key of Object.keys(configuration)) {
			if (key in expected || key.startsWith('__') || key === 'liveWatchIntervalMs' || key === 'debugTCFMessages') { continue; }
			throw new DebugMcpError('INVALID_LAUNCH', `MCP launch does not allow '${key}'. Tasks, extra agent options and unrequested flashing are not supported.`);
		}
	}

	beginSession(id: string, configuration: Record<string, unknown>): void {
		this.checkConfiguration(configuration);
		if (this.start) {
			if (this.start.sessionId && this.start.sessionId !== id) { throw new DebugMcpError('BUSY', 'This MCP launch already owns another session.'); }
			this.start.sessionId = id;
		}
		this.sessions.add(id);
	}

	endSession(id: string): void { this.sessions.delete(id); }

	reserveRelease(id: string): () => void {
		if (this.releasing || [...this.sessions].some(sessionId => sessionId !== id) ||
			(this.start && this.start.sessionId !== id)) {
			throw new DebugMcpError('BUSY', 'Another session is using or starting the agent. Its backend will not be stopped.');
		}
		this.releasing = id;
		return () => { if (this.releasing === id) { this.releasing = undefined; } };
	}
}
