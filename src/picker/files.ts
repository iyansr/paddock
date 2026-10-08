// Writes picks under `.paddock/picks/` and keeps `.paddock/` out of git. No VS Code.

import { execFile } from 'node:child_process';
import { mkdir, readFile, stat, writeFile } from 'node:fs/promises';
import * as path from 'node:path';

import { formatPick, pickBaseName, type Pick } from './format';

export const PICKS_DIR = path.join('.paddock', 'picks');
const EXCLUDE_LINE = '.paddock/';

export interface WrittenPick {
  /** The `.md` file, absolute. */
  file: string;
  /** The `.md` file relative to the checkout, with forward slashes. */
  relPath: string;
  /** The browser context block, instruction included. */
  text: string;
}

async function exists(file: string): Promise<boolean> {
  try {
    await stat(file);
    return true;
  } catch {
    return false;
  }
}

/** Writes `<timestamp>.md` (and `<timestamp>.png` when there is a screenshot) into the checkout's picks folder. */
export async function writePick(
  checkout: string,
  pick: Pick,
  screenshot: Buffer | undefined,
  instruction: string,
  at = new Date(),
): Promise<WrittenPick> {
  const dir = path.join(checkout, PICKS_DIR);
  await mkdir(dir, { recursive: true });
  await ensureExcluded(checkout);
  const base = pickBaseName(at, pick.tag);
  let name = base;
  for (let i = 2; (await exists(path.join(dir, `${name}.md`))) || (await exists(path.join(dir, `${name}.png`))); i++) {
    name = `${base}-${i}`;
  }
  const rel = (file: string) => [...PICKS_DIR.split(path.sep), file].join('/');
  if (screenshot) {
    await writeFile(path.join(dir, `${name}.png`), screenshot);
  }
  const text = formatPick(pick, screenshot ? rel(`${name}.png`) : undefined, instruction);
  const file = path.join(dir, `${name}.md`);
  await writeFile(file, text, 'utf8');
  return { file, relPath: rel(`${name}.md`), text };
}

/** Where git reads this checkout's exclude file; linked worktrees share the main repository's. */
function excludePath(checkout: string): Promise<string | undefined> {
  return new Promise(resolve => {
    execFile(
      'git',
      ['rev-parse', '--git-path', 'info/exclude'],
      { cwd: checkout, timeout: 10_000 },
      (error, stdout) => {
        const out = stdout.trim();
        resolve(error || !out ? undefined : path.resolve(checkout, out));
      },
    );
  });
}

/** Adds `.paddock/` to `.git/info/exclude` once. Never touches the project's `.gitignore`; does nothing outside git. */
export async function ensureExcluded(checkout: string): Promise<void> {
  const file = await excludePath(checkout);
  if (!file) {
    return;
  }
  let current = '';
  try {
    current = await readFile(file, 'utf8');
  } catch {
    // no exclude file yet
  }
  if (current.split(/\r?\n/).some(l => l.trim() === EXCLUDE_LINE || l.trim() === '/.paddock/')) {
    return;
  }
  await mkdir(path.dirname(file), { recursive: true });
  const sep = current && !current.endsWith('\n') ? '\n' : '';
  await writeFile(file, `${current}${sep}${EXCLUDE_LINE}\n`, 'utf8');
}
