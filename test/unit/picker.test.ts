import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { ensureExcluded, writePick } from '../../src/picker/files';
import { filterStyles, formatPick, pickBaseName, trimHtml, type Pick } from '../../src/picker/format';
import { parsePickerMessage } from '../../src/picker/protocol';

const hero: Pick = {
  url: 'https://yapp.ink/',
  tag: 'h2',
  role: 'h2',
  selector: 'section.flex.h-svh > h2.max-w-\\[524px\\].text-3xl',
  react: 'Hero',
  text: 'Your All In One Creator Platform',
  nearby: ['1000+ Creators already Joined us', 'Start Exploring Become a Creator'],
  ancestorPath: 'section > div > body',
  domPath: 'body > div > section.flex.h-svh > h2.max-w-\\[524px\\].text-3xl',
  rect: { x: 10, y: 20, width: 524.4, height: 143.6 },
  html: '<h2 class="max-w-[524px] text-3xl">Your All In One Creator Platform</h2>',
  styles: [
    ['display', 'block'],
    ['font-size', '60px'],
  ],
};

describe('filterStyles', () => {
  const style = (o: Record<string, string>) => Object.entries(o).map(([name, value]) => ({ name, value }));

  it('drops defaults and properties outside layout, spacing, typography and colour', () => {
    expect(
      filterStyles(
        style({
          display: 'block',
          position: 'static',
          'font-size': '60px',
          color: 'lab(14.6704 0 0)',
          'background-color': 'rgba(0, 0, 0, 0)',
          cursor: 'pointer',
          'font-weight': '400',
          'line-height': '60px',
        }),
      ),
    ).toEqual([
      ['display', 'block'],
      ['font-size', '60px'],
      ['line-height', '60px'],
      ['color', 'lab(14.6704 0 0)'],
    ]);
  });

  it('folds four equal sides into the shorthand and keeps uneven ones apart', () => {
    const out = filterStyles(
      style({
        'margin-top': '8px',
        'margin-right': '8px',
        'margin-bottom': '8px',
        'margin-left': '8px',
        'padding-top': '4px',
        'padding-right': '12px',
        'padding-bottom': '4px',
        'padding-left': '12px',
        'border-top-width': '0px',
        'border-right-width': '0px',
        'border-bottom-width': '0px',
        'border-left-width': '0px',
      }),
    );
    expect(out).toEqual([
      ['margin', '8px'],
      ['padding-top', '4px'],
      ['padding-right', '12px'],
      ['padding-bottom', '4px'],
      ['padding-left', '12px'],
    ]);
  });

  it('keeps a side that differs when the first side is the default', () => {
    expect(
      filterStyles(
        style({ 'margin-top': '0px', 'margin-right': '0px', 'margin-bottom': '16px', 'margin-left': '0px' }),
      ),
    ).toEqual([['margin-bottom', '16px']]);
  });
});

describe('formatPick', () => {
  it('matches the pick layout, instruction last', () => {
    expect(formatPick(hero, '.paddock/picks/20261008-141005-h2.png', '  make this heading smaller on mobile ')).toBe(
      [
        'Attached browser context from https://yapp.ink/',
        '',
        'Selected element:',
        'h2',
        'Role: h2',
        'Selector: section.flex.h-svh > h2.max-w-\\[524px\\].text-3xl',
        'React: <Hero>',
        'Dimensions: 524x144',
        'Screenshot: .paddock/picks/20261008-141005-h2.png',
        '',
        'Text content:',
        'Your All In One Creator Platform',
        '',
        'Nearby context:',
        '- 1000+ Creators already Joined us',
        '- Start Exploring Become a Creator',
        '',
        'Computed styles:',
        '  display: block',
        '  font-size: 60px',
        '',
        'HTML:',
        '<h2 class="max-w-[524px] text-3xl">Your All In One Creator Platform</h2>',
        '',
        'Ancestor path: section > div > body',
        'Full DOM path: body > div > section.flex.h-svh > h2.max-w-\\[524px\\].text-3xl',
        '',
        'Instruction: make this heading smaller on mobile',
        '',
      ].join('\n'),
    );
  });

  it('leaves out what is missing', () => {
    const text = formatPick({ ...hero, react: undefined, text: '', nearby: [], styles: [] }, undefined, '   ');
    expect(text).not.toMatch(/React:|Screenshot:|Text content:|Nearby context:|Computed styles:|Instruction:/);
  });
});

