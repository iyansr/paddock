// Session presets for New Session: the `paddock.agents` setting, or the agents found on this
// machine when the setting is empty. Nothing here imports VS Code.

export interface Preset {
  label: string;
  /** herdr agent kind; undefined starts a plain shell. */
  kind?: string;
}

export interface KnownAgent {
  kind: string;
  label: string;
  /** Programs that show the agent is installed, in the order they are checked. */
  executables: readonly string[];
}

/**
 * herdr 0.9.3's `agent start --kind` values. The kind is herdr's canonical executable, except
 * where the CLI ships under another name: `cursor` is the Cursor editor's launcher, so only
 * `cursor-agent` counts for the cursor kind.
 */
export const KNOWN_AGENTS: readonly KnownAgent[] = [
  { kind: 'claude', label: 'Claude Code', executables: ['claude'] },
  { kind: 'codex', label: 'Codex', executables: ['codex'] },
  { kind: 'gemini', label: 'Gemini CLI', executables: ['gemini'] },
  { kind: 'opencode', label: 'opencode', executables: ['opencode'] },
  { kind: 'cursor', label: 'Cursor Agent', executables: ['cursor-agent'] },
  { kind: 'copilot', label: 'GitHub Copilot CLI', executables: ['copilot'] },
  { kind: 'amp', label: 'Amp', executables: ['amp'] },
  { kind: 'droid', label: 'Droid', executables: ['droid'] },
  { kind: 'pi', label: 'Pi', executables: ['pi'] },
  { kind: 'omp', label: 'Oh My Pi', executables: ['omp'] },
  { kind: 'kimi', label: 'Kimi Code', executables: ['kimi'] },
  { kind: 'qwen', label: 'Qwen Code', executables: ['qwen'] },
  { kind: 'grok', label: 'Grok CLI', executables: ['grok'] },
  { kind: 'cline', label: 'Cline', executables: ['cline'] },
  { kind: 'kilo', label: 'Kilo Code', executables: ['kilo', 'kilocode'] },
  { kind: 'kiro', label: 'Kiro CLI', executables: ['kiro-cli'] },
  { kind: 'devin', label: 'Devin', executables: ['devin'] },
  { kind: 'agy', label: 'Antigravity', executables: ['agy'] },
  { kind: 'hermes', label: 'Hermes', executables: ['hermes'] },
  { kind: 'mastracode', label: 'Mastra Code', executables: ['mastracode'] },
  { kind: 'qodercli', label: 'Qoder CLI', executables: ['qodercli'] },
  { kind: 'letta', label: 'Letta Code', executables: ['letta'] },
  { kind: 'maki', label: 'Maki', executables: ['maki'] },
  { kind: 'muse', label: 'Muse', executables: ['muse'] },
];

const SHELL: Preset = { label: 'Shell' };

/** Offered before detection has finished, or when it failed. */
export const DEFAULT_PRESETS: readonly Preset[] = [
  { label: 'Claude Code', kind: 'claude' },
  { label: 'Codex', kind: 'codex' },
  SHELL,
];

/** Every program name detection looks for. */
export function knownExecutables(): string[] {
  return [...new Set(KNOWN_AGENTS.flatMap(a => a.executables))];
}

/** The known agents with at least one program in `found`, in catalog order, then a shell. */
export function detectedPresets(found: ReadonlySet<string>): Preset[] {
  const agents = KNOWN_AGENTS.filter(a => a.executables.some(e => found.has(e)));
  return [...agents.map(a => ({ label: a.label, kind: a.kind })), SHELL];
}

/** herdr checks the kind itself; this only keeps arbitrary text out of its argument list. */
const KIND = /^[a-z][a-z0-9_-]{0,31}$/;

/**
 * Reads `paddock.agents`: `[{ "name": "Claude Code", "kind": "claude" }, …]`, where an entry
 * without `kind` is a shell. Invalid entries are skipped. Undefined when the setting is empty or
 * holds nothing valid, meaning "use the detected agents".
 */
export function presetsFrom(setting: unknown): Preset[] | undefined {
  if (!Array.isArray(setting)) {
    return undefined;
  }
  const presets: Preset[] = [];
  for (const entry of setting) {
    if (typeof entry !== 'object' || entry === null) {
      continue;
    }
    const { name, kind } = entry as Record<string, unknown>;
    if (typeof name !== 'string' || !name.trim()) {
      continue;
    }
    if (kind === undefined || kind === '') {
      presets.push({ label: name.trim() });
    } else if (typeof kind === 'string' && KIND.test(kind)) {
      presets.push({ label: name.trim(), kind });
    }
  }
  return presets.length > 0 ? presets : undefined;
}

/** The setting wins; otherwise the detected agents; otherwise the defaults. */
export function resolvePresets(setting: unknown, detected: readonly Preset[] | undefined): Preset[] {
  return presetsFrom(setting) ?? [...(detected ?? DEFAULT_PRESETS)];
}
