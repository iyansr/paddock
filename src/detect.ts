// Finds which agent programs are installed. Uses Node only; nothing here imports VS Code.
import { execFile } from 'node:child_process';
import { constants } from 'node:fs';
import { access } from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';

/** Install spots that a PATH without the user's shell setup tends to miss. */
export function commonDirs(home = os.homedir()): string[] {
  return [
    path.join(home, '.local', 'bin'),
    path.join(home, '.bun', 'bin'),
    path.join(home, '.npm-global', 'bin'),
    path.join(home, 'Library', 'pnpm'),
    path.join(home, '.local', 'share', 'pnpm'),
    path.join(home, '.cargo', 'bin'),
    path.join(home, 'go', 'bin'),
    '/opt/homebrew/bin',
    '/usr/local/bin',
  ];
}

/**
 * Reads the output of `command -v` for each name: only absolute paths whose file name is one
 * we asked for count, so aliases, functions and anything an rc file prints are ignored.
 */
export function parseCommandV(stdout: string, names: readonly string[]): Set<string> {
  const wanted = new Set(names);
  const found = new Set<string>();
  for (const line of stdout.split('\n')) {
    const p = line.trim();
    if (p.startsWith('/') && wanted.has(path.basename(p))) {
      found.add(path.basename(p));
    }
  }
  return found;
}

/** Shells whose syntax the lookup script uses; others (fish, nu) skip straight to the directory scan. */
const POSIX_SHELLS = new Set(['sh', 'bash', 'zsh', 'dash', 'ksh']);

const LOOKUP_SCRIPT = 'for c in "$@"; do command -v "$c"; done; exit 0';

/**
 * Asks the user's login shell where the programs are, the way VS Code resolves the shell
 * environment (`-i -l -c`), so PATH entries from rc files count. The script is fixed and the
 * names are passed as arguments, never spliced into it.
 */
export function lookupInLoginShell(
  names: readonly string[],
  shell = process.env.SHELL ?? '',
  timeout = 5000,
): Promise<Set<string>> {
  if (!path.isAbsolute(shell) || !POSIX_SHELLS.has(path.basename(shell))) {
    return Promise.resolve(new Set());
  }
  return new Promise(resolve => {
    const child = execFile(shell, ['-i', '-l', '-c', LOOKUP_SCRIPT, 'paddock', ...names], { timeout }, (_e, stdout) =>
      resolve(parseCommandV(String(stdout ?? ''), names)),
    );
    // An rc file that waits for input (an update prompt) gets end-of-file instead of hanging.
    child.stdin?.end();
  });
}

/** Looks for each program as an executable file in `dirs`. */
export async function findInDirs(names: readonly string[], dirs: readonly string[]): Promise<Set<string>> {
  const found = new Set<string>();
  await Promise.all(
    names.flatMap(name =>
      dirs.map(async dir => {
        try {
          await access(path.join(dir, name), constants.X_OK);
          found.add(name);
        } catch {
          // not here
        }
      }),
    ),
  );
  return found;
}

/** Which of `names` are installed: the login shell's answer plus a scan of PATH and the usual spots. */
export async function detectExecutables(names: readonly string[]): Promise<Set<string>> {
  const pathDirs = (process.env.PATH ?? '').split(path.delimiter).filter(d => path.isAbsolute(d));
  const [fromShell, fromDirs] = await Promise.all([
    lookupInLoginShell(names),
    findInDirs(names, [...new Set([...pathDirs, ...commonDirs()])]),
  ]);
  return new Set([...fromShell, ...fromDirs]);
}
