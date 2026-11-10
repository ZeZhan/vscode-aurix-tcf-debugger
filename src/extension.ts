/*
 * Aurix TCF Debugger VSCode Extension
 * Based on Intel's vscode-tcf-debug
 * Copyright (C) 2025 Infineon Technologies AG
 * 
 * Entry point for the VSCode extension.
 */
import * as vscode from 'vscode';
import * as path from 'path';
import * as net from 'net';
import * as fs from 'fs';
import * as crypto from 'crypto';
import { AurixTCFDebugSession } from './debugProvider';
import { ChildProcess, execFile, spawn } from 'child_process';
import { listDasDevices } from './deviceDiscovery';
import { pipeline } from 'stream/promises';
import { createGunzip } from 'zlib';
import { showDebugConfigPanel } from './debugConfigPanel';
import { installDebugSkill } from './debugSkill';
import { LiveWatchProvider } from './liveWatchView';
import { getSvdOptionsForDevice } from './svdCatalog';
import { buildFlasherArgs, createFlashingPlan, selectFlasherDevice } from './flashing';
import { resolveConfigPath } from './configPaths';
import { DebugMcpRegistration } from './mcp/extension';
import { preparePeripheralLaunch, preparedPeripheralAgentSvd } from './peripheralProfile';
import { AgentRelease, DebugMcpError } from './mcp/debugController';
import { DebugLifecycleGate, type DebugStartStage } from './mcp/launch';
import { waitForProcessExit, waitForTcpPortClosed } from './agentLifecycle';

let tcfAgentProcess: ChildProcess | undefined;
let agentAwaitingCleanup: ChildProcess | undefined;
const debugLifecycle = new DebugLifecycleGate();
const sessionAgents = new Map<string, { process: ChildProcess; host: string; port: number }>();
let agentStopPromise: Promise<void> = Promise.resolve();
let extensionContext: vscode.ExtensionContext;
let agentOutput: vscode.OutputChannel | undefined;
let flasherOutput: vscode.OutputChannel | undefined;
let debugMcp: DebugMcpRegistration | undefined;
let activeAurixSessions = 0;
let startingAurixSessions = 0;
let pendingStopTimer: NodeJS.Timeout | undefined;
let pendingStopToken = 0;
let lastAgentHost: string | undefined;
let lastAgentPort: number | undefined;
let enforcingMemoryInspectorSettings = false;
const memoryInspectorExtensionId = 'eclipse-cdt.memory-inspector';
let instructionStepStatusItem: vscode.StatusBarItem | undefined;
const instructionStepStateKey = 'aurix-tcf.instructionSteppingEnabled';
let lastInstructionSteppingEnabled = false;
let liveWatchStatusItem: vscode.StatusBarItem | undefined;
let liveWatchProvider: LiveWatchProvider | undefined;
const liveWatchEnabledStateKey = 'aurix-tcf.liveWatch.enabled';
const liveWatchIntervalStateKey = 'aurix-tcf.liveWatch.intervalMs';
let lastLiveWatchEnabled = false;
let lastLiveWatchIntervalMs = 1000;
let sourceRevealGeneration = 0;
let sourceRevealQueue: Promise<void> = Promise.resolve();
const SVD_CACHE_FOLDER = 'svd-cache';
const LIVE_WATCH_INTERVAL_OPTIONS = [200, 500, 1000, 2000] as const;

