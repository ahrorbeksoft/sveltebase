import { PersistentState, State, type StandardSchemaV1 } from '../src/index.js';

type Input = { theme: 'light' | 'dark' };
type Output = Input & { normalized: true };

declare const schema: StandardSchemaV1<Input, Output>;

const persistent = new PersistentState('theme', schema, {
  initial: { theme: 'light' },
  persistence: false,
});

const output: Output = persistent.current;
void output;
persistent.current = { theme: 'dark' };

// @ts-expect-error Schema output is not assignable when required transformed data is missing.
persistent.current = { theme: 'dark', normalized: false };

const count = new State(0);
count.set((value) => value + 1);

// @ts-expect-error Updaters must retain the State value type.
count.set(() => 'one');
