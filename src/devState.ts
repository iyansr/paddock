// Keeps a development or test run of Paddock away from the data of an installed Paddock.
// No VS Code import, so it stays unit-testable.

/** Key prefix for state written by a non-production run. */
export const DEV_PREFIX = 'dev:';

/** The herdr session a non-production run uses in place of `paddock`, which holds the real agents. */
export const DEV_SESSION = 'paddock-dev';

/** The parts of `vscode.Memento` (and `globalState`) Paddock calls through. */
export interface StateLike {
  keys(): readonly string[];
  get<T>(key: string): T | undefined;
  get<T>(key: string, defaultValue: T): T;
  update(key: string, value: unknown): PromiseLike<void>;
  setKeysForSync?(keys: readonly string[]): void;
}

/** A view of `inner` where every key carries DEV_PREFIX, so dev and production entries never meet. */
export function prefixedState(inner: StateLike, prefix = DEV_PREFIX): StateLike {
  return {
    keys: () =>
      inner
        .keys()
        .filter(k => k.startsWith(prefix))
        .map(k => k.slice(prefix.length)),
    get: <T>(key: string, defaultValue?: T) => inner.get<T>(prefix + key) ?? defaultValue,
    update: (key, value) => inner.update(prefix + key, value),
    setKeysForSync: keys => inner.setKeysForSync?.(keys.map(k => prefix + k)),
  } as StateLike;
}

/** The herdr session for this run: a non-production run never uses the production default. */
export function sessionFor(configured: string, production: boolean): string {
  const session = configured || 'paddock';
  return !production && session === 'paddock' ? DEV_SESSION : session;
}