export function activate(context: vscode.ExtensionContext) {
	// This method is called when the extension is activated
	extensionContext = context;
	console.log('Aurix TCF debugging extension is activating...');
	agentOutput = vscode.window.createOutputChannel('AURIX TCF Agent');
	flasherOutput = vscode.window.createOutputChannel('AURIX Flasher');
	context.subscriptions.push(flasherOutput);
	debugMcp = new DebugMcpRegistration(context, debugLifecycle, releaseMcpAgent);
	context.subscriptions.push(debugMcp);
	liveWatchProvider = new LiveWatchProvider(context);
	context.subscriptions.push(liveWatchProvider);

	void ensureMemoryInspectorSettings();
	context.subscriptions.push(
		vscode.workspace.onDidChangeConfiguration((event) => {
			if (enforcingMemoryInspectorSettings) {
				return;
			}
			if (
				event.affectsConfiguration('memory-inspector.debugTypes') ||
				event.affectsConfiguration('memory-inspector.refreshOnStop') ||
				event.affectsConfiguration('memory-inspector.periodicRefresh') ||
				event.affectsConfiguration('memory-inspector.periodicRefreshInterval')
			) {
				void ensureMemoryInspectorSettings();
			}
		})
	);

	// Commands (added): open the debug configuration webview panel
	context.subscriptions.push(
		vscode.commands.registerCommand('aurix-tcf.openDebugConfig', () => {
			void showDebugConfigPanel(context);
		})
	);

	context.subscriptions.push(
		vscode.commands.registerCommand('aurix-tcf.installDebugSkill', () => installDebugSkill(context))
	);

	context.subscriptions.push(
		vscode.commands.registerCommand('aurix-tcf.pickSvd', async (args?: { targetDevice?: string }) => {
			void args;
			const options = await getSvdOptionsForDevice(context.extensionPath);
			const items: Array<vscode.QuickPickItem & { value?: string; browse?: boolean }> = [
				...options.map((option) => ({ label: option.label, description: option.value, value: option.value })),
				{ label: 'Browse local SVD...', description: 'Select any .svd file from disk', browse: true },
			];

			const picked = await vscode.window.showQuickPick(items, {
				title: 'Select SVD file',
				placeHolder: 'Pick SVD file',
				ignoreFocusOut: true,
			});
			if (!picked) {
				return undefined;
			}
			if (picked.browse) {
				const selected = await vscode.window.showOpenDialog({
					canSelectMany: false,
					openLabel: 'Select SVD',
					filters: {
						svdFiles: ['svd'],
						allFiles: ['*'],
					},
				});
				return selected?.[0]?.fsPath;
			}

			return picked.value;
		})
	);

	context.subscriptions.push(
		vscode.commands.registerCommand('aurix-tcf.resetTarget', async () => {
			const s = vscode.debug.activeDebugSession;
			if (!s || s.type !== 'aurix-tcf') {
				void vscode.window.showWarningMessage('No active AURIX™ TCF debug session.');
				return;
			}
			await s.customRequest('aurix-tcf/reset', { suspend: true, pauseAll: true });
		})
	);

	context.subscriptions.push(
		vscode.commands.registerCommand('aurix-tcf.toggleInstructionStepping', async () => {
			const enabled = !(await getInstructionSteppingEnabled());
			await setInstructionSteppingMode(enabled);
		})
	);

	context.subscriptions.push(
		vscode.commands.registerCommand('aurix-tcf.toggleLiveWatch', async () => {
			const enabled = !(await getLiveWatchEnabled());
			await setLiveWatchMode(enabled);
		})
	);

	context.subscriptions.push(
		vscode.commands.registerCommand('aurix-tcf.configureLiveWatch', async () => {
			const currentEnabled = await getLiveWatchEnabled();
			const currentInterval = await getLiveWatchIntervalMs();
			const items: Array<vscode.QuickPickItem & { enabled: boolean; intervalMs?: number; custom?: boolean }> = [
				{ label: 'Off', description: currentEnabled ? '' : 'Current', enabled: false },
				...LIVE_WATCH_INTERVAL_OPTIONS.map((intervalMs) => ({
					label: `${intervalMs} ms`,
					description: currentEnabled && currentInterval === intervalMs ? 'Current' : '',
					enabled: true,
					intervalMs,
				})),
				{
					label: 'Custom...',
					description: currentEnabled && !LIVE_WATCH_INTERVAL_OPTIONS.includes(currentInterval as any) ? `Current: ${currentInterval} ms` : '',
					enabled: true,
					custom: true,
				},
			];
			const picked = await vscode.window.showQuickPick(items, {
				title: 'Configure Live Watch',
				placeHolder: 'Select refresh interval for running global watch values (minimum 200ms+)',
				ignoreFocusOut: true,
			});
			if (!picked) {
				return;
			}
			if (picked.custom) {
				const customValue = await vscode.window.showInputBox({
					title: 'Custom Live Watch Interval',
					placeHolder: 'Enter refresh interval in milliseconds (minimum 200ms+)',
					value: String(currentInterval),
					ignoreFocusOut: true,
					validateInput: (input) => {
						const trimmed = input.trim();
						if (trimmed === '') {
							return 'Interval is required.';
						}
						const parsed = Number(trimmed);
						if (!Number.isFinite(parsed) || parsed < 200) {
							return 'Minimum 200ms+';
						}
						return undefined;
					},
				});
				if (customValue === undefined) {
					return;
				}
				await setLiveWatchMode(true, Number(customValue.trim()));
				return;
			}
			await setLiveWatchMode(picked.enabled, picked.intervalMs);
		})
	);

	context.subscriptions.push(
		vscode.commands.registerCommand('aurix-tcf.liveWatchAddExpression', async () => {
			await liveWatchProvider?.addExpression();
		})
	);

	context.subscriptions.push(
		vscode.commands.registerCommand('aurix-tcf.liveWatchRemoveExpression', async (item?: { expression?: string }) => {
			await liveWatchProvider?.removeExpression(item as any);
		})
	);

	context.subscriptions.push(
		vscode.commands.registerCommand('aurix-tcf.liveWatchClearExpressions', async () => {
			await liveWatchProvider?.clearExpressions();
		})
	);

	context.subscriptions.push(
		vscode.commands.registerCommand('aurix-tcf.liveWatchRefresh', async () => {
			await liveWatchProvider?.refreshNow();
		})
	);

	context.subscriptions.push(
		vscode.commands.registerCommand('aurix-tcf.enableInstructionStepping', async () => {
			await setInstructionSteppingMode(true);
		}),
		vscode.commands.registerCommand('aurix-tcf.disableInstructionStepping', async () => {
			await setInstructionSteppingMode(false);
		})
	);

	instructionStepStatusItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 100);
	instructionStepStatusItem.command = 'aurix-tcf.toggleInstructionStepping';
	instructionStepStatusItem.tooltip = 'Toggle instruction-level stepping';
	context.subscriptions.push(instructionStepStatusItem);
	liveWatchStatusItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 99);
	liveWatchStatusItem.command = 'aurix-tcf.configureLiveWatch';
	liveWatchStatusItem.tooltip = 'Configure live watch refresh for running global variables';
	context.subscriptions.push(liveWatchStatusItem);
	const liveWatchTreeView = vscode.window.createTreeView('aurixTcfLiveWatch', { treeDataProvider: liveWatchProvider });
	liveWatchProvider.attachView(liveWatchTreeView);
	context.subscriptions.push(liveWatchTreeView);

	// Register debug configuration provider
	context.subscriptions.push(
		vscode.debug.registerDebugConfigurationProvider('aurix-tcf', new AurixTCFConfigurationProvider())
	);

	// Register debug adapter factory
	context.subscriptions.push(
		vscode.debug.registerDebugAdapterDescriptorFactory('aurix-tcf', new AurixTCFDebugAdapterFactory())
	);

	// Register timestamp command (useful for recording TCF messages with timestamps)
	context.subscriptions.push(
		vscode.commands.registerCommand('aurix-tcf.timestamp', () => {
			return new Date().toISOString().replaceAll(":", "-");
		})
	);

	// Ensure we clean up the agent when the debug session is terminated.
	context.subscriptions.push(
		vscode.debug.onDidStartDebugSession((session: vscode.DebugSession) => {
			if (session.type === 'aurix-tcf') {
				activeAurixSessions++;
				if (pendingStopTimer) {
					clearTimeout(pendingStopTimer);
					pendingStopTimer = undefined;
					pendingStopToken++;
					agentOutput?.appendLine('Cancelled pending agent shutdown (new session started).');
				}
				void ensureMemoryInspectorSettings();
				void syncInstructionSteppingOnSessionStart(session);
				void syncLiveWatchOnSessionStart(session);
				void liveWatchProvider?.refreshNow();
			}
		})
	);
	context.subscriptions.push(
		vscode.debug.onDidChangeActiveDebugSession(() => {
			sourceRevealGeneration++;
			void liveWatchProvider?.refreshNow();
		})
	);
	context.subscriptions.push(
		vscode.debug.onDidChangeActiveStackItem((item) => {
			sourceRevealGeneration++;
			const session = vscode.debug.activeDebugSession;
			if (!session || session.type !== 'aurix-tcf') {
				return;
			}
			if (!item) {
				return;
			}
			// Only act once we have a stack frame (stopped state).
			const isStackFrame = typeof (item as vscode.DebugStackFrame).frameId === 'number';
			if (!isStackFrame) {
				return;
			}
			queueSourceReveal(item as vscode.DebugStackFrame);
		})
	);
	context.subscriptions.push(
		vscode.debug.onDidTerminateDebugSession(async (session) => {
			if (session.type !== 'aurix-tcf') {
				return;
			}
			sourceRevealGeneration++;
			debugLifecycle.endSession(session.id);
			activeAurixSessions = Math.max(0, activeAurixSessions - 1);
			if (activeAurixSessions === 0) {
				updateInstructionSteppingStatus(lastInstructionSteppingEnabled, false);
				updateLiveWatchStatus(lastLiveWatchEnabled, lastLiveWatchIntervalMs, false);
				liveWatchProvider?.refreshScheduling(false, lastLiveWatchIntervalMs);
			}
			// A new launch cancels this timer and awaits the owned agent's shutdown itself.
			if (activeAurixSessions === 0) {
				if (pendingStopTimer) {
					clearTimeout(pendingStopTimer);
				}
				const stopToken = ++pendingStopToken;
				agentOutput?.appendLine('Scheduling agent shutdown in 1s (cancelled if a new session starts).');
				pendingStopTimer = setTimeout(() => {
					pendingStopTimer = undefined;
					if (
						stopToken === pendingStopToken &&
						activeAurixSessions === 0 &&
						startingAurixSessions === 0 &&
						!debugLifecycle.busy
					) {
						void stopTCFAgent('debug session terminated').catch(reportAgentStopError);
					}
				}, 1000);
			}
		})
	);

	// Handle agent lifecycle
	context.subscriptions.push({
		dispose: () => {
			void stopTCFAgent('extension disposed').catch(reportAgentStopError);
		}
	});

	void vscode.window.showInformationMessage('Aurix TCF debugging extension is enabled.');
}

