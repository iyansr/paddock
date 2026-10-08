// Maps herdr's agent states onto what Paddock shows. Pure: no VS Code, no processes.

export type SessionState = 'running' | 'waiting' | 'done';

/**
 * `working` and `unknown` show as running, `blocked` as waiting, `done` and `idle` as done.
 * A pane with no agent is a live shell, so it shows as running (a pane that exited is gone from herdr's list).
 */
export function mapStatus(status: string | undefined, hasAgent: boolean): SessionState {
  if (!hasAgent) {
    return 'running';
  }
  switch (status) {
    case 'blocked':
      return 'waiting';
    case 'done':
    case 'idle':
      return 'done';
    default:
      return 'running';
  }
}

export interface StatusEntry {
  paneId: string;
  workspaceId: string;
  state: SessionState;
}

/** Waiting sessions per herdr workspace id. */
export function waitingByWorkspace(entries: readonly StatusEntry[]): Map<string, number> {
  const counts = new Map<string, number>();
  for (const e of entries) {
    if (e.state === 'waiting') {
      counts.set(e.workspaceId, (counts.get(e.workspaceId) ?? 0) + 1);
    }
  }
  return counts;
}

/**
 * Pane ids that started waiting since `previous`. A pane missing from `previous` counts
 * as new, so a session that appears already blocked is reported; callers skip the very
 * first poll so existing blocked sessions do not all notify at startup.
 */
export function newlyWaiting(
  previous: ReadonlyMap<string, SessionState>,
  current: readonly StatusEntry[],
): StatusEntry[] {
  return current.filter(e => e.state === 'waiting' && previous.get(e.paneId) !== 'waiting');
}

export interface IntegrationStatus {
  kind: string;
  /** `current`, `outdated` or `not installed`. */
  state: string;
}

/** Parses `herdr integration status` lines such as `claude: outdated (v7 < v10) (/path)`. */
export function parseIntegrationStatus(text: string): IntegrationStatus[] {
  const out: IntegrationStatus[] = [];
  for (const line of text.split('\n')) {
    const m = /^([a-z][a-z0-9-]*)(?: \([^)]*\))?:\s*(current|outdated|not installed)\b/.exec(line.trim());
    if (m) {
      out.push({ kind: m[1], state: m[2] });
    }
  }
  return out;
}
