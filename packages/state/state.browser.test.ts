import { expect, it } from 'vitest';
import { PersistentState, type StandardSchemaV1 } from './src/state.svelte.js';

const numberSchema: StandardSchemaV1<number, number> = {
  '~standard': {
    version: 1,
    vendor: 'test',
    validate(value) {
      return typeof value === 'number'
        ? { value }
        : { issues: [{ message: 'number required' }] };
    },
  },
};

it('runs persistence effects in a real browser and disposes them', async () => {
  const writes: number[] = [];
  const state = new PersistentState('counter', numberSchema, {
    initial: 0,
    persistence: {
      read: () => null,
      write: (_key, value) => writes.push(JSON.parse(value) as number),
    },
  });

  await Promise.resolve();
  state.current = 1;
  await Promise.resolve();
  expect(writes).toContain(1);

  state.dispose();
  state.current = 2;
  await Promise.resolve();
  expect(writes).not.toContain(2);
});