export class AurixTCFDebugAdapterFactory implements vscode.DebugAdapterDescriptorFactory {
    // Create the debug adapter descriptor for a debug session
	async createDebugAdapterDescriptor(session: vscode.DebugSession): Promise<vscode.ProviderResult<vscode.DebugAdapterDescriptor>> {
		const config = session.configuration;
		const launchId = config.__aurixMcpLaunchId;
		const mcpLaunch = typeof launchId === 'string';
		const startup: { stage: DebugStartStage } = { stage: 'configuration' };
		let flashAttempts = 0;
		let flashCompleted = false;
		const setStage = (value: DebugStartStage) => {
			startup.stage = value;
			debugLifecycle.reportStartProgress(launchId, { stage: value });
		};
		try { debugLifecycle.beginSession(session.id, config); }
		catch (error) {
			debugLifecycle.reportStartFailure(launchId, error, startup.stage);
			throw error;
		}
		startingAurixSessions++;
		// VS Code Restart can create a new session/adapter before firing onDidStartDebugSession.
		// Cancel any pending shutdown early so we don't kill the agent mid-start.
		if (pendingStopTimer) {
			clearTimeout(pendingStopTimer);
			pendingStopTimer = undefined;
			pendingStopToken++;
			agentOutput?.appendLine('Cancelled pending agent shutdown (session is starting).');
		}
		try {
		try {
			const plan = createFlashingPlan(config, value => resolveConfigPathFromFolder(session.workspaceFolder, value));
			if (plan) {
				if (mcpLaunch) {
					setStage('device-validation');
					await validateAgentTargetDevice(config.targetDevice, true);
					debugLifecycle.checkConfiguration(config);
				}
				setStage('flashing');
				// Release the previous session's DAS connection before flashing on Restart.
				await stopTCFAgent('pre-debug flashing');
				await runAurixFlasher(plan.elfPath, typeof config.targetDevice === 'string' ? config.targetDevice : undefined, plan.hexFiles,
					mcpLaunch ? () => debugLifecycle.checkConfiguration(config) : undefined,
					mcpLaunch ? eraseAll => {
						flashAttempts++;
						debugLifecycle.reportStartProgress(launchId, { flashStatus: 'running', flashAttempts, eraseAllRetried: eraseAll });
					} : undefined);
				flashCompleted = true;
				debugLifecycle.reportStartProgress(launchId, { flashStatus: 'completed' });
			}
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			flasherOutput?.appendLine(`Flashing failed: ${message}`);
			void vscode.window.showErrorMessage(`Flashing failed: ${message}`);
			throw error;
		}

		// Auto-start TCF agent if requested
		if (config.autoStartAgent) {
			setStage('device-validation');
			debugLifecycle.checkConfiguration(config);
			// Preflight: validate targetDevice early so typos fail fast.
			if (typeof config.targetDevice === 'string' && config.targetDevice.trim() !== '') {
				try {
					await validateAgentTargetDevice(config.targetDevice, typeof config.__aurixMcpLaunchId === 'string');
				} catch (e) {
					const msg = e instanceof Error ? e.message : String(e);
					void vscode.window.showErrorMessage(`Invalid targetDevice for agent: ${msg}`);
					throw e;
				}
			}

			// Use configured agent path, or fallback to bundled agent
			const configuredPath = config.agentPath || vscode.workspace.getConfiguration("aurix-tcf").get('agentPath');
			const agentPath = configuredPath || path.join(extensionContext.extensionPath, 'bin', 'aurix-debugger.exe');
			
			// Build agent arguments based on Eclipse log format
			const agentArgs: string[] = [];
			const userArgs: string[] = [];
			
			// -s TCP:host:port (server mode)
			agentArgs.push('-s', `TCP:${config.host || '127.0.0.1'}:${config.port || 1534}`);
			
			// -p device_name (target device)
			if (config.targetDevice) {
				agentArgs.push('-p', config.targetDevice);
			}
			
			// -e entry_function
			if (config.entryFunction) {
				agentArgs.push('-e', config.entryFunction);
			}
			
			// -b is the user breakpoint count, not the selected core.
			const enabledSourceBreakpoints = vscode.debug.breakpoints.filter(
				breakpoint => breakpoint.enabled && breakpoint instanceof vscode.SourceBreakpoint
			).length;
			agentArgs.push('-b', String(enabledSourceBreakpoints));
			
			// -r svd_file_path
			if (config.svdFile) {
				agentArgs.push('-r', preparedPeripheralAgentSvd(config.svdFile) ?? config.svdFile);
			}
			
			// -K workspace_path
			if (config.workspace) {
				agentArgs.push('-K', config.workspace);
			}
			
			// -f and -G flags
			if (config.flashDownload !== false) {
				agentArgs.push('-f');
			}

			// Collect user-provided args first so they can override auto-generated flags.
			// This is important for multi-core selection (-A) where the launcher may emit
			// a mask that does not correspond 1:1 with the ELF-path fields in this extension.
			if (typeof config.additionalAgentOptions === 'string' && config.additionalAgentOptions.trim() !== '') {
				userArgs.push(...splitCommandLine(config.additionalAgentOptions));
			}
			if (config.agentArgs && Array.isArray(config.agentArgs)) {
				userArgs.push(...config.agentArgs);
			}

			// Auto-generate -A core selection mask from PPU/CDSP/SCR ELF paths,
			// unless the user already provided -A in additionalAgentOptions or agentArgs.
			if (!userProvidedAParameter(userArgs)) {
				const mask = buildCoreSelectionMask(config);
				if (mask) {
					agentArgs.push('-A', mask);
				}
			}

			agentArgs.push(...userArgs);
			
			const host = config.host || '127.0.0.1';
			const port = config.port || 1534;

			debugLifecycle.checkConfiguration(config);
			setStage('agent-startup');
			await startTCFAgent(agentPath, agentArgs, host, port);
			debugLifecycle.reportStartProgress(launchId, { agentReady: true });
			if (tcfAgentProcess) {
				sessionAgents.set(session.id, { process: tcfAgentProcess, host, port });
				if (sessionAgents.size > 64) {
					const oldest = sessionAgents.keys().next().value;
					if (oldest !== undefined) { sessionAgents.delete(oldest); }
				}
			}
			debugLifecycle.checkConfiguration(config);
		}

		// Enable path mapper based on workspace trust and configuration
		const pathMapperConfigDefault = vscode.workspace.getConfiguration("aurix-tcf").inspect("executePathMapper")?.defaultValue ?? true;
		const pathMapperConfig = vscode.workspace.getConfiguration("aurix-tcf").get('executePathMapper', pathMapperConfigDefault);

		const enablePathMapper = vscode.workspace.isTrusted && pathMapperConfig === true;
		
		setStage('adapter-startup');
		return new vscode.DebugAdapterInlineImplementation(new AurixTCFDebugSession(enablePathMapper));
		} catch (error) {
			debugLifecycle.endSession(session.id);
			if (startup.stage === 'flashing' && flashAttempts > 0 && !flashCompleted) {
				debugLifecycle.reportStartProgress(launchId, { flashStatus: 'failed' });
			}
			let failure = error;
			if (mcpLaunch) {
				try { await stopTCFAgent('MCP launch failed'); }
				catch (cleanupError) {
					failure = new DebugMcpError(error instanceof DebugMcpError ? error.code : startup.stage === 'flashing' ? 'FLASH_FAILED' : 'START_FAILED',
						`${error instanceof Error ? error.message : String(error)}; owned Agent cleanup also failed: ${String(cleanupError)}`,
						{ ...(error instanceof DebugMcpError ? error.details : {}), cleanupError: String(cleanupError) });
				}
			}
			debugLifecycle.reportStartFailure(launchId, failure, startup.stage);
			throw failure;
		} finally {
			startingAurixSessions = Math.max(0, startingAurixSessions - 1);
		}
	}
}

