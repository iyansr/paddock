// The newline-delimited JSON protocol of `herdr terminal session control`.
// Shapes confirmed against herdr 0.9.3; they are not part of `herdr api schema`.

export type StreamRecord =
  | { type: 'frame'; bytes: Buffer; full: boolean; seq: number; width: number; height: number }
  | { type: 'closed'; reason: string };

/** Splits a stream of chunks into complete lines. */
export class LineSplitter {
  private rest = '';

  push(chunk: string): string[] {
    const parts = (this.rest + chunk).split('\n');
    this.rest = parts.pop() ?? '';
    return parts.filter(line => line.trim() !== '');
  }
}

/** Returns undefined for lines that are not a record Paddock understands. */
export function parseStreamLine(line: string): StreamRecord | undefined {
  let json: unknown;
  try {
    json = JSON.parse(line);
  } catch {
    return undefined;
  }
  if (typeof json !== 'object' || json === null) {
    return undefined;
  }
  const r = json as Record<string, unknown>;
  if (r.type === 'terminal.frame' && typeof r.bytes === 'string') {
    return {
      type: 'frame',
      bytes: Buffer.from(r.bytes, 'base64'),
      full: r.full === true,
      seq: typeof r.seq === 'number' ? r.seq : 0,
      width: typeof r.width === 'number' ? r.width : 0,
      height: typeof r.height === 'number' ? r.height : 0,
    };
  }
  if (r.type === 'terminal.closed') {
    return { type: 'closed', reason: typeof r.reason === 'string' ? r.reason : 'closed' };
  }
  return undefined;
}

export type ControlCommand =
  | { type: 'terminal.input'; text: string }
  | { type: 'terminal.resize'; cols: number; rows: number }
  | { type: 'terminal.scroll'; direction: 'up' | 'down'; lines: number }
  | { type: 'terminal.release' };

export function encodeCommand(command: ControlCommand): string {
  return JSON.stringify(command) + '\n';
}

/**
 * Asks the VS Code terminal to report mouse events as SGR sequences. herdr's
 * frames are repaints and never carry the app's own mouse mode, so without this
 * the wheel scrolls VS Code's scrollback, which holds none of the pane's history.
 */
export const MOUSE_REPORTING_ON = '\x1b[?1000h\x1b[?1006h';

/**
 * Asks the VS Code terminal to wrap pastes in bracketed-paste markers. herdr's
 * frames never carry the app's paste mode either, so without this a multi-line
 * paste arrives as typed lines and each newline submits. herdr strips the
 * markers again when the app did not ask for them.
 */
export const BRACKETED_PASTE_ON = '\x1b[?2004h';

/** Lines scrolled per wheel report. */
export const WHEEL_LINES = 3;

// SGR mouse report: ESC [ < button ; col ; row (M press | m release).
// oxlint-disable-next-line no-control-regex -- matching ESC is the point
const SGR_MOUSE = /\x1b\[<(\d+);\d+;\d+[Mm]/g;
// Shift, Alt and Ctrl bits added to the button code.
const MODIFIERS = 4 | 8 | 16;

/**
 * Splits terminal input into control commands: wheel reports become
 * `terminal.scroll` (herdr scrolls its own scrollback, or forwards the wheel to an
 * app that asked for the mouse), other mouse reports are dropped, and the rest is
 * passed on as typed input.
 */
export function translateInput(data: string): ControlCommand[] {
  const commands: ControlCommand[] = [];
  let text = '';
  let last = 0;
  for (const match of data.matchAll(SGR_MOUSE)) {
    text += data.slice(last, match.index);
    last = match.index + match[0].length;
    const button = Number(match[1]) & ~MODIFIERS;
    if (button !== 64 && button !== 65) {
      continue;
    }
    if (text) {
      commands.push({ type: 'terminal.input', text });
      text = '';
    }
    const direction = button === 64 ? 'up' : 'down';
    const prev = commands.at(-1);
    if (prev?.type === 'terminal.scroll' && prev.direction === direction) {
      prev.lines += WHEEL_LINES;
    } else {
      commands.push({ type: 'terminal.scroll', direction, lines: WHEEL_LINES });
    }
  }
  text += data.slice(last);
  if (text) {
    commands.push({ type: 'terminal.input', text });
  }
  return commands;
}
