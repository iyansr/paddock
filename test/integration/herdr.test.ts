import { execFileSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { Herdr, herdrEnv } from '../../src/herdr/cli';
import { encodeCommand, LineSplitter, parseStreamLine } from '../../src/herdr/frames';
import { HerdrError, isSupportedVersion } from '../../src/herdr/parse';

// A throwaway session. Never the real `paddock` session: it holds real agents.
const session = `paddock-test-${randomBytes(4).toString('hex')}`;
const herdr = new Herdr(() => ({ path: '', session }));

beforeAll(async () => {
  await herdr.ensureServer();
});

afterAll(async () => {
  // herdr has no CLI wrapper for this in cli.ts on purpose; stop the throwaway server directly.
  const { execFile } = await import('node:child_process');
  await new Promise(resolve =>
    execFile('herdr', ['server', 'stop'], { env: herdrEnv(process.env, session) }, () => resolve(undefined)),
  );
  await new Promise(r => setTimeout(r, 500));
  rmSync(join(homedir(), '.config', 'herdr', 'sessions', session), { recursive: true, force: true });
});

describe('herdr (real server, throwaway session)', () => {
  it('is a supported version and the server is up', async () => {
    expect(isSupportedVersion(await herdr.version())).toBe(true);
    expect(await herdr.serverRunning()).toBe(true);
  });

  it('creates a workspace and tabs, lists panes, and kills one pane', async () => {
    const { workspaceId, rootPane } = await herdr.workspaceCreate('/tmp', 'itest');
    expect((await herdr.workspaceList()).map(w => w.workspaceId)).toContain(workspaceId);

    const second = await herdr.tabCreate(workspaceId, '/tmp');
    const panes = await herdr.paneList(workspaceId);
    expect(panes.map(p => p.paneId).sort()).toEqual([rootPane.paneId, second.paneId].sort());
    expect(await herdr.agentList()).toEqual([]);

    await herdr.paneClose(second.paneId);
    expect((await herdr.paneList(workspaceId)).map(p => p.paneId)).toEqual([rootPane.paneId]);
  });

  it('send-text types into a pane without pressing Enter', async () => {
    const { rootPane } = await herdr.workspaceCreate('/tmp', 'sendtext');
    const proc = await herdr.spawnControl(rootPane.paneId, 80, 24);
    const lines = new LineSplitter();
    let screen = '';
    proc.stdout.setEncoding('utf8');
    proc.stdout.on('data', (chunk: string) => {
      for (const line of lines.push(chunk)) {
        const rec = parseStreamLine(line);
        if (rec?.type === 'frame') {
          screen += rec.bytes.toString('utf8');
        }
      }
    });
    const until = async (ok: () => boolean) => {
      for (let i = 0; i < 100 && !ok(); i++) {
        await new Promise(r => setTimeout(r, 100));
      }
      expect(ok()).toBe(true);
    };
    await until(() => screen.length > 0);
    await herdr.paneSendText(rootPane.paneId, ' echo sent-$((6*7)) ');
    await until(() => screen.includes('sent-$((6*7))'));
    await new Promise(r => setTimeout(r, 500));
    expect(screen).not.toContain('sent-42');
    proc.stdin.write(encodeCommand({ type: 'terminal.input', text: '\r' }));
    await until(() => screen.includes('sent-42'));
    proc.stdin.write(encodeCommand({ type: 'terminal.release' }));
    await herdr.paneClose(rootPane.paneId);
  });

  it('streams a pane: frames out, input in, resize, release detaches', async () => {
    const { rootPane } = await herdr.workspaceCreate('/tmp', 'stream');
    const proc = await herdr.spawnControl(rootPane.paneId, 80, 24);
    const lines = new LineSplitter();
    let screen = '';
    let closedReason: string | undefined;
    let widest = 0;
    proc.stdout.setEncoding('utf8');
    proc.stdout.on('data', (chunk: string) => {
      for (const line of lines.push(chunk)) {
        const rec = parseStreamLine(line);
        if (rec?.type === 'frame') {
          screen += rec.bytes.toString('utf8');
          widest = Math.max(widest, rec.width);
        } else if (rec?.type === 'closed') {
          closedReason = rec.reason;
        }
      }
    });
    const until = async (ok: () => boolean) => {
      for (let i = 0; i < 100 && !ok(); i++) {
        await new Promise(r => setTimeout(r, 100));
      }
      expect(ok()).toBe(true);
    };

    await until(() => screen.length > 0);
    proc.stdin.write(encodeCommand({ type: 'terminal.input', text: 'echo paddock-$((6*7))\r' }));
    await until(() => screen.includes('paddock-42'));

    proc.stdin.write(encodeCommand({ type: 'terminal.resize', cols: 100, rows: 30 }));
    await until(() => widest === 100);

    proc.stdin.write(encodeCommand({ type: 'terminal.release' }));
    await until(() => closedReason === 'detached');
    // Released, not killed: the pane is still there.
    expect((await herdr.paneList()).map(p => p.paneId)).toContain(rootPane.paneId);
  });

  it('removes the pane and reports `closed` when the shell exits', async () => {
    const { workspaceId, rootPane } = await herdr.workspaceCreate('/tmp', 'exit');
    const other = await herdr.tabCreate(workspaceId, '/tmp');
    const proc = await herdr.spawnControl(other.paneId, 80, 24);
    const lines = new LineSplitter();
    let closed: string | undefined;
    proc.stdout.setEncoding('utf8');
    proc.stdout.on('data', (chunk: string) => {
      for (const line of lines.push(chunk)) {
        const rec = parseStreamLine(line);
        if (rec?.type === 'closed') {
          closed = rec.reason;
        }
      }
    });
    await new Promise(r => setTimeout(r, 800));
    proc.stdin.write(encodeCommand({ type: 'terminal.input', text: 'exit\r' }));
    for (let i = 0; i < 100 && !closed; i++) {
      await new Promise(r => setTimeout(r, 100));
    }
    // Any reason other than our own release means the pane is gone.
    expect(closed).toMatch(/exited/);
    expect((await herdr.paneList(workspaceId)).map(p => p.paneId)).toEqual([rootPane.paneId]);
  });

  it('lists, creates, reopens and removes worktrees', async () => {
    // A throwaway repository; herdr puts its worktrees under ~/.herdr/worktrees/<repo name>.
    const parent = mkdtempSync(join(tmpdir(), 'paddock-itest-'));
    const name = `paddock-itest-${randomBytes(4).toString('hex')}`;
    const repo = join(parent, name);
    mkdirSync(repo);
    const git = (...args: string[]) => execFileSync('git', args, { cwd: repo, stdio: 'ignore' });
    git('init', '-q', '-b', 'main');
    git('-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-q', '--allow-empty', '-m', 'init');
    try {
      const [main] = await herdr.worktreeList(repo);
      expect(main).toMatchObject({ branch: 'main', linked: false });

      const created = await herdr.worktreeCreate(repo, 'feat-a');
      expect(created.worktree).toMatchObject({ branch: 'feat-a', linked: true, openWorkspaceId: created.workspaceId });
      expect(created.rootPane?.workspaceId).toBe(created.workspaceId);
      expect((await herdr.workspaceList()).find(w => w.workspaceId === created.workspaceId)?.checkoutPath).toBe(
        created.worktree.path,
      );

      // Closing the last pane closes the workspace; the checkout stays and can be reopened.
      await herdr.paneClose(created.rootPane!.paneId);
      const closed = (await herdr.worktreeList(repo)).find(w => w.path === created.worktree.path);
      expect(closed?.openWorkspaceId).toBeUndefined();
      const reopened = await herdr.worktreeOpen(repo, created.worktree.path);
      expect(reopened.rootPane).toBeDefined();

      // Uncommitted changes need --force; the branch survives removal.
      writeFileSync(join(created.worktree.path, 'dirty.txt'), 'x');
      const dirty = await herdr.worktreeRemove(reopened.workspaceId, false).catch((e: unknown) => e);
      expect(dirty).toBeInstanceOf(HerdrError);
      expect((dirty as HerdrError).code).toBe('dirty_worktree_requires_force');
      await herdr.worktreeRemove(reopened.workspaceId, true);
      expect((await herdr.worktreeList(repo)).map(w => w.path)).toEqual([main.path]);
      expect(execFileSync('git', ['branch', '--list', 'feat-a'], { cwd: repo, encoding: 'utf8' })).toContain('feat-a');

      const notRepo = await herdr.worktreeList(parent).catch((e: unknown) => e);
      expect((notRepo as HerdrError).code).toBe('not_git_worktree');
    } finally {
      rmSync(parent, { recursive: true, force: true });
      rmSync(join(homedir(), '.herdr', 'worktrees', name), { recursive: true, force: true });
    }
  });
});