async function listLsmcddDevices() { return listDasDevices(extensionContext.extensionPath); }

async function validateAgentTargetDevice(targetDevice: string, strict = false): Promise<void> {
	const raw = targetDevice.trim();
	if (raw === '') {
		return;
	}
	if (/^\d+$/.test(raw)) {
		throw new Error(`targetDevice must be a device name (not a numeric id).`);
	}
	try {
		const devices = await listLsmcddDevices();
		if (devices.length === 0) {
			throw new Error('No devices detected by lsmcdd.exe');
		}
		const rawLower = raw.toLowerCase();
		const ok = devices.some((d) => (d.name ?? '').trim() !== '' && d.name.toLowerCase() === rawLower);
		if (!ok) {
			const names = devices.map((d) => d.name).join('; ');
			throw new Error(`Device '${raw}' not found. Available: ${names}`);
		}
	} catch (e) {
		// If we cannot validate (tool missing/timeout), don't block debugging.
		// But if we *did* get a device list and it doesn't match, we throw above.
		const msg = e instanceof Error ? e.message : String(e);
		agentOutput?.appendLine(`Warning: could not validate targetDevice via lsmcdd.exe: ${msg}`);
		// Re-throw only for definite mismatch errors (which include 'Available:').
		if (strict || (typeof msg === 'string' && msg.includes('Available:'))) {
			throw e;
		}
	}
}

async function runAurixFlasher(elfPath: string, targetDevice: string | undefined, hexFiles: string[],
	check?: () => void, onAttempt?: (eraseAll: boolean) => void): Promise<void> {
	check?.();
	const flasherExe = path.join(extensionContext.extensionPath, 'bin', 'aurixflasher', 'aurixflasher.exe');
	if (!fs.existsSync(flasherExe)) {
		throw new Error(`aurixflasher.exe not found: ${flasherExe}`);
	}
	flasherOutput?.show(true);
	flasherOutput?.appendLine(`Flashing ELF: ${elfPath}`);
	for (const hex of hexFiles) {
		flasherOutput?.appendLine(`Flashing HEX: ${hex}`);
	}
	flasherOutput?.appendLine(`Resolving device id via lsmcdd.exe (targetDevice='${targetDevice ?? ''}')...`);
	const device = selectFlasherDevice(await listLsmcddDevices(), targetDevice);
	const args = buildFlasherArgs(elfPath, hexFiles, device);

	const run = (commandArgs: string[], eraseAll = false): Promise<number> => {
		check?.();
		flasherOutput?.appendLine(`Command: ${flasherExe} ${commandArgs.join(' ')}`);
		return new Promise((resolve, reject) => {
			onAttempt?.(eraseAll);
			execFile(flasherExe, commandArgs, {
				cwd: path.dirname(flasherExe), windowsHide: true, maxBuffer: 20 * 1024 * 1024,
			}, (error, stdout, stderr) => {
				if (stdout) { flasherOutput?.appendLine(stdout.trimEnd()); }
				if (stderr) { flasherOutput?.appendLine(stderr.trimEnd()); }
				if (!error) {
					resolve(0);
				} else if (typeof error.code === 'number' && !error.killed && !error.signal) {
					resolve(error.code);
				} else {
					reject(error);
				}
			});
		});
	};

	let exitCode = await run(args);
	if (exitCode !== 0) {
		check?.();
		// Preserve the original Eclipse-compatible erase-and-retry behavior.
		flasherOutput?.appendLine('Flashing failed, retrying with -erase all...');
		exitCode = await run([...args, '-erase', 'all'], true);
		if (exitCode !== 0) {
			throw new Error(`Flashing failed even after erasing. Exit code: ${exitCode}`);
		}
	}
	flasherOutput?.appendLine('Flashing completed successfully.');
}

