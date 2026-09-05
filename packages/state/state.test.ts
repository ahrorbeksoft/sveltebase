import { describe, expect, it, vi } from 'vitest';
import {
  PersistentState,
  State,
  type StandardSchemaV1,
} from './src/state.svelte.js';

type Preferences = { theme: 'light' | 'dark'; nested: { size: number } };

const preferencesSchema: StandardSchemaV1<Preferences, Preferences> = {
  '~standard': {
    version: 1,
    vendor: 'test',
    validate(value) {
      if (
        typeof value === 'object' &&
        value !== null &&
        (value as Preferences).theme !== undefined &&
        ((value as Preferences).theme === 'light' ||
          (value as Preferences).theme === 'dark') &&
        typeof (value as Preferences).nested?.size === 'number'
      ) {
        return { value: value as Preferences };
      }
      return { issues: [{ message: 'invalid preferences' }] };
    },
  },
};

function memoryPersistence() {
  const values = new Map<string, string>();
  return {
    values,
    read: (key: string) => values.get(key) ?? null,
    write: (key: string, value: string) => values.set(key, value),
  };
}

describe('PersistentState', () => {
  it('validates assignment and updater callbacks, with immutable snapshots', () => {
    const state = new PersistentState('preferences', preferencesSchema, {
      initial: { theme: 'light', nested: { size: 1 } },
      persistence: false,
    });

    expect(() => {
      state.current = { theme: 'invalid', nested: { size: 1 } } as never;
    }).toThrow('invalid preferences');
    expect(() =>
      state.set(() => ({ theme: 'invalid', nested: { size: 1 } }) as never),
    ).toThrow('invalid preferences');
    expect(() => {
      state.current.nested.size = 2;
    }).toThrow();
    expect(state.current).toEqual({ theme: 'light', nested: { size: 1 } });
  });

  it('hydrates valid persistence and stops writes after disposal', async () => {
    const persistence = memoryPersistence();
    persistence.values.set(
      'preferences',
      JSON.stringify({ theme: 'dark', nested: { size: 1 } }),
    );
    const state = new PersistentState('preferences', preferencesSchema, {
      initial: { theme: 'light', nested: { size: 1 } },
      persistence,
    });

    expect(state.current.theme).toBe('dark');
    await Promise.resolve();
    state.current = { theme: 'light', nested: { size: 2 } };
    await Promise.resolve();
    expect(persistence.values.get('preferences')).toContain('"light"');

    state.dispose();
    state.current = { theme: 'dark', nested: { size: 3 } };
    await Promise.resolve();
    expect(persistence.values.get('preferences')).toContain('"light"');
  });

  it('reports persistence read and write failures without invalidating state', async () => {
    const observed: Error[] = [];
    const state = new PersistentState('preferences', preferencesSchema, {
      initial: { theme: 'light', nested: { size: 1 } },
      persistence: {
        read: () => {
          throw new Error('storage unavailable');
        },
        write: () => {
          throw new Error('quota exceeded');
        },
      },
      onPersistenceError: (error) => observed.push(error),
    });

    await Promise.resolve();
    state.current = { theme: 'dark', nested: { size: 2 } };
    await Promise.resolve();
    expect(state.current.theme).toBe('dark');
    expect(observed.map((error) => error.message)).toContain(
      'storage unavailable',
    );
    expect(observed.map((error) => error.message)).toContain('quota exceeded');
    expect(state.persistenceError?.message).toBe('quota exceeded');
  });

  it("resets missing and malformed server cookies to this request's initial value", () => {
    vi.stubGlobal('window', undefined);
    vi.stubGlobal('document', undefined);
    try {
      const state = new PersistentState('preferences', preferencesSchema, {
        initial: { theme: 'light', nested: { size: 1 } },
      });
      state.init([{ name: 'preferences', value: 'not-json' }]);
      expect(state.current.theme).toBe('light');
      state.init([
        {
          name: 'preferences',
          value: JSON.stringify({ theme: 'dark', nested: { size: 4 } }),
        },
      ]);
      expect(state.current).toEqual({ theme: 'dark', nested: { size: 4 } });
      state.init([]);
      expect(state.current).toEqual({ theme: 'light', nested: { size: 1 } });
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('rejects asynchronous schemas consistently', () => {
    const asyncSchema: StandardSchemaV1<string, string> = {
      '~standard': {
        version: 1,
        vendor: 'test',
        validate: async (value) => ({ value: String(value) }),
      },
    };
    expect(
      () =>
        new PersistentState('value', asyncSchema, {
          initial: 'one',
          persistence: false,
        }),
    ).toThrow('synchronous schemas');
  });

  it('rejects mutable built-ins that Object.freeze cannot make immutable', () => {
    expect(() => new State({ updatedAt: new Date() })).toThrow(
      'plain objects and arrays',
    );
    expect(() => new State({ tags: new Set(['one']) })).toThrow(
      'plain objects and arrays',
    );
  });

  it('keeps in-memory State snapshots immutable through assignments and updaters', () => {
    const state = new State({ count: 1, nested: { value: 'one' } });
    state.current = { count: 2, nested: { value: 'two' } };
    state.set((value) => ({ ...value, count: value.count + 1 }));
    expect(state.current).toEqual({ count: 3, nested: { value: 'two' } });
    expect(Object.isFrozen(state.current.nested)).toBe(true);
  });

  it('uses browser cookie persistence and rejects invalid serializers before an update', async () => {
    const state = new PersistentState(
      'state-default-persistence',
      preferencesSchema,
      {
        initial: { theme: 'light', nested: { size: 1 } },
        cookie: { sameSite: 'Strict' },
      },
    );
    state.current = { theme: 'dark', nested: { size: 5 } };
    await Promise.resolve();
    expect(document.cookie).toContain('state-default-persistence=');

    expect(
      () =>
        new PersistentState('invalid-serializer', preferencesSchema, {
          initial: { theme: 'light', nested: { size: 1 } },
          persistence: false,
          serialize: () => undefined as never,
        }),
    ).toThrow('serialize to a string');
  });
});
