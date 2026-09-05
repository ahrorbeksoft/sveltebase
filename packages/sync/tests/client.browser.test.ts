import { afterEach, describe, expect, it } from 'vitest';
import { createLiveQuery, SyncClient } from '../src/client/index.js';

type Todo = { id: string; title: string; order: number };
const clients: Array<SyncClient<{ todos: Todo }>> = [];

afterEach(async () => {
  for (const client of clients.splice(0).reverse()) await client.purge();
});

describe('SyncClient browser storage', () => {
  it('treats an undefined live-query value as loaded and supports disposal', async () => {
    const query = createLiveQuery(() => undefined);
    for (let index = 0; index < 20 && query.isLoading; index++)
      await new Promise((resolve) => setTimeout(resolve, 1));
    expect(query.data).toBeUndefined();
    expect(query.isLoading).toBe(false);
    query.dispose();
  });

  it('surfaces a live-query error as settled state', async () => {
    const query = createLiveQuery(async () => {
      throw new Error('query failed');
    });
    for (let index = 0; index < 20 && query.isLoading; index++)
      await new Promise((resolve) => setTimeout(resolve, 1));
    expect(query.error).toMatchObject({ message: 'query failed' });
    expect(query.isLoading).toBe(false);
    query.dispose();
  });

  it('atomically persists optimistic state and an account-isolated outbox', async () => {
    const name = `sync-browser-${crypto.randomUUID()}`;
    const first = new SyncClient<{ todos: Todo }>({
      name,
      accountId: 'account-a',
      url: 'ws://invalid.test',
      autoStart: false,
      tables: { todos: { indexes: 'id, order', channel: 'todos' } },
    });
    clients.push(first);
    const receipt = await first.create('todos', {
      id: 'one',
      title: 'offline',
      order: 1,
    });
    await receipt.local;
    expect(await first.read('todos').get('one')).toMatchObject({
      title: 'offline',
    });
    first.dispose();

    const restored = new SyncClient<{ todos: Todo }>({
      name,
      accountId: 'account-a',
      url: 'ws://invalid.test',
      autoStart: false,
      tables: { todos: { indexes: 'id, order', channel: 'todos' } },
    });
    clients.push(restored);
    expect(await restored.read('todos').get('one')).toMatchObject({
      title: 'offline',
    });

    const other = new SyncClient<{ todos: Todo }>({
      name,
      accountId: 'account-b',
      url: 'ws://invalid.test',
      autoStart: false,
      tables: { todos: { indexes: 'id, order', channel: 'todos' } },
    });
    clients.push(other);
    expect(await other.read('todos').get('one')).toBeUndefined();
  });

  it('rejects conflicting channels and reserved stores', () => {
    expect(
      () =>
        new SyncClient({
          name: 'bad',
          accountId: 'a',
          url: 'ws://invalid.test',
          autoStart: false,
          tables: {
            a: { indexes: 'id', channel: 'same' },
            b: { indexes: 'id', channel: 'same' },
          },
        }),
    ).toThrow(/Duplicate/);
    expect(
      () =>
        new SyncClient({
          name: 'bad',
          accountId: 'a',
          url: 'ws://invalid.test',
          autoStart: false,
          tables: { __sync_meta: { indexes: 'id', channel: 'meta' } },
        }),
    ).toThrow(/Reserved/);
  });
});
