import type { ChildProcessWithoutNullStreams } from 'node:child_process';
import { StringDecoder } from 'node:string_decoder';

import * as vscode from 'vscode';

import type { Herdr } from './cli';
import { encodeCommand, LineSplitter, parseStreamLine, type ControlCommand } from './frames';

export interface PtyEvents {
	/** The VS Code terminal went away (tab closed, or the window is shutting down). */
	onClosed(): void;
}

/**
 * A VS Code terminal that draws one herdr pane through
 * `herdr terminal session control`. Closing it releases the pane (the agent keeps
 * running); only the Kill action in the sidebar closes the pane itself.
 */
export class HerdrPty implements vscode.Pseudoterminal {
	private readonly write = new vscode.EventEmitter<string>();
	private readonly close_ = new vscode.EventEmitter<number | void>();
	private readonly nameChanged = new vscode.EventEmitter<string>();
	readonly onDidChangeName = this.nameChanged.event;
	readonly onDidWrite = this.write.event;
	readonly onDidClose = this.close_.event;

	private proc: ChildProcessWithoutNullStreams | undefined;
	private pending: ControlCommand[] = [];
	private released = false;
	private ended = false;

	constructor(
		private readonly herdr: Herdr,
		private readonly paneId: string,
		private readonly events: PtyEvents,
	) {}

	open(initial: vscode.TerminalDimensions | undefined): void {
		void this.start(initial?.columns ?? 80, initial?.rows ?? 24);
	}

	close(): void {
		if (this.ended) {
			this.events.onClosed();
			return;
		}
		this.released = true;
		this.send({ type: 'terminal.release' });
		// herdr exits on release; make sure it does not linger if it does not.
		const proc = this.proc;
		if (proc) {
			setTimeout(() => proc.kill(), 1000).unref();
		}
		this.events.onClosed();
	}

	/** Retitles the terminal tab. */
	setName(name: string): void {
		this.nameChanged.fire(name);
	}

	handleInput(data: string): void {
		this.send({ type: 'terminal.input', text: data });
	}

	setDimensions(dimensions: vscode.TerminalDimensions): void {
		this.send({ type: 'terminal.resize', cols: dimensions.columns, rows: dimensions.rows });
	}

	private send(command: ControlCommand): void {
		if (!this.proc) {
			// Keep only the latest resize while the process starts.
			this.pending = [...this.pending.filter(c => c.type !== command.type || c.type === 'terminal.input'), command];
			return;
		}
		if (this.proc.stdin.writable) {
			this.proc.stdin.write(encodeCommand(command));
		}
	}

	private async start(cols: number, rows: number): Promise<void> {
		let proc: ChildProcessWithoutNullStreams;
		try {
			proc = await this.herdr.spawnControl(this.paneId, cols, rows);
		} catch (e) {
			this.fail(`could not start herdr: ${e instanceof Error ? e.message : String(e)}`);
			return;
		}
		this.proc = proc;
		const decoder = new StringDecoder('utf8');
		const lines = new LineSplitter();
		let stderr = '';

		proc.stdout.setEncoding('utf8');
		proc.stdout.on('data', (chunk: string) => {
			for (const line of lines.push(chunk)) {
				const record = parseStreamLine(line);
				if (record?.type === 'frame') {
					this.write.fire(decoder.write(record.bytes));
				} else if (record?.type === 'closed' && !this.released) {
					// The pane exited or another controller took over. VS Code does not
					// always call close() when the pty closes itself, so report it here too.
					this.ended = true;
					this.events.onClosed();
					this.close_.fire(0);
				}
			}
		});
		proc.stderr.setEncoding('utf8');
		proc.stderr.on('data', (chunk: string) => {
			stderr += chunk;
		});
		proc.on('error', e => this.fail(`herdr failed: ${e.message}`));
		proc.on('exit', code => {
			if (!this.released && !this.ended) {
				this.fail(`herdr stream ended (exit ${code}). ${stderr.trim()}`);
			}
		});

		for (const command of this.pending) {
			this.send(command);
		}
		this.pending = [];
	}

	/** Leaves the terminal open with a message so the user can see what went wrong. */
	private fail(message: string): void {
		this.ended = true;
		this.write.fire(`\r\n\x1b[31m[paddock] ${message.replace(/\n/g, '\r\n')}\x1b[0m\r\n`);
	}
}