function splitCommandLine(text: string): string[] {
	// Simple quote-aware split for Additional Agent Options.
	// Supports: foo bar "quoted arg" 'single quoted'.
	const out: string[] = [];
	let cur = '';
	let quote: '"' | "'" | undefined;
	for (let i = 0; i < text.length; i++) {
		const ch = text[i];
		if (quote) {
			if (ch === quote) {
				quote = undefined;
				continue;
			}
			cur += ch;
			continue;
		}
		if (ch === '"' || ch === "'") {
			quote = ch as any;
			continue;
		}
		if (ch === ' ' || ch === '\t' || ch === '\n' || ch === '\r') {
			if (cur.trim() !== '') {
				out.push(cur);
				cur = '';
			}
			continue;
		}
		cur += ch;
	}
	if (cur.trim() !== '') {
		out.push(cur);
	}
	return out;
}

function buildCoreSelectionMask(config: any): string | undefined {
	const hasPath = (v: any) => typeof v === 'string' && v.trim() !== '';
	const chars = new Array(14).fill('-');
	if (hasPath(config.ppuElfPath)) {
		chars[0] = 'p';
	}
	const cdsp = Array.isArray(config.cdspElfPaths) ? config.cdspElfPaths : [];
	for (let i = 0; i < 12; i++) {
		if (hasPath(cdsp[i])) {
			chars[i + 1] = 'c';
		}
	}
	if (hasPath(config.scrElfPath)) {
		chars[13] = 's';
	}
	const mask = chars.join('');
	return /[^-]/.test(mask) ? mask : undefined;
}

function userProvidedAParameter(args: string[]): boolean {
	for (const a of args) {
		if (a === '-A') {
			return true;
		}
		// Allow combined form: -Apcc-----
		if (a.startsWith('-A') && a.length > 2) {
			return true;
		}
	}
	return false;
}

function resolveConfigPathFromFolder(folder: vscode.WorkspaceFolder | undefined, p: unknown): string | undefined {
	const ws = folder?.uri.fsPath || vscode.workspace.workspaceFolders?.[0]?.uri.fsPath || '';
	return resolveConfigPath(p, ws);
}

function getSvdCacheRoot(): string {
	const fromGlobalStorage = extensionContext?.globalStorageUri?.fsPath;
	if (typeof fromGlobalStorage === 'string' && fromGlobalStorage.trim() !== '') {
		return path.join(fromGlobalStorage, SVD_CACHE_FOLDER);
	}
	return path.join(extensionContext.extensionPath, '.cache', SVD_CACHE_FOLDER);
}

async function ensureDirectory(dirPath: string): Promise<void> {
	await fs.promises.mkdir(dirPath, { recursive: true });
}

async function materializeCompressedSvd(svdGzPath: string): Promise<string> {
	const normalizedInput = path.normalize(svdGzPath);
	if (!fs.existsSync(normalizedInput)) {
		throw new Error(`Compressed SVD not found: ${normalizedInput}`);
	}

	const stat = await fs.promises.stat(normalizedInput);
	const baseName = path.basename(normalizedInput, '.gz');
	const digest = crypto
		.createHash('sha256')
		.update(`${baseName}:${stat.size}`)
		.digest('hex')
		.slice(0, 16);

	const cacheDir = getSvdCacheRoot();
	await ensureDirectory(cacheDir);

	const outputPath = path.join(cacheDir, `${baseName}.${digest}`);
	if (fs.existsSync(outputPath)) {
		return outputPath;
	}

	const tempPath = `${outputPath}.tmp`;
	agentOutput?.appendLine(`Preparing SVD cache: ${baseName}`);
	await vscode.window.withProgress(
		{
			location: vscode.ProgressLocation.Notification,
			title: 'AURIX™ TCF: preparing SVD definitions (first run)',
			cancellable: false,
		},
		async (progress) => {
			progress.report({ message: baseName });
			await pipeline(
				fs.createReadStream(normalizedInput),
				createGunzip(),
				fs.createWriteStream(tempPath)
			);
		}
	);
	await fs.promises.rename(tempPath, outputPath);
	agentOutput?.appendLine(`SVD cache ready: ${outputPath}`);
	return outputPath;
}

async function resolveUsableSvdPath(
	folder: vscode.WorkspaceFolder | undefined,
	value: string | undefined,
): Promise<string | undefined> {
	if (!value || value.trim() === '') {
		return undefined;
	}

	const resolved = resolveConfigPathFromFolder(folder, value) ?? value;
	const lower = resolved.toLowerCase();
	if (lower.endsWith('.svd.gz')) {
		return await materializeCompressedSvd(resolved);
	}
	return resolved;
}

export class AurixTCFConfigurationProvider implements vscode.DebugConfigurationProvider {

	/**
	 * Provide initial debug configurations when launch.json is created
	 */
	provideDebugConfigurations(
		folder: vscode.WorkspaceFolder | undefined,
		token?: vscode.CancellationToken
	): vscode.ProviderResult<vscode.DebugConfiguration[]> {
		return [
			{
				type: 'aurix-tcf',
				request: 'launch',
				name: 'Debug Aurix Program',
				workspace: '${workspaceFolder}',
				program: '${workspaceFolder}/build/program.elf',
				enableFlashing: false,
				enableConsoleLog: false
			}
		];
	}

