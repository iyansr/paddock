import { execFile, spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { constants } from 'node:fs';
import { access } from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import {
	HerdrError, parseAgentList, parseCreated, parseEnvelope, parsePaneList, parseServerRunning,
	parseWorkspaceList, type AgentInfo, type PaneInfo, type WorkspaceInfo,
} from './parse';

export interface HerdrConfig {
	/** `paddock.herdrPath`; empty means look for herdr. */
	path: string;
	/** `paddock.herdrSession`. Paddock never touches herdr's default session. */
	session: string;
}

const COMMON_LOCATIONS = [
	path.join(os.homedir(), '.local', 'bin', 'herdr'),
	'/opt/homebrew/bin/herdr',
	'/usr/local/bin/herdr',
];

interface ExecFailure extends Error {
	stdout?: string;
	code?: string | number | null;
}

/**
 * The only place that runs herdr. Every call goes through execFile with an
 * argument array and HERDR_SESSION set; nothing is ever a shell string.
 */
export class Herdr {
	private resolved: { setting: string; binary: string } | undefined;

	constructor(private readonly getConfig: () => HerdrConfig) {}

	get session(): string {
		return this.getConfig().session;
	}

	private get env(): NodeJS.ProcessEnv {
		return { ...process.env, HERDR_SESSION: this.getConfig().session };
	}

	/** VS Code often starts without the user's shell PATH, so try the usual install spots. */
	private async binary(): Promise<string> {
		const setting = this.getConfig().path.trim();
		if (this.resolved?.setting === setting) {
			return this.resolved.binary;
		}
		let binary = setting;
		if (!binary) {
			binary = 'herdr';
			for (const candidate of COMMON_LOCATIONS) {
				try {
					await access(candidate, constants.X_OK);
					binary = candidate;
					break;
				} catch {
					// try the next one
				}
			}
		}
		this.resolved = { setting, binary };
		return binary;
	}

	private async exec(args: string[], timeout = 15_000): Promise<{ stdout: string; failed?: ExecFailure }> {
		const binary = await this.binary();
		return new Promise(resolve => {
			execFile(binary, args, { env: this.env, timeout, maxBuffer: 16 * 1024 * 1024 }, (error, stdout) => {
				resolve({ stdout, failed: error ?? undefined });
			});
		});
	}

	/** Runs a command that answers with a JSON envelope and returns its `result`. */
	private async call(args: string[], timeout?: number): Promise<Record<string, unknown>> {
		const { stdout, failed } = await this.exec(args, timeout);
		if (stdout.trim()) {
			// herdr reports errors as JSON on stdout, usually with a non-zero exit.
			return parseEnvelope(stdout);
		}
		throw new HerdrError(String(failed?.code ?? 'exec_failed'), failed?.message ?? 'herdr produced no output');
	}

	async version(): Promise<string> {
		const { stdout, failed } = await this.exec(['--version']);
		if (failed && !stdout.trim()) {
			throw new HerdrError(String(failed.code ?? 'exec_failed'), failed.message);
		}
		return stdout.trim();
	}

	async serverRunning(): Promise<boolean> {
		const { stdout } = await this.exec(['status', 'server']);
		return parseServerRunning(stdout);
	}

	/** Starts the headless server for this session and waits until it answers. */
	async ensureServer(): Promise<void> {
		if (await this.serverRunning()) {
			return;
		}
		const child = spawn(await this.binary(), ['server'], { env: this.env, detached: true, stdio: 'ignore' });
		child.on('error', () => undefined);
		child.unref();
		for (let i = 0; i < 25; i++) {
			await new Promise(r => setTimeout(r, 200));
			if (await this.serverRunning()) {
				return;
			}
		}
		throw new HerdrError('server_unavailable', `herdr server for session "${this.session}" did not start`);
	}

	async workspaceList(): Promise<WorkspaceInfo[]> {
		return parseWorkspaceList(await this.call(['workspace', 'list']));
	}

	async workspaceCreate(cwd: string, label: string): Promise<{ workspaceId: string; rootPane: PaneInfo }> {
		const created = parseCreated(await this.call(['workspace', 'create', '--cwd', cwd, '--label', label, '--no-focus']));
		return { workspaceId: created.workspaceId, rootPane: created.rootPane };
	}

	async tabCreate(workspaceId: string, cwd: string): Promise<PaneInfo> {
		const result = await this.call(['tab', 'create', '--workspace', workspaceId, '--cwd', cwd, '--no-focus']);
		return parseCreated(result).rootPane;
	}

	/** All panes, or those of one workspace. */
	async paneList(workspaceId?: string): Promise<PaneInfo[]> {
		return parsePaneList(await this.call(['pane', 'list', ...(workspaceId ? ['--workspace', workspaceId] : [])]));
	}

	async agentList(): Promise<AgentInfo[]> {
		return parseAgentList(await this.call(['agent', 'list']));
	}

	/**
	 * Starts an agent in an existing pane. herdr answers `agent_not_ready` when the
	 * agent launched but is already blocked on a prompt (for example a trust dialog);
	 * the agent exists, so that is not a failure here.
	 */
	async agentStart(name: string, kind: string, paneId: string): Promise<void> {
		try {
			await this.call(['agent', 'start', name, '--kind', kind, '--pane', paneId], 60_000);
		} catch (e) {
			if (!(e instanceof HerdrError && e.code === 'agent_not_ready')) {
				throw e;
			}
		}
	}

	async agentRename(target: string, name: string): Promise<void> {
		await this.call(['agent', 'rename', target, name]);
	}

	async paneRename(paneId: string, label: string): Promise<void> {
		await this.call(['pane', 'rename', paneId, label]);
	}

	/** Kills the pane. Only the explicit Kill action may call this. */
	async paneClose(paneId: string): Promise<void> {
		await this.call(['pane', 'close', paneId]);
	}

	/** Long-lived writable stream for one pane; see frames.ts for the protocol. */
	async spawnControl(target: string, cols: number, rows: number): Promise<ChildProcessWithoutNullStreams> {
		const args = ['terminal', 'session', 'control', target, '--takeover', '--cols', String(cols), '--rows', String(rows)];
		return spawn(await this.binary(), args, { env: this.env });
	}

	/** Terminal command for herdr's one-line installer, offered when herdr is missing. */
	static readonly installCommand = 'curl -fsSL https://herdr.dev/install.sh | sh';
}
