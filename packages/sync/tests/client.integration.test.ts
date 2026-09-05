import { afterEach, describe, expect, it } from 'vitest';
import { createSyncClient, SyncClient } from '../src/client/index.js';
import type { SocketLike } from '../src/client/transport.js';

type SocketEvent = { data?: unknown };
class ProtocolSocket implements SocketLike {
  readyState = 0;
  sent: Array<Record<string, unknown>> = [];
  listeners = new Map<string, Set<(event: SocketEvent) => void>>();
  constructor(readonly snapshotRows: unknown[] | null) {
    queueMicrotask(() => this.open());
  }
  addEventListener(type: string, listener: (event: SocketEvent) => void) {
    const set = this.listeners.get(type) ?? new Set();
    set.add(listener);
    this.listeners.set(type, set);
  }
  removeEventListener(type: string, listener: (event: SocketEvent) => void) {
    this.listeners.get(type)?.delete(listener);
  }
  close() {
    this.readyState = 3;
    this.emit('close', {});
  }
  open() {
    this.readyState = 1;
    this.emit('open', {});
  }
  emit(type: string, event: SocketEvent) {
    for (const listener of this.listeners.get(type) ?? []) listener(event);
  }
  reply(message: Record<string, unknown>) {
    this.emit('message', { data: JSON.stringify({ v: 1, ...message }) });
  }
  send(data: string) {
    const message = JSON.parse(data) as Record<string, unknown>;
    this.sent.push(message);
    if (message.type === 'subscribe' && this.snapshotRows)
      queueMicrotask(() =>
        this.reply({
          type: 'snapshot',
          requestId: message.requestId,
          channel: message.channel,
          mode: 'full',
          rows: this.snapshotRows,
          cursor: 1,
          viewVersion: 'v1',
        }),
      );
  }
}

const clients: Array<SyncClient<{ todos: { id: string; value: number } }>> = [];
afterEach(async () => {
  for (const client of clients.splice(0).reverse()) {
    try {
      await client.purge();
    } catch {
      client.dispose();
    }
  }
});
const waitFor = async (predicate: () => boolean | Promise<boolean>) => {
  for (let index = 0; index < 100; index++) {
    if (await predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 1));
  }
  throw new Error('condition not reached');
};