	/**
	 * Massage a debug configuration just before a debug session is being launched.
	 */
	async resolveDebugConfiguration(
		folder: vscode.WorkspaceFolder | undefined, 
		config: vscode.DebugConfiguration, 
		token?: vscode.CancellationToken
	): Promise<vscode.DebugConfiguration | undefined> {
		debugLifecycle.checkConfiguration(config);

		// This extension does not support user-facing attach sessions.
		if ((config as any).request === 'attach') {
			void vscode.window.showErrorMessage('AURIX™ TCF Debugger: attach is not supported. Use a launch configuration (via the GUI panel).');
			return undefined;
		}

		// If launch.json is missing or empty
		if (!config.type && !config.request && !config.name) {
			const editor = vscode.window.activeTextEditor;
			if (editor && (editor.document.languageId === 'cpp' || editor.document.languageId === 'c')) {
				config.type = 'aurix-tcf';
				config.name = 'Launch Aurix Program';
				config.request = 'launch';
				config.host = 'localhost';
				config.port = 1534;
			}
		}

		// Provide defaults
		if (!config.host) {
			config.host = 'localhost';
		}
		if (!config.port) {
			config.port = 1534;
		}
		if (typeof (config as any).liveWatchEnabled !== 'boolean') {
			(config as any).liveWatchEnabled = await getLiveWatchEnabled();
		}
		if (typeof (config as any).liveWatchIntervalMs !== 'number') {
			(config as any).liveWatchIntervalMs = await getLiveWatchIntervalMs();
		}

		// Console logging toggle: enableConsoleLog maps to debugTCFMessages.
		if (typeof (config as any).enableConsoleLog === 'boolean') {
			(config as any).debugTCFMessages = (config as any).enableConsoleLog;
		}

		const asNonEmptyString = (value: any): string | undefined => {
			return typeof value === 'string' && value.trim() !== '' ? value : undefined;
		};
		const looksLikeFilePath = (value: string): boolean => {
			const v = value.trim();
			if (v === '' || v.includes('::')) {
				return false;
			}
			return v.toLowerCase().endsWith('.svd') || v.toLowerCase().endsWith('.svd.gz') || v.includes('${') || /[\\/]/.test(v);
		};

		const svdFile = asNonEmptyString((config as any).svdFile);
		const svdPath = asNonEmptyString((config as any).svdPath);
		const definitionPath = asNonEmptyString((config as any).definitionPath);

		const effectiveSvdFile = asNonEmptyString((config as any).svdFile);

		if (!svdPath && effectiveSvdFile) {
			(config as any).svdPath = effectiveSvdFile;
		}
		if (!definitionPath && effectiveSvdFile) {
			(config as any).definitionPath = effectiveSvdFile;
		}
		if (!effectiveSvdFile) {
			const candidate = svdPath || definitionPath;
			if (candidate && looksLikeFilePath(candidate)) {
				(config as any).svdFile = candidate;
			}
		}

		const usableSvd = await resolveUsableSvdPath(folder, asNonEmptyString((config as any).svdFile));
		if (usableSvd) {
			(config as any).svdFile = usableSvd;
			(config as any).svdPath = usableSvd;
			(config as any).definitionPath = usableSvd;
		}

		if (!extensionContext) { throw new Error('Extension storage is unavailable for the peripheral inspection profile.'); }
		await preparePeripheralLaunch(config, extensionContext.globalStorageUri.fsPath);

		return config;
	}

	resolveDebugConfigurationWithSubstitutedVariables(
		_folder: vscode.WorkspaceFolder | undefined, config: vscode.DebugConfiguration
	): vscode.DebugConfiguration {
		debugLifecycle.checkConfiguration(config);
		return config;
	}
}

async function releaseMcpAgent(session: vscode.DebugSession): Promise<AgentRelease> {
	const owned = sessionAgents.get(session.id);
	if (!owned) {
		if (session.configuration.autoStartAgent) {
			throw new DebugMcpError('RELEASE_UNCONFIRMED', 'No owned Agent was recorded for this session. Check the AURIX TCF Agent output; device release cannot be confirmed.');
		}
		return { ownership: 'external', agentReleased: false, deviceAccessVerified: false,
			message: 'The external Agent was not stopped. Release it separately before flashing.' };
	}
	if ((tcfAgentProcess && tcfAgentProcess !== owned.process) ||
		(agentAwaitingCleanup && agentAwaitingCleanup !== owned.process)) {
		throw new DebugMcpError('BUSY', 'The owned Agent has been replaced. The other process will not be stopped.');
	}
	if (pendingStopTimer) { clearTimeout(pendingStopTimer); pendingStopTimer = undefined; }
	pendingStopToken++;
	await stopTCFAgent('MCP debug_stop');
	await waitForProcessExit(owned.process, 10000);
	await waitForTcpPortClosed(owned.host, owned.port, 10000);
	return { ownership: 'extension', agentReleased: true, processExited: true, portClosed: true, deviceAccessVerified: false };
}

async function startTCFAgent(agentPath: string, args: string[], host: string, port: number): Promise<void> {
	// A new session must not inherit the previous agent's launch arguments or breakpoints.
	await stopTCFAgent('restart requested');
	await waitForTcpPortClosed(host, port, 1000);

	lastAgentHost = host;
	lastAgentPort = port;

	agentOutput?.show(true);
	agentOutput?.appendLine(`Starting TCF agent: ${agentPath}`);
	agentOutput?.appendLine(`Agent arguments: ${args.join(' ')}`);

	const proc = spawn(agentPath, args, {
		cwd: path.dirname(agentPath),
		stdio: ['ignore', 'pipe', 'pipe'],
		windowsHide: true,
	});
	tcfAgentProcess = proc;
	agentAwaitingCleanup = proc;

	proc.stdout?.on('data', (data) => {
		agentOutput?.appendLine(String(data).trimEnd());
	});

	proc.stderr?.on('data', (data) => {
		agentOutput?.appendLine(String(data).trimEnd());
	});

	proc.on('exit', (code, signal) => {
		agentOutput?.appendLine(`TCF agent exited with code ${code}${signal ? ` (signal ${signal})` : ''}`);
		if (tcfAgentProcess === proc) {
			tcfAgentProcess = undefined;
		}
	});

	proc.on('error', (err) => {
		agentOutput?.appendLine(`Failed to start TCF agent: ${err.message}`);
	});

	// Avoid a race where the debug adapter tries to connect before the agent has
	// started listening on the requested TCP port.
	agentOutput?.appendLine(`Waiting for TCF agent to listen on ${host}:${port}...`);
	try {
		await waitForTcpPort(host, port, 15_000);
	} catch (error) {
		const failure = error instanceof DebugMcpError ? error :
			new DebugMcpError('AGENT_START_FAILED', error instanceof Error ? error.message : String(error), { host, port });
		agentOutput?.appendLine(`Agent startup failed (${failure.code}): ${failure.message}`);
		try { await stopTCFAgent('agent startup failed'); }
		catch (cleanupError) {
			throw new DebugMcpError(failure.code, `${failure.message}; Agent cleanup also failed: ${String(cleanupError)}`,
				{ ...failure.details, cleanupError: String(cleanupError) });
		}
		throw failure;
	}
	agentOutput?.appendLine(`TCF agent is listening on ${host}:${port}`);
}

function reportAgentStopError(error: unknown): void {
	const message = `Failed to stop TCF agent: ${String(error)}`;
	agentOutput?.appendLine(message);
	void vscode.window.showErrorMessage(message);
}

