import type { ChildProcessWithoutNullStreams } from 'node:child_process';
import { StringDecoder } from 'node:string_decoder';

import * as vscode from 'vscode';

import type { Herdr } from './cli';
import {
  BRACKETED_PASTE_ON,
  encodeCommand,
  LineSplitter,
  MOUSE_REPORTING_ON,
  parseStreamLine,
  translateInput,
  type ControlCommand,
} from './frames';
import {
  drawToolbar,
  FOCUS_REPORTING_ON,
  scrollRegion,
  shiftRows,
  takeToolbarInput,
  TOOLBAR_ROWS,
  type ToolbarAction,
  type ToolbarIcons,
} from './toolbar';

export interface PtyEvents {
  /** The VS Code terminal went away (tab closed, or the window is shutting down). */
  onClosed(): void;
  /** A toolbar button was clicked. */
  onAction(action: ToolbarAction): void;
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
  private cols = 80;
  private rows = 24;
  private focused = false;
  private icons: ToolbarIcons = 'unicode';

  constructor(
    private readonly herdr: Herdr,
    private readonly paneId: string,
    private readonly events: PtyEvents,
  ) {}

  open(initial: vscode.TerminalDimensions | undefined): void {
    this.cols = initial?.columns ?? this.cols;
    this.rows = initial?.rows ?? this.rows;
    this.write.fire(this.modes() + this.toolbar());
    void this.start(this.cols, this.paneRows());
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

  /** Switches the toolbar glyphs (the `paddock.toolbarIcons` setting). */
  setIcons(icons: ToolbarIcons): void {
    if (icons !== this.icons) {
      this.icons = icons;
      this.write.fire(this.toolbar());
    }
  }

  private toolbar(): string {
    return drawToolbar(this.cols, this.focused, this.icons);
  }

  /** Shows or hides the toolbar buttons; also driven by the terminal's own focus reports. */
  setFocused(focused: boolean): void {
    if (focused !== this.focused) {
      this.focused = focused;
      this.write.fire(this.toolbar());
    }
  }

  handleInput(data: string): void {
    const { rest, focused, clicks } = takeToolbarInput(data, this.cols);
    if (focused !== undefined) {
      this.setFocused(focused);
    }
    for (const action of clicks) {
      this.events.onAction(action);
    }
    for (const command of translateInput(rest)) {
      this.send(command);
    }
  }

  setDimensions(dimensions: vscode.TerminalDimensions): void {
    this.cols = dimensions.columns;
    this.rows = dimensions.rows;
    this.write.fire(scrollRegion(this.rows) + this.toolbar());
    this.send({ type: 'terminal.resize', cols: this.cols, rows: this.paneRows() });
  }

  /** Rows herdr draws into, below the toolbar. */
  private paneRows(): number {
    return Math.max(1, this.rows - TOOLBAR_ROWS);
  }

  /** Terminal modes Paddock relies on; a full frame follows a reset, so they are re-sent with it. */
  private modes(): string {
    return MOUSE_REPORTING_ON + BRACKETED_PASTE_ON + FOCUS_REPORTING_ON + scrollRegion(this.rows);
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
          this.write.fire((record.full ? this.modes() : '') + shiftRows(decoder.write(record.bytes)) + this.toolbar());
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
