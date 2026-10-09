// A one-row toolbar drawn above the herdr pane inside the VS Code terminal.
// herdr gets one row less than the terminal has; its frames place every cell
// with absolute cursor moves, so shifting those moves down a row frees row 1.

export type ToolbarAction = 'splitRight' | 'splitDown' | 'killSession';

/** `nerdFont` uses VS Code's codicons as Nerd Fonts ship them; `unicode` works in any font. */
export type ToolbarIcons = 'unicode' | 'nerdFont';

const ACTIONS: ToolbarAction[] = ['splitRight', 'splitDown', 'killSession'];

const GLYPHS: Record<ToolbarIcons, Record<ToolbarAction, string>> = {
  unicode: { splitRight: '◫', splitDown: '⊟', killSession: '✕' },
  // nf-cod-split_horizontal, nf-cod-split_vertical, nf-cod-close
  nerdFont: { splitRight: '\ueb56', splitDown: '\ueb57', killSession: '\uea76' },
};

/** Cells per button: the glyph with a space on each side. */
const BUTTON_WIDTH = 3;

/** Rows the toolbar takes from the terminal. */
export const TOOLBAR_ROWS = 1;

/** Reports focus changes as `ESC [ I` and `ESC [ O`. */
export const FOCUS_REPORTING_ON = '\x1b[?1004h';

// CUP (`ESC [ row ; col H` or `f`) and VPA (`ESC [ row d`), the absolute row moves in herdr's frames.
// oxlint-disable-next-line no-control-regex -- matching ESC is the point
const ROW_MOVE = /\x1b\[(\d*)(?:;(\d*))?([Hfd])/g;

/** Moves every absolute row in a frame down past the toolbar. */
export function shiftRows(bytes: string): string {
  return bytes.replace(ROW_MOVE, (_, row: string, col: string | undefined, final: string) => {
    const shifted = (Number(row) || 1) + TOOLBAR_ROWS;
    return final === 'd' ? `\x1b[${shifted}d` : `\x1b[${shifted};${col || 1}${final}`;
  });
}

/** Keeps anything that scrolls inside the pane's rows, below the toolbar. */
export function scrollRegion(rows: number): string {
  return `\x1b[${TOOLBAR_ROWS + 1};${rows}r`;
}

/** Row 1, redrawn after every frame: the buttons right-aligned when focused, else blank. */
export function drawToolbar(cols: number, focused: boolean, icons: ToolbarIcons = 'unicode'): string {
  const width = ACTIONS.length * BUTTON_WIDTH;
  const shown = focused && cols >= width;
  const buttons = shown ? ACTIONS.map(a => ` ${GLYPHS[icons][a]} `).join('') : '';
  const line = ' '.repeat(cols - (shown ? width : 0)) + buttons;
  // Save and restore the cursor (and its colours) so the pane's cursor stays put.
  return `\x1b7\x1b[1;1H\x1b[0;1m${line}\x1b[0m\x1b8`;
}

/** The button under a 1-based column of the toolbar row, if any. */
export function buttonAt(cols: number, col: number): ToolbarAction | undefined {
  const start = cols - ACTIONS.length * BUTTON_WIDTH + 1;
  const index = Math.floor((col - start) / BUTTON_WIDTH);
  return col >= start && index < ACTIONS.length ? ACTIONS[index] : undefined;
}

export interface ToolbarInput {
  /** Input left for the pane. */
  rest: string;
  /** Last focus report seen, if any. */
  focused?: boolean;
  clicks: ToolbarAction[];
}

// Focus reports and SGR mouse reports (ESC [ < button ; col ; row M|m).
// oxlint-disable-next-line no-control-regex -- matching ESC is the point
const TOOLBAR_INPUT = /\x1b\[([IO])|\x1b\[<(\d+);(\d+);(\d+)([Mm])/g;

/** Takes focus reports and clicks on the toolbar row out of terminal input. */
export function takeToolbarInput(data: string, cols: number): ToolbarInput {
  const result: ToolbarInput = { rest: '', clicks: [] };
  let last = 0;
  for (const m of data.matchAll(TOOLBAR_INPUT)) {
    const [whole, focus, button, col, row, kind] = m;
    if (focus) {
      result.focused = focus === 'I';
    } else if (Number(row) <= TOOLBAR_ROWS) {
      // A left press on a button; releases, other buttons and the wheel over the toolbar do nothing.
      const action = kind === 'M' && Number(button) === 0 ? buttonAt(cols, Number(col)) : undefined;
      if (action) {
        result.clicks.push(action);
      }
    } else {
      result.rest += data.slice(last, m.index) + whole;
      last = m.index + whole.length;
      continue;
    }
    result.rest += data.slice(last, m.index);
    last = m.index + whole.length;
  }
  result.rest += data.slice(last);
  return result;
}