function stopTCFAgent(reason: string): Promise<void> {
	const stopping = agentStopPromise.then(() => stopTCFAgentProcess(reason));
	agentStopPromise = stopping.catch(error => agentOutput?.appendLine(`Agent shutdown incomplete: ${String(error)}`));
	return stopping;
}

async function stopTCFAgentProcess(reason: string): Promise<void> {
	// Stop the TCF agent process if running
	if (!agentAwaitingCleanup) {
		return;
	}

	const proc = agentAwaitingCleanup;
	const pid = proc.pid;

	if (!pid) {
		if (agentAwaitingCleanup === proc) { agentAwaitingCleanup = undefined; }
		return;
	}

	agentOutput?.appendLine(`Stopping TCF agent (pid ${pid}) - ${reason}`);

	if (proc.exitCode === null && proc.signalCode === null) {
		if (process.platform === 'win32') {
			// Kill the whole process tree; aurix-debugger.exe may spawn helper processes.
			await new Promise<void>((resolve, reject) => {
				execFile('taskkill', ['/PID', String(pid), '/T', '/F'], { windowsHide: true, timeout: 10000 }, (err, stdout, stderr) => {
					if (stdout) {
						agentOutput?.appendLine(String(stdout).trimEnd());
					}
					if (stderr) {
						agentOutput?.appendLine(String(stderr).trimEnd());
					}
					if (err) {
						reject(err);
						return;
					}
					resolve();
				});
			});
		} else {
			if (!proc.kill()) {
				throw new Error(`Failed to signal TCF agent ${pid}`);
			}
		}
	}

	await waitForProcessExit(proc, 10000);
	if (lastAgentHost && typeof lastAgentPort === 'number') {
		await waitForTcpPortClosed(lastAgentHost, lastAgentPort, 10_000);
	}
	if (agentAwaitingCleanup === proc) { agentAwaitingCleanup = undefined; }
	if (tcfAgentProcess === proc) { tcfAgentProcess = undefined; }
}

function waitForTcpPort(host: string, port: number, timeoutMs: number): Promise<void> {
	const deadline = Date.now() + timeoutMs;
	return new Promise((resolve, reject) => {
		const tryOnce = () => {
			// If the agent already exited, don't keep polling.
			if (!tcfAgentProcess) {
				reject(new Error('TCF agent process is not running'));
				return;
			}
			if (tcfAgentProcess.exitCode !== null) {
				reject(new Error(`TCF agent exited early (code ${tcfAgentProcess.exitCode})`));
				return;
			}
			const socket = new net.Socket();
			socket.setTimeout(500);
			socket.once('connect', () => {
				socket.destroy();
				resolve();
			});
			socket.once('timeout', () => {
				socket.destroy();
				retryOrFail();
			});
			socket.once('error', () => {
				socket.destroy();
				retryOrFail();
			});

			const retryOrFail = () => {
				if (Date.now() >= deadline) {
					reject(new DebugMcpError('AGENT_START_TIMEOUT', `Timed out waiting for the TCF agent to listen on ${host}:${port} after ${timeoutMs} ms.`,
						{ host, port, agentTimeoutMs: timeoutMs }));
					return;
				}
				setTimeout(tryOnce, 150);
			};

			socket.connect(port, host);
		};

		tryOnce();
	});
}

async function ensureMemoryInspectorSettings(): Promise<void> {
	const cfg = vscode.workspace.getConfiguration();
	const desiredDebugger = 'aurix-tcf';
	const currentTypes = cfg.get<string[]>('memory-inspector.debugTypes') ?? [];
	const typeList = Array.isArray(currentTypes) ? currentTypes.slice() : [];
	const needsType = !typeList.includes(desiredDebugger);
	if (!needsType) {
		return;
	}
	try {
		enforcingMemoryInspectorSettings = true;
		typeList.push(desiredDebugger);
		await cfg.update('memory-inspector.debugTypes', typeList, vscode.ConfigurationTarget.Workspace);
	} catch (e) {
		agentOutput?.appendLine(`Failed to enforce memory-inspector settings: ${String(e)}`);
	} finally {
		enforcingMemoryInspectorSettings = false;
	}
}

async function getInstructionSteppingEnabled(): Promise<boolean> {
	const stored = extensionContext.workspaceState.get<boolean>(instructionStepStateKey);
	if (typeof stored === 'boolean') {
		return stored;
	}
	const cfg = vscode.workspace.getConfiguration('aurix-tcf');
	return cfg.get<boolean>('instructionSteppingDefault', false);
}

function normalizeLiveWatchIntervalMs(value: unknown): number {
	const numeric = typeof value === 'number' ? value : Number(value);
	if (!Number.isFinite(numeric)) {
		return 1000;
	}
	return Math.min(10_000, Math.max(200, Math.round(numeric)));
}

async function getLiveWatchEnabled(): Promise<boolean> {
	const stored = extensionContext.workspaceState.get<boolean>(liveWatchEnabledStateKey);
	if (typeof stored === 'boolean') {
		return stored;
	}
	const cfg = vscode.workspace.getConfiguration('aurix-tcf');
	return cfg.get<boolean>('liveWatch.enabled', false);
}

async function getLiveWatchIntervalMs(): Promise<number> {
	const stored = extensionContext.workspaceState.get<number>(liveWatchIntervalStateKey);
	if (typeof stored === 'number' && Number.isFinite(stored)) {
		return normalizeLiveWatchIntervalMs(stored);
	}
	const cfg = vscode.workspace.getConfiguration('aurix-tcf');
	return normalizeLiveWatchIntervalMs(cfg.get<number>('liveWatch.intervalMs', 1000));
}

async function setLiveWatchEnabled(value: boolean): Promise<void> {
	lastLiveWatchEnabled = value;
	await extensionContext.workspaceState.update(liveWatchEnabledStateKey, value);
}

async function setLiveWatchInterval(value: number): Promise<void> {
	lastLiveWatchIntervalMs = normalizeLiveWatchIntervalMs(value);
	await extensionContext.workspaceState.update(liveWatchIntervalStateKey, lastLiveWatchIntervalMs);
}

