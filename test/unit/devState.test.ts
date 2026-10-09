import { describe, expect, it } from 'vitest';

import { DEV_SESSION, prefixedState, sessionFor, type StateLike } from '../../src/devState';

function memory(): StateLike & { data: Map<string, unknown> } {
  const data = new Map<string, unknown>();
  return {
    data,
    keys: () => [...data.keys()],
    get: <T>(key: string, defaultValue?: T) => (data.has(key) ? (data.get(key) as T) : defaultValue),
    update: async (key: string, value: unknown) => {
      data.set(key, value);
    },
  } as StateLike & { data: Map<string, unknown> };
}

describe('prefixedState', () => {
  it('keeps dev entries apart from production ones', async () => {
    const inner = memory();
    await inner.update('paddock.data', 'prod');
    const dev = prefixedState(inner);
    expect(dev.get('paddock.data')).toBeUndefined();
    await dev.update('paddock.data', 'dev');
    expect(inner.get('paddock.data')).toBe('prod');
    expect(inner.get('dev:paddock.data')).toBe('dev');
    expect(dev.get('paddock.data')).toBe('dev');
    expect(dev.keys()).toEqual(['paddock.data']);
  });

  it('returns the default for a missing key', () => {
    expect(prefixedState(memory()).get('missing', 3)).toBe(3);
  });
});

describe('sessionFor', () => {
  it('keeps production on the configured session', () => {
    expect(sessionFor('paddock', true)).toBe('paddock');
    expect(sessionFor('', true)).toBe('paddock');
  });

  it('moves a dev run off the production session', () => {
    expect(sessionFor('paddock', false)).toBe(DEV_SESSION);
    expect(sessionFor('', false)).toBe(DEV_SESSION);
    expect(sessionFor('mine', false)).toBe('mine');
  });
});
