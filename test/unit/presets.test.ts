import { chmod, mkdtemp, rm, writeFile } from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { AgentCatalog } from '../../src/agents';
import { findInDirs, lookupInLoginShell, parseCommandV } from '../../src/detect';
import { DEFAULT_PRESETS, detectedPresets, knownExecutables, presetsFrom, resolvePresets } from '../../src/presets';

describe('presetsFrom', () => {
  it('reads named agents and shells', () => {
    expect(presetsFrom([{ name: 'Gemini', kind: 'gemini' }, { name: ' Shell ' }, { name: 'Bare', kind: '' }])).toEqual([
      { label: 'Gemini', kind: 'gemini' },
      { label: 'Shell' },
      { label: 'Bare' },
    ]);
  });

  it('skips invalid entries', () => {
    expect(
      presetsFrom([
        null,
        'claude',
        { kind: 'claude' },
        { name: '' },
        { name: 'Bad', kind: 'rm -rf' },
        { name: 'Ok', kind: 'codex' },
      ]),
    ).toEqual([{ label: 'Ok', kind: 'codex' }]);
  });

  it('is undefined when nothing is set', () => {
    expect(presetsFrom(undefined)).toBeUndefined();
    expect(presetsFrom([])).toBeUndefined();
    expect(presetsFrom([{ name: 'Bad', kind: 7 }])).toBeUndefined();
  });
});

describe('resolvePresets', () => {
  const detected = [{ label: 'Pi', kind: 'pi' }, { label: 'Shell' }];
  it('prefers the setting, then detection, then the defaults', () => {
    expect(resolvePresets([{ name: 'Mine', kind: 'amp' }], detected)).toEqual([{ label: 'Mine', kind: 'amp' }]);
    expect(resolvePresets([], detected)).toEqual(detected);
    expect(resolvePresets(undefined, undefined)).toEqual(DEFAULT_PRESETS);
  });
});

describe('detectedPresets', () => {
  it('keeps catalog order and ends with a shell', () => {
    expect(detectedPresets(new Set(['pi', 'claude']))).toEqual([
      { label: 'Claude Code', kind: 'claude' },
      { label: 'Pi', kind: 'pi' },
      { label: 'Shell' },
    ]);
  });
  it('does not take the Cursor editor launcher for the agent', () => {
    expect(detectedPresets(new Set(['cursor']))).toEqual([{ label: 'Shell' }]);
    expect(detectedPresets(new Set(['cursor-agent']))[0]).toEqual({ label: 'Cursor Agent', kind: 'cursor' });
  });
  it('lists every program once', () => {
    const names = knownExecutables();
    expect(new Set(names).size).toBe(names.length);
    expect(names).toContain('kilocode');
  });
});

describe('parseCommandV', () => {
  it('keeps absolute paths of the names asked for', () => {
    const out = 'Welcome to zsh\n/usr/local/bin/claude\nalias codex=foo\n/opt/x/other\n  /Users/me/.bun/bin/omp  \n';
    expect([...parseCommandV(out, ['claude', 'codex', 'omp'])].sort()).toEqual(['claude', 'omp']);
  });
});

describe('detection on disk', () => {
  let dir: string;
  beforeAll(async () => {
    dir = await mkdtemp(path.join(os.tmpdir(), 'paddock-detect-'));
    await writeFile(path.join(dir, 'claude'), '#!/bin/sh\n');
    await chmod(path.join(dir, 'claude'), 0o755);
    await writeFile(path.join(dir, 'codex'), 'not executable');
  });
  afterAll(() => rm(dir, { recursive: true, force: true }));

  it('finds executable files only', async () => {
    expect([...(await findInDirs(['claude', 'codex', 'pi'], [dir, '/nonexistent']))]).toEqual(['claude']);
  });

  it('asks a POSIX shell, with names passed as arguments', async () => {
    const found = await lookupInLoginShell(['sh', 'no-such-program-paddock', '$(touch /tmp/x)'], '/bin/sh');
    expect([...found]).toEqual(['sh']);
  });

  it('skips shells it cannot script', async () => {
    expect((await lookupInLoginShell(['sh'], '/usr/bin/fish')).size).toBe(0);
    expect((await lookupInLoginShell(['sh'], 'zsh')).size).toBe(0);
  });
});

describe('AgentCatalog', () => {
  it('offers what was found, and the defaults when detection fails', async () => {
    const ok = new AgentCatalog(async () => new Set(['codex']));
    expect(await ok.presets(undefined)).toEqual([{ label: 'Codex', kind: 'codex' }, { label: 'Shell' }]);
    const broken = new AgentCatalog(() => Promise.reject(new Error('boom')));
    expect(await broken.presets([])).toEqual(DEFAULT_PRESETS);
  });
});