async function setLiveWatchMode(enabled: boolean, intervalMs?: number, session?: vscode.DebugSession): Promise<void> {
	const nextIntervalMs = normalizeLiveWatchIntervalMs(intervalMs ?? await getLiveWatchIntervalMs());
	await setLiveWatchEnabled(enabled);
	await setLiveWatchInterval(nextIntervalMs);
	const targetSession = session ?? vscode.debug.activeDebugSession;
	if (targetSession && targetSession.type === 'aurix-tcf') {
		try {
			await targetSession.customRequest('aurix-tcf/setLiveWatch', { enabled, intervalMs: nextIntervalMs });
		} catch (e) {
			agentOutput?.appendLine(`Failed to set live watch: ${String(e)}`);
		}
	}
	updateLiveWatchStatus(enabled, nextIntervalMs, true);
	liveWatchProvider?.refreshScheduling(enabled, nextIntervalMs);
	if (enabled) {
		void liveWatchProvider?.refreshNow();
	}
}

function updateLiveWatchStatus(enabled: boolean, intervalMs: number, visible: boolean): void {
	lastLiveWatchEnabled = enabled;
	lastLiveWatchIntervalMs = normalizeLiveWatchIntervalMs(intervalMs);
	void vscode.commands.executeCommand('setContext', 'aurix-tcf.liveWatchEnabled', enabled);
	if (!liveWatchStatusItem) {
		return;
	}
	liveWatchStatusItem.text = enabled ? `Live Watch: ${lastLiveWatchIntervalMs}ms` : 'Live Watch: OFF';
	liveWatchStatusItem.tooltip = enabled
		? `Live watch is enabled for running global watch expressions (${lastLiveWatchIntervalMs} ms). Click to change.`
		: 'Live watch is disabled. Click to enable or change interval.';
	if (visible) {
		liveWatchStatusItem.show();
	} else {
		liveWatchStatusItem.hide();
	}
}

async function setInstructionSteppingEnabled(value: boolean): Promise<void> {
	lastInstructionSteppingEnabled = value;
	await extensionContext.workspaceState.update(instructionStepStateKey, value);
}

async function setInstructionSteppingMode(enabled: boolean, session?: vscode.DebugSession): Promise<void> {
	await setInstructionSteppingEnabled(enabled);
	const targetSession = session ?? vscode.debug.activeDebugSession;
	if (targetSession && targetSession.type === 'aurix-tcf') {
		try {
			await targetSession.customRequest('aurix-tcf/setInstructionStepping', { enabled });
		} catch (e) {
			agentOutput?.appendLine(`Failed to set instruction stepping: ${String(e)}`);
		}
	}
	updateInstructionSteppingStatus(enabled, true);
}

function updateInstructionSteppingStatus(enabled: boolean, visible: boolean): void {
	lastInstructionSteppingEnabled = enabled;
	void vscode.commands.executeCommand('setContext', 'aurix-tcf.instructionStepping', enabled);
	if (!instructionStepStatusItem) {
		return;
	}
	instructionStepStatusItem.text = enabled ? 'Instr Step: ON' : 'Instr Step: OFF';
	instructionStepStatusItem.tooltip = enabled
		? 'Instruction stepping enabled (click to disable)'
		: 'Instruction stepping disabled (click to enable)';
	if (visible) {
		instructionStepStatusItem.show();
	} else {
		instructionStepStatusItem.hide();
	}
}

async function syncInstructionSteppingOnSessionStart(session: vscode.DebugSession): Promise<void> {
	if (session.type !== 'aurix-tcf') {
		return;
	}
	const enabled = await getInstructionSteppingEnabled();
	await setInstructionSteppingMode(enabled, session);
}

async function syncLiveWatchOnSessionStart(session: vscode.DebugSession): Promise<void> {
	if (session.type !== 'aurix-tcf') {
		return;
	}
	const sessionConfig = session.configuration as { liveWatchEnabled?: boolean; liveWatchIntervalMs?: number } | undefined;
	const enabled = typeof sessionConfig?.liveWatchEnabled === 'boolean'
		? sessionConfig.liveWatchEnabled
		: await getLiveWatchEnabled();
	const intervalMs = sessionConfig?.liveWatchIntervalMs !== undefined
		? normalizeLiveWatchIntervalMs(sessionConfig.liveWatchIntervalMs)
		: await getLiveWatchIntervalMs();
	await setLiveWatchMode(enabled, intervalMs, session);
}

function queueSourceReveal(item: vscode.DebugStackFrame): void {
	const generation = ++sourceRevealGeneration;
	sourceRevealQueue = sourceRevealQueue.then(() => revealSelectedFrameSource(item, generation));
}

async function revealSelectedFrameSource(item: vscode.DebugStackFrame, generation: number): Promise<void> {
	const isCurrent = () => {
		const current = vscode.debug.activeStackItem;
		return sourceRevealGeneration === generation && vscode.debug.activeDebugSession?.id === item.session.id &&
			current?.session.id === item.session.id && current.threadId === item.threadId &&
			'frameId' in current && current.frameId === item.frameId;
	};
	if (!isCurrent()) {
		return;
	}
	try {
		const result: { stale?: boolean; source?: { path: string; line: number } } = await item.session.customRequest(
			'aurix-tcf/frameSource', { threadId: item.threadId, frameId: item.frameId });
		if (!isCurrent()) {
			return;
		}
		if (result.stale) {
			agentOutput?.appendLine(`Skipped expired source selection: frame=${item.frameId} thread=${item.threadId}`);
			return;
		}
		if (!result.source) {
			return;
		}
		const source = result.source;
		if (typeof source.path !== 'string' || !Number.isInteger(source.line) || source.line < 1) {
			throw new Error('Invalid source location for selected frame');
		}
		const document = await vscode.workspace.openTextDocument(vscode.Uri.file(source.path));
		if (!isCurrent()) {
			return;
		}
		const visible = vscode.window.visibleTextEditors.find(editor => editor.document.uri.toString() === document.uri.toString());
		const editor = await vscode.window.showTextDocument(document, {
			viewColumn: visible?.viewColumn ?? vscode.ViewColumn.One,
			preview: false, preserveFocus: true
		});
		if (!isCurrent()) {
			return;
		}
		const position = new vscode.Position(source.line - 1, 0);
		editor.selection = new vscode.Selection(position, position);
		editor.revealRange(new vscode.Range(position, position), vscode.TextEditorRevealType.InCenterIfOutsideViewport);
	} catch (error) {
		if (isCurrent()) {
			agentOutput?.appendLine(`Failed to reveal selected core/frame source: ${String(error)}`);
		}
	}
}

export async function deactivate() {
	sourceRevealGeneration++;
	try {
		await debugMcp?.close();
	} finally {
		await stopTCFAgent('extension deactivate').catch(reportAgentStopError);
		agentOutput?.dispose();
		agentOutput = undefined;
	}
}
