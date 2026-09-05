import { createAsync, type AsyncResult } from '../src/index.js';

const save = createAsync(async (id: string): Promise<AsyncResult> => ({
  success: id,
}));

void save.run('row-1');
void save.runWithKey('row-1', 'row-1');

// @ts-expect-error The wrapped operation argument remains a string.
void save.run(1);

// @ts-expect-error A keyed call still requires the wrapped operation argument.
void save.runWithKey('row-1', 1);