describe('SyncClient reconciliation', () => {
  it('validates explicit mutation, namespace, and lifecycle boundaries', async () => {
    const base = {
      name: `sync-validation-${crypto.randomUUID()}`,
      accountId: 'a',
      url: 'ws://example.test',
      autoStart: false as const,
      tables: { todos: { indexes: 'id', channel: 'todos' } },
    };
    expect(() => new SyncClient({ ...base, accountId: '' })).toThrow(
      /required/,
    );
    expect(
      () =>
        new SyncClient({
          ...base,
          tables: { todos: { indexes: 'id', channel: '' } },
        }),
    ).toThrow(/empty sync channel/);
    expect(
      () =>
        new SyncClient({
          ...base,
          tables: { todos: { indexes: '++id', channel: 'todos' } },
        }),
    ).toThrow(/primary key/);
    const client = new SyncClient<{ todos: { id: string; value: number } }>(
      base,
    );
    clients.push(client);
    await expect(client.create('todos', { id: '', value: 1 })).rejects.toThrow(
      /non-empty/,
    );
    await expect(client.update('todos', 'one', { id: 'two' })).rejects.toThrow(
      /change id/,
    );
    await expect(
      client.update('todos', 'one', JSON.parse('{"__proto__":1}')),
    ).rejects.toThrow(/Unsafe patch key/);
    await expect(client.update('todos', 'one', { value: 1 })).rejects.toThrow(
      /missing local row/,
    );
    await expect(client.delete('todos', '')).rejects.toThrow(/non-empty/);
    expect(() => client.read('missing' as 'todos')).toThrow(/No sync table/);
    await expect(client.resyncChannel('missing')).rejects.toThrow(
      /No sync table/,
    );
    await expect(client.purgeAccount('other')).rejects.toThrow(/own account/);
    client.dispose();
    await expect(client.start()).rejects.toThrow(/disposed/);
    await expect(client.reconnect()).rejects.toThrow(/disposed/);
    await expect(
      client.create('todos', { id: 'one', value: 1 }),
    ).rejects.toThrow(/disposed/);
  });

  it('does not recreate transport or subscriptions for an unchanged context key', async () => {
    let sockets = 0;
    const dynamic = createSyncClient<
      { todos: { id: string; value: number } },
      { subject: string }
    >(
      ({ subject }) => ({
        name: `sync-dynamic-${subject}`,
        accountId: subject,
        url: 'ws://example.test',
        tables: { todos: { indexes: 'id', channel: 'todos' } },
        transport: {
          socketFactory: () => {
            sockets++;
            return new ProtocolSocket([]);
          },
        },
      }),
      { contextKey: ({ subject }) => subject },
    );
    dynamic.setContext({ subject: 'one' });
    await waitFor(() => sockets === 1);
    const first = dynamic.client;
    dynamic.setContext({ subject: 'one' });
    await new Promise((resolve) => setTimeout(resolve, 5));
    expect(dynamic.client).toBe(first);
    expect(sockets).toBe(1);
    dynamic.setContext({ subject: 'two' });
    await waitFor(() => sockets === 2);
    expect(dynamic.client).not.toBe(first);
    dynamic.setContext(undefined);
    expect(dynamic.client).toBeUndefined();
    dynamic.dispose();
  });

  it('exposes dynamic lifecycle state and notifies creation and teardown', () => {
    const dynamic = createSyncClient<
      { todos: { id: string; value: number } },
      string
    >((subject) => ({
      name: `sync-dynamic-${subject}`,
      accountId: subject,
      url: 'ws://example.test',
      autoStart: false,
      tables: { todos: { indexes: 'id', channel: 'todos' } },
    }));
    const events: Array<string | undefined> = [];
    const unsubscribe = dynamic.onClientChange((_client, context) =>
      events.push(context),
    );
    expect(dynamic.status).toBe('stopped');
    expect(dynamic.isSyncing).toBe(false);
    expect(dynamic.pendingMutationCount).toBe(0);
    expect(dynamic.pendingFetchCount).toBe(0);
    dynamic.setContext('one');
    expect(dynamic.client).toBeDefined();
    dynamic.stop();
    dynamic.setContext(null);
    expect(events).toEqual(['one', undefined]);
    unsubscribe();
    dynamic.dispose();

    const invalid = createSyncClient<
      { todos: { id: string } },
      { subject: string }
    >((context) => ({
      name: 'invalid',
      accountId: context.subject,
      url: 'ws://example.test',
      autoStart: false,
      tables: { todos: { indexes: 'id', channel: 'todos' } },
    }));
    expect(() => invalid.setContext({ subject: 'one' })).toThrow(/contextKey/);
    invalid.dispose();
  });

  it('rolls back the optimistic row when durable outbox persistence fails', async () => {
    const client = new SyncClient<{ todos: { id: string; value: number } }>({
      name: `sync-integration-${crypto.randomUUID()}`,
      accountId: 'subject-1',
      url: 'ws://example.test',
      autoStart: false,
      tables: { todos: { indexes: 'id', channel: 'todos' } },
    });
    clients.push(client);
    const original = IDBObjectStore.prototype.add;
    IDBObjectStore.prototype.add = function (
      value: unknown,
      key?: IDBValidKey,
    ) {
      if (this.name === '__sync_outbox')
        throw new DOMException('quota', 'QuotaExceededError');
      return key === undefined
        ? original.call(this, value)
        : original.call(this, value, key);
    };
    try {
      await expect(
        client.create('todos', { id: 'one', value: 1 }),
      ).rejects.toMatchObject({ name: 'QuotaExceededError' });
    } finally {
      IDBObjectStore.prototype.add = original;
    }
    expect(await client.read('todos').get('one')).toBeUndefined();
  });

  it('rebuilds a rejected older edit without overwriting a newer pending edit', async () => {
    let socket!: ProtocolSocket;
    const client = new SyncClient<{ todos: { id: string; value: number } }>({
      name: `sync-integration-${crypto.randomUUID()}`,
      accountId: 'subject-1',
      url: 'ws://example.test',
      autoStart: false,
      tables: { todos: { indexes: 'id', channel: 'todos' } },
      transport: {
        socketFactory: () =>
          (socket = new ProtocolSocket([{ id: 'one', value: 0 }])),
      },
    });
    clients.push(client);
    await client.start();
    await waitFor(
      () =>
        socket.sent.some((message) => message.type === 'subscribe') &&
        client.pendingFetchCount === 0,
    );

    const first = await client.update('todos', 'one', { value: 1 });
    const second = await client.update('todos', 'one', { value: 2 });
    await waitFor(
      () =>
        socket.sent.filter((message) => message.type === 'mutate').length === 2,
    );
    socket.reply({
      type: 'reject',
      id: first.id,
      error: { code: 'forbidden', message: 'rejected' },
    });
    await expect(first.confirmed).rejects.toThrow('rejected');
    expect(await client.read('todos').get('one')).toEqual({
      id: 'one',
      value: 2,
    });

    socket.reply({
      type: 'ack',
      id: second.id,
      data: { id: 'one', value: 3 },
      cursor: 3,
      revision: 3,
    });
    await expect(second.confirmed).resolves.toEqual({ id: 'one', value: 3 });
    expect(await client.read('todos').get('one')).toEqual({
      id: 'one',
      value: 3,
    });
  });

  it('coalesces concurrent full resyncs by channel', async () => {
    let socket!: ProtocolSocket;
    const client = new SyncClient<{ todos: { id: string; value: number } }>({
      name: `sync-integration-${crypto.randomUUID()}`,
      accountId: 'subject-1',
      url: 'ws://example.test',
      autoStart: false,
      tables: { todos: { indexes: 'id', channel: 'todos' } },
      transport: { socketFactory: () => (socket = new ProtocolSocket([])) },
    });
    clients.push(client);
    await client.start();
    await waitFor(
      () =>
        client.pendingFetchCount === 0 &&
        socket.sent.some((message) => message.type === 'subscribe'),
    );
    const before = socket.sent.length;
    await Promise.all([
      client.resyncChannel('todos'),
      client.resyncChannel('todos'),
    ]);
    expect(
      socket.sent
        .slice(before)
        .filter((message) => message.type === 'subscribe'),
    ).toHaveLength(1);
  });

  it('ignores a stale ack after a newer canonical change', async () => {
    let socket!: ProtocolSocket;
    const client = new SyncClient<{ todos: { id: string; value: number } }>({
      name: `sync-integration-${crypto.randomUUID()}`,
      accountId: 'subject-1',
      url: 'ws://example.test',
      autoStart: false,
      tables: { todos: { indexes: 'id', channel: 'todos' } },
      transport: {
        socketFactory: () =>
          (socket = new ProtocolSocket([{ id: 'one', value: 0 }])),
      },
    });
    clients.push(client);
    await client.start();
    await waitFor(
      () =>
        client.pendingFetchCount === 0 &&
        socket.sent.some((message) => message.type === 'subscribe'),
    );
    const edit = await client.update('todos', 'one', { value: 1 });
    socket.reply({
      type: 'change',
      channel: 'todos',
      change: { kind: 'full', key: 'one', row: { id: 'one', value: 5 } },
      cursor: 5,
      revision: 5,
    });
    socket.reply({
      type: 'ack',
      id: edit.id,
      data: { id: 'one', value: 2 },
      cursor: 2,
      revision: 2,
    });
    await edit.confirmed;
    expect(await client.read('todos').get('one')).toEqual({
      id: 'one',
      value: 5,
    });
  });

  it('lets a canonical change at the same revision replace a data-less ack', async () => {
    let socket!: ProtocolSocket;
    const client = new SyncClient<{
      todos: { id: string; value: number; server?: boolean };
    }>({
      name: `sync-integration-${crypto.randomUUID()}`,
      accountId: 'subject-1',
      url: 'ws://example.test',
      autoStart: false,
      tables: { todos: { indexes: 'id', channel: 'todos' } },
      transport: {
        socketFactory: () =>
          (socket = new ProtocolSocket([{ id: 'one', value: 0 }])),
      },
    });
    await client.start();
    await waitFor(
      () =>
        socket.sent.some((message) => message.type === 'subscribe') &&
        client.pendingFetchCount === 0,
    );
    const edit = await client.update('todos', 'one', { value: 1 });
    socket.reply({ type: 'ack', id: edit.id, cursor: 2, revision: 2 });
    socket.reply({
      type: 'change',
      channel: 'todos',
      change: {
        kind: 'full',
        key: 'one',
        row: { id: 'one', value: 2, server: true },
      },
      cursor: 2,
      revision: 2,
    });
    await edit.confirmed;
    await waitFor(
      async () => (await client.read('todos').get('one'))?.server === true,
    );
    expect(await client.read('todos').get('one')).toEqual({
      id: 'one',
      value: 2,
      server: true,
    });
    await client.purge();
  });

  it('materializes a patch for an absent row with the protocol key', async () => {
    let socket!: ProtocolSocket;
    const client = new SyncClient<{ todos: { id: string; value: number } }>({
      name: `sync-integration-${crypto.randomUUID()}`,
      accountId: 'subject-1',
      url: 'ws://example.test',
      autoStart: false,
      tables: { todos: { indexes: 'id', channel: 'todos' } },
      transport: { socketFactory: () => (socket = new ProtocolSocket([])) },
    });
    clients.push(client);
    await client.start();
    await waitFor(
      () =>
        socket.sent.some((message) => message.type === 'subscribe') &&
        client.pendingFetchCount === 0,
    );
    socket.reply({
      type: 'change',
      channel: 'todos',
      change: { kind: 'patch', key: 'one', patch: { value: 7 } },
      cursor: 2,
      revision: 2,
    });
    await waitFor(
      async () => (await client.read('todos').get('one'))?.value === 7,
    );
    expect(await client.read('todos').get('one')).toEqual({
      id: 'one',
      value: 7,
    });
  });

  it('restores a rejected delete and applies authoritative tombstones', async () => {
    let socket!: ProtocolSocket;
    const errors: unknown[] = [];
    const client = new SyncClient<{ todos: { id: string; value: number } }>({
      name: `sync-integration-${crypto.randomUUID()}`,
      accountId: 'subject-1',
      url: 'ws://example.test',
      autoStart: false,
      tables: { todos: { indexes: 'id', channel: 'todos' } },
      onError: (error) => errors.push(error),
      transport: {
        socketFactory: () =>
          (socket = new ProtocolSocket([{ id: 'one', value: 1 }])),
      },
    });
    clients.push(client);
    await client.start();
    await waitFor(
      () =>
        socket.sent.some((message) => message.type === 'subscribe') &&
        client.pendingFetchCount === 0,
    );
    const removal = await client.delete('todos', 'one');
    expect(await client.read('todos').get('one')).toBeUndefined();
    socket.reply({
      type: 'reject',
      id: removal.id,
      error: { code: 'forbidden', message: 'keep it' },
    });
    await expect(removal.confirmed).rejects.toThrow(/keep it/);
    expect(await client.read('todos').get('one')).toEqual({
      id: 'one',
      value: 1,
    });
    socket.reply({
      type: 'change',
      channel: 'todos',
      change: { kind: 'delete', key: 'one' },
      cursor: 5,
      revision: 5,
    });
    await waitFor(
      async () => (await client.read('todos').get('one')) === undefined,
    );
    socket.reply({
      type: 'change',
      channel: 'todos',
      change: { kind: 'patch', key: 'two', patch: { id: 'wrong', value: 2 } },
      cursor: 6,
      revision: 6,
    });
    await waitFor(() => errors.length > 0);
    expect(await client.read('todos').get('two')).toBeUndefined();
  });

  it('loads pending intent once for a multi-row snapshot', async () => {
    const metrics: Array<{ name: string; count: number; channel?: string }> =
      [];
    const rows = Array.from({ length: 50 }, (_, value) => ({
      id: String(value),
      value,
    }));
    let socket!: ProtocolSocket;
    const client = new SyncClient<{ todos: { id: string; value: number } }>({
      name: `sync-integration-${crypto.randomUUID()}`,
      accountId: 'subject-1',
      url: 'ws://example.test',
      autoStart: false,
      tables: { todos: { indexes: 'id', channel: 'todos' } },
      onMetric: (metric) => metrics.push(metric),
      transport: { socketFactory: () => (socket = new ProtocolSocket(rows)) },
    });
    clients.push(client);
    await client.start();
    await waitFor(
      () =>
        socket.sent.some((message) => message.type === 'subscribe') &&
        client.pendingFetchCount === 0,
    );
    expect(
      metrics.filter(
        (metric) => metric.name === 'outbox-read' && metric.channel === 'todos',
      ),
    ).toHaveLength(1);
    expect(metrics.find((metric) => metric.name === 'snapshot')?.count).toBe(
      50,
    );
  });

  it('follows paginated snapshots with one request correlation and defers live changes', async () => {
    let socket!: ProtocolSocket;
    const client = new SyncClient<{ todos: { id: string; value: number } }>({
      name: `sync-integration-${crypto.randomUUID()}`,
      accountId: 'subject-1',
      url: 'ws://example.test',
      autoStart: false,
      tables: { todos: { indexes: 'id', channel: 'todos' } },
      transport: { socketFactory: () => (socket = new ProtocolSocket(null)) },
    });
    clients.push(client);
    await client.start();
    await waitFor(() =>
      socket.sent.some((message) => message.type === 'subscribe'),
    );
    const request = socket.sent.find(
      (message) => message.type === 'subscribe',
    )!;
    socket.reply({
      type: 'snapshot',
      requestId: request.requestId,
      channel: 'todos',
      mode: 'full',
      rows: [{ id: 'one', value: 1 }],
      cursor: 1,
      hasMore: true,
    });
    socket.reply({
      type: 'change',
      channel: 'todos',
      change: { kind: 'full', key: 'three', row: { id: 'three', value: 3 } },
      cursor: 3,
      revision: 3,
    });
    await waitFor(
      () =>
        socket.sent.filter((message) => message.type === 'subscribe').length ===
        2,
    );
    const continuation = socket.sent.at(-1)!;
    expect(continuation).toMatchObject({
      requestId: request.requestId,
      cursor: 1,
    });
    socket.reply({
      type: 'snapshot',
      requestId: request.requestId,
      channel: 'todos',
      mode: 'delta',
      rows: [{ id: 'two', value: 2 }],
      cursor: 2,
      hasMore: false,
    });
    await waitFor(() => client.pendingFetchCount === 0);
    expect(await client.read('todos').toArray()).toEqual(
      expect.arrayContaining([
        { id: 'one', value: 1 },
        { id: 'two', value: 2 },
        { id: 'three', value: 3 },
      ]),
    );
  });

  it('rejects a non-advancing page before applying it', async () => {
    let socket!: ProtocolSocket;
    const client = new SyncClient<{ todos: { id: string; value: number } }>({
      name: `sync-integration-${crypto.randomUUID()}`,
      accountId: 'subject-1',
      url: 'ws://example.test',
      autoStart: false,
      tables: { todos: { indexes: 'id', channel: 'todos' } },
      transport: { socketFactory: () => (socket = new ProtocolSocket(null)) },
      onError: () => {},
    });
    clients.push(client);
    await client.start();
    await waitFor(
      () =>
        socket.sent.filter((message) => message.type === 'subscribe').length ===
        1,
    );
    const initial = socket.sent.at(-1)!;
    socket.reply({
      type: 'snapshot',
      requestId: initial.requestId,
      channel: 'todos',
      mode: 'full',
      rows: [],
      cursor: 5,
      viewVersion: 'old',
    });
    await waitFor(() => client.pendingFetchCount === 0);

    const resync = client.resyncChannel('todos');
    await waitFor(
      () =>
        socket.sent.filter((message) => message.type === 'subscribe').length ===
        2,
    );
    const request = socket.sent.at(-1)!;
    socket.reply({
      type: 'snapshot',
      requestId: request.requestId,
      channel: 'todos',
      mode: 'full',
      rows: [{ id: 'first', value: 1 }],
      cursor: 1,
      hasMore: true,
      viewVersion: 'new',
    });
    await waitFor(
      () =>
        socket.sent.filter((message) => message.type === 'subscribe').length ===
        3,
    );
    socket.reply({
      type: 'snapshot',
      requestId: request.requestId,
      channel: 'todos',
      mode: 'delta',
      rows: [{ id: 'poison', value: 2 }],
      cursor: 1,
      hasMore: true,
      viewVersion: 'new',
    });
    await expect(resync).rejects.toThrow(/did not advance/);
    expect(await client.read('todos').get('first')).toEqual({
      id: 'first',
      value: 1,
    });
    expect(await client.read('todos').get('poison')).toBeUndefined();
  });

  it('uses visibility versions to admit cursor epoch resets', async () => {
    let socket!: ProtocolSocket;
    const client = new SyncClient<{ todos: { id: string; value: number } }>({
      name: `sync-integration-${crypto.randomUUID()}`,
      accountId: 'subject-1',
      url: 'ws://example.test',
      autoStart: false,
      tables: { todos: { indexes: 'id', channel: 'todos' } },
      transport: { socketFactory: () => (socket = new ProtocolSocket(null)) },
    });
    clients.push(client);
    await client.start();
    await waitFor(() => socket.sent.length === 1);
    socket.reply({
      type: 'snapshot',
      requestId: socket.sent[0].requestId,
      channel: 'todos',
      mode: 'full',
      rows: [{ id: 'old', value: 10 }],
      cursor: 10,
      viewVersion: 'old-view',
    });
    await waitFor(() => client.pendingFetchCount === 0);

    const changedView = client.resyncChannel('todos');
    await waitFor(() => socket.sent.length === 2);
    socket.reply({
      type: 'change',
      channel: 'todos',
      change: {
        kind: 'full',
        key: 'old-buffered',
        row: { id: 'old-buffered', value: 11 },
      },
      cursor: 11,
      revision: 11,
    });
    socket.reply({
      type: 'snapshot',
      requestId: socket.sent[1].requestId,
      channel: 'todos',
      mode: 'full',
      rows: [{ id: 'new', value: 1 }],
      cursor: 1,
      viewVersion: 'new-view',
    });
    await changedView;
    expect(await client.read('todos').toArray()).toEqual([
      { id: 'new', value: 1 },
    ]);
    expect(await client.read('todos').get('old-buffered')).toBeUndefined();

    const staleSameView = client.resyncChannel('todos');
    await waitFor(() => socket.sent.length === 3);
    socket.reply({
      type: 'snapshot',
      requestId: socket.sent[2].requestId,
      channel: 'todos',
      mode: 'full',
      rows: [{ id: 'stale', value: 0 }],
      cursor: 0,
      viewVersion: 'new-view',
    });
    await staleSameView;
    expect(await client.read('todos').toArray()).toEqual([
      { id: 'new', value: 1 },
    ]);

    const invalidDelta = client.resyncChannel('todos');
    await waitFor(() => socket.sent.length === 4);
    socket.reply({
      type: 'snapshot',
      requestId: socket.sent[3].requestId,
      channel: 'todos',
      mode: 'delta',
      rows: [{ id: 'leak', value: 99 }],
      cursor: 2,
      viewVersion: 'another-view',
    });
    await expect(invalidDelta).rejects.toThrow(/visibility version/);
    expect(await client.read('todos').get('leak')).toBeUndefined();
  });

  it('stops when buffered live changes exceed the channel bound', async () => {
    let socket!: ProtocolSocket;
    const errors: unknown[] = [];
    const client = new SyncClient<{ todos: { id: string; value: number } }>({
      name: `sync-integration-${crypto.randomUUID()}`,
      accountId: 'subject-1',
      url: 'ws://example.test',
      autoStart: false,
      tables: { todos: { indexes: 'id', channel: 'todos' } },
      onError: (error) => errors.push(error),
      transport: { socketFactory: () => (socket = new ProtocolSocket(null)) },
    });
    clients.push(client);
    await client.start();
    await waitFor(() => client.pendingFetchCount === 1);
    for (let cursor = 1; cursor <= 257; cursor++) {
      socket.reply({
        type: 'change',
        channel: 'todos',
        change: {
          kind: 'full',
          key: `row-${cursor}`,
          row: { id: `row-${cursor}`, value: cursor },
        },
        cursor,
        revision: cursor,
      });
    }
    await waitFor(() => client.status === 'stopped');
    expect(
      errors.some(
        (error) =>
          error instanceof Error &&
          error.message.includes('Buffered sync change limit'),
      ),
    ).toBe(true);
    expect(client.pendingFetchCount).toBe(0);
  });

  it('settles timed-out and stopped subscription waiters', async () => {
    let socket!: ProtocolSocket;
    const client = new SyncClient<{ todos: { id: string; value: number } }>({
      name: `sync-integration-${crypto.randomUUID()}`,
      accountId: 'subject-1',
      url: 'ws://example.test',
      autoStart: false,
      requestTimeoutMs: 10,
      onError: () => {},
      tables: { todos: { indexes: 'id', channel: 'todos' } },
      transport: { socketFactory: () => (socket = new ProtocolSocket(null)) },
    });
    clients.push(client);
    await client.start();
    await expect(client.resyncChannel('todos')).rejects.toThrow(/Timed out/);
    const pending = client.resyncChannel('todos');
    await waitFor(() => client.pendingFetchCount > 0);
    socket.reply({
      type: 'change',
      channel: 'todos',
      change: { kind: 'full', key: 'late', row: { id: 'late', value: 1 } },
      cursor: 2,
      revision: 2,
    });
    client.stop();
    await expect(pending).rejects.toThrow(/stopped/);
    expect(await client.read('todos').get('late')).toBeUndefined();
  });

  it('keeps the outbox when acknowledgement cleanup fails and accepts a retry', async () => {
    let socket!: ProtocolSocket;
    const errors: unknown[] = [];
    const client = new SyncClient<{ todos: { id: string; value: number } }>({
      name: `sync-integration-${crypto.randomUUID()}`,
      accountId: 'subject-1',
      url: 'ws://example.test',
      autoStart: false,
      tables: { todos: { indexes: 'id', channel: 'todos' } },
      onError: (error) => errors.push(error),
      transport: { socketFactory: () => (socket = new ProtocolSocket([])) },
    });
    clients.push(client);
    await client.start();
    await waitFor(() => client.pendingFetchCount === 0);
    const created = await client.create('todos', { id: 'one', value: 1 });
    const original = IDBObjectStore.prototype.delete;
    let fail = true;
    IDBObjectStore.prototype.delete = function (
      key: IDBValidKey | IDBKeyRange,
    ) {
      if (fail && this.name === '__sync_outbox') {
        fail = false;
        throw new DOMException('quota', 'QuotaExceededError');
      }
      return original.call(this, key);
    };
    socket.reply({
      type: 'ack',
      id: created.id,
      data: { id: 'one', value: 2 },
      cursor: 2,
      revision: 2,
    });
    await waitFor(() => errors.length > 0);
    expect(client.pendingMutationCount).toBe(1);
    IDBObjectStore.prototype.delete = original;
    socket.reply({
      type: 'ack',
      id: created.id,
      data: { id: 'one', value: 2 },
      cursor: 2,
      revision: 2,
    });
    await expect(created.confirmed).resolves.toEqual({ id: 'one', value: 2 });
    expect(client.pendingMutationCount).toBe(0);
  });

  it('purge wins a race with a queued create', async () => {
    const name = `sync-integration-${crypto.randomUUID()}`;
    const client = new SyncClient<{ todos: { id: string; value: number } }>({
      name,
      accountId: 'subject-1',
      url: 'ws://example.test',
      autoStart: false,
      tables: { todos: { indexes: 'id', channel: 'todos' } },
    });
    clients.push(client);
    const create = expect(
      client.create('todos', { id: 'one', value: 1 }),
    ).rejects.toThrow(/stopped/);
    await client.purge();
    await create;
    const reopened = new SyncClient<{ todos: { id: string; value: number } }>({
      name,
      accountId: 'subject-1',
      url: 'ws://example.test',
      autoStart: false,
      tables: { todos: { indexes: 'id', channel: 'todos' } },
    });
    clients.push(reopened);
    expect(await reopened.read('todos').get('one')).toBeUndefined();
  });
});