describe('names and trimming', () => {
  it('names picks by local time and tag', () => {
    expect(pickBaseName(new Date(2026, 9, 8, 14, 10, 5), 'H2')).toBe('20261008-141005-h2');
    expect(pickBaseName(new Date(2026, 0, 2, 3, 4, 5), 'my:el')).toBe('20260102-030405-my-el');
  });

  it('collapses whitespace and cuts outer HTML to about 2 KB', () => {
    expect(trimHtml('<p>\n  a   b\n</p>')).toBe('<p> a b </p>');
    const long = trimHtml(`<div>${'x'.repeat(5000)}</div>`);
    expect(long.length).toBe(2001);
    expect(long.endsWith('…')).toBe(true);
  });
});

describe('parsePickerMessage', () => {
  const raw = {
    url: 'https://yapp.ink/',
    tag: 'h2',
    role: 'h2',
    selector: 'h2.title',
    text: 'Hello',
    nearby: ['a', 'b', 'c', 'd'],
    ancestorPath: 'section > body',
    domPath: 'body > section > h2.title',
    rect: { x: 1, y: 2, width: 3, height: 4 },
    html: '<h2>Hello</h2>',
    styles: [{ name: 'display', value: 'block' }, { name: 1 }],
  };

  it('accepts a pick from the page and trims what it carries', () => {
    const msg = parsePickerMessage(JSON.stringify({ type: 'picked', pick: { ...raw, text: 'x'.repeat(5000) } }));
    expect(msg).toMatchObject({
      type: 'picked',
      copyNow: false,
      pick: { nearby: ['a', 'b', 'c'], styles: [{ name: 'display', value: 'block' }], react: undefined },
    });
    expect(msg?.type === 'picked' && msg.pick.text.length).toBe(600);
    expect(parsePickerMessage(JSON.stringify({ type: 'picked', pick: raw, copyNow: true }))).toMatchObject({
      copyNow: true,
    });
  });

  it('accepts the card actions and caps the instruction', () => {
    expect(parsePickerMessage('{"type":"cancel"}')).toEqual({ type: 'cancel' });
    expect(parsePickerMessage(JSON.stringify({ type: 'send', instruction: 'x'.repeat(5000) }))).toEqual({
      type: 'send',
      instruction: 'x'.repeat(2000),
    });
  });

  it('drops anything else', () => {
    expect(parsePickerMessage('')).toBeUndefined();
    expect(parsePickerMessage('null')).toBeUndefined();
    expect(parsePickerMessage('{"type":"copy"}')).toBeUndefined();
    expect(parsePickerMessage('{"type":"eval","code":"1"}')).toBeUndefined();
    expect(parsePickerMessage(JSON.stringify({ type: 'picked', pick: { ...raw, rect: { x: 'a' } } }))).toBeUndefined();
    expect(parsePickerMessage(JSON.stringify({ type: 'picked', pick: { ...raw, tag: undefined } }))).toBeUndefined();
  });
});

describe('pick files', () => {
  let dir: string | undefined;
  afterEach(() => {
    if (dir) {
      rmSync(dir, { recursive: true, force: true });
    }
  });
  const repo = () => {
    dir = mkdtempSync(join(tmpdir(), 'paddock-picks-'));
    execFileSync('git', ['init', '-q'], { cwd: dir });
    return dir;
  };

  it('writes .md and .png side by side and never overwrites', async () => {
    const root = repo();
    const at = new Date(2026, 9, 8, 14, 10, 5);
    const first = await writePick(root, hero, Buffer.from('png'), 'smaller', at);
    const second = await writePick(root, hero, Buffer.from('png'), '', at);
    expect(first.relPath).toBe('.paddock/picks/20261008-141005-h2.md');
    expect(second.relPath).toBe('.paddock/picks/20261008-141005-h2-2.md');
    expect(readFileSync(first.file, 'utf8')).toBe(first.text);
    expect(first.text).toContain('Screenshot: .paddock/picks/20261008-141005-h2.png');
    expect(first.text).toContain('Instruction: smaller');
    expect(readFileSync(join(root, '.paddock/picks/20261008-141005-h2.png'), 'utf8')).toBe('png');
  });

  it('adds .paddock/ to .git/info/exclude once, not to .gitignore', async () => {
    const root = repo();
    const exclude = join(root, '.git', 'info', 'exclude');
    writeFileSync(exclude, '# mine\n*.log');
    await ensureExcluded(root);
    await ensureExcluded(root);
    expect(readFileSync(exclude, 'utf8')).toBe('# mine\n*.log\n.paddock/\n');
    expect(execFileSync('git', ['status', '--porcelain'], { cwd: root, encoding: 'utf8' })).toBe('');
    await writePick(root, hero, undefined, '');
    expect(execFileSync('git', ['status', '--porcelain'], { cwd: root, encoding: 'utf8' })).toBe('');
  });

  it('does nothing to git outside a repository', async () => {
    dir = mkdtempSync(join(tmpdir(), 'paddock-plain-'));
    await expect(ensureExcluded(dir)).resolves.toBeUndefined();
  });
});
