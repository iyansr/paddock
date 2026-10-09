import { describe, expect, it } from 'vitest';

import { buttonAt, drawToolbar, scrollRegion, shiftRows, takeToolbarInput } from '../../src/herdr/toolbar';

describe('shiftRows', () => {
  it('moves absolute rows down one, keeping columns', () => {
    expect(shiftRows('\x1b[1;1Hab\x1b[10;52H x')).toBe('\x1b[2;1Hab\x1b[11;52H x');
  });

  it('treats missing parameters as 1', () => {
    expect(shiftRows('\x1b[H\x1b[;5H\x1b[3H\x1b[f')).toBe('\x1b[2;1H\x1b[2;5H\x1b[4;1H\x1b[2;1f');
  });

  it('shifts VPA and leaves other sequences alone', () => {
    expect(shiftRows('\x1b[4d\x1b[2J\x1b[0;39;49m\x1b[?25h\x1b[3A')).toBe(
      '\x1b[5d\x1b[2J\x1b[0;39;49m\x1b[?25h\x1b[3A',
    );
  });

  it('handles a real herdr frame', () => {
    const frame = '\x1b[?2026h\x1b[?25l\x1b[2J\x1b[1;1H\x1b[0;39;49mline\x1b[2;1H \x1b[0m\x1b[1;1H\x1b[?25h\x1b[?2026l';
    expect(shiftRows(frame)).toBe(
      '\x1b[?2026h\x1b[?25l\x1b[2J\x1b[2;1H\x1b[0;39;49mline\x1b[3;1H \x1b[0m\x1b[2;1H\x1b[?25h\x1b[?2026l',
    );
  });
});

describe('toolbar drawing', () => {
  it('keeps scrolling below the toolbar', () => {
    expect(scrollRegion(24)).toBe('\x1b[2;24r');
  });

  it('right-aligns the buttons when focused and blanks the row otherwise', () => {
    expect(drawToolbar(12, true)).toBe('\x1b7\x1b[1;1H\x1b[0;1m    ◫  ⊟  ✕ \x1b[0m\x1b8');
    expect(drawToolbar(12, false)).toBe(`\x1b7\x1b[1;1H\x1b[0;1m${' '.repeat(12)}\x1b[0m\x1b8`);
  });

  it('uses codicons from a Nerd Font when asked', () => {
    expect(drawToolbar(9, true, 'nerdFont')).toContain(' \ueb56  \ueb57  \uea76 ');
  });

  it('hides the buttons when they do not fit', () => {
    expect(drawToolbar(5, true)).toContain(' '.repeat(5));
  });
});

describe('buttonAt', () => {
  it('maps the last nine columns to the three buttons', () => {
    expect(buttonAt(12, 3)).toBeUndefined();
    expect(buttonAt(12, 4)).toBe('splitRight');
    expect(buttonAt(12, 6)).toBe('splitRight');
    expect(buttonAt(12, 7)).toBe('splitDown');
    expect(buttonAt(12, 12)).toBe('killSession');
  });
});

describe('takeToolbarInput', () => {
  it('takes left presses on the toolbar row and drops their release', () => {
    expect(takeToolbarInput('\x1b[<0;12;1M\x1b[<0;12;1m', 12)).toEqual({ rest: '', clicks: ['killSession'] });
  });

  it('ignores presses on the toolbar outside the buttons, and other buttons', () => {
    expect(takeToolbarInput('\x1b[<0;1;1M\x1b[<2;12;1M\x1b[<64;5;1M', 12)).toEqual({ rest: '', clicks: [] });
  });

  it('passes typing and mouse reports below the toolbar on', () => {
    expect(takeToolbarInput('ab\x1b[<64;5;3Mc', 12)).toEqual({ rest: 'ab\x1b[<64;5;3Mc', clicks: [] });
  });

  it('takes focus reports, keeping the last', () => {
    expect(takeToolbarInput('\x1b[Ix\x1b[O', 12)).toEqual({ rest: 'x', focused: false, clicks: [] });
  });
});
