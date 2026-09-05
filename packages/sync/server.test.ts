import { describe, expect, it } from 'vitest';
import { handleSyncRequest } from './src/cloudflare/handler.js';
import { SYNC_PROTOCOL_VERSION } from './src/protocol.js';
import { SyncBroker, type ISyncConnection } from './src/server/broker.js';
import { definePolicySync } from './src/server/policy.js';
import {
  defineSync,
  type AtomicIdempotencyAdapter,
  type SyncConnectionAuth,
  type SyncMetric,
  type SyncPlatform,
} from './src/server/index.js';

class Connection implements ISyncConnection {
  messages: Record<string, unknown>[] = [];
  channels = new Set<string>();
  auth: SyncConnectionAuth | null = {
    subject: 'user-1',
    user: { id: 'user-1' },
    topics: ['team:a'],
  };
  headers = new Headers();
  url = 'https://app.test/api/sync';
  send(value: string) {
    this.messages.push(JSON.parse(value) as Record<string, unknown>);
  }
  close() {}
  getConnectionAuth() {
    return this.auth;
  }
  setConnectionAuth(value: SyncConnectionAuth | null) {
    this.auth = value;
  }
  getSubscribedChannels() {
    return this.channels;
  }
}
const runtime: SyncPlatform = { env: {} };
const request = new Request('https://app.test/api/sync');
const frame = (value: Record<string, unknown>) =>
  JSON.stringify({ v: SYNC_PROTOCOL_VERSION, ...value });
const atomic = (): AtomicIdempotencyAdapter => {
  const outcomes = new Map<string, unknown>();
  return {
    async execute(_ctx, key, perform) {
      const id = `${key.subject}:${key.channel}:${key.mutationId}`;
      if (outcomes.has(id))
        return { replayed: true, outcome: outcomes.get(id) as never };
      const outcome = await perform({});
      outcomes.set(id, outcome);
      return { replayed: false, outcome };
    },
  };
};

describe('sync server cost and correctness contracts', () => {
  it('does no source database work for heartbeats', async () => {
    const metrics: SyncMetric[] = [];
    const broker = new SyncBroker([], (metric) => metrics.push(metric));
    const conn = new Connection();
    broker.registerConnection(conn);
    await broker.handleMessage(
      conn,
      frame({ type: 'ping', nonce: 'n' }),
      runtime,
      request,
    );
    expect(conn.messages).toEqual([{ type: 'pong', nonce: 'n', v: 1 }]);
    expect(metrics).toEqual([]);
  });

  it.each([1, 100])(
    'fans a canonical event to %i subscribers with no source reads',
    async (count) => {
      const metrics: SyncMetric[] = [];
      const handler = defineSync({
        channel: 'todos',
        snapshot: async () => ({ mode: 'full', rows: [], cursor: 0 }),
        broadcast: 'public',
      });
      const broker = new SyncBroker([handler], (metric) =>
        metrics.push(metric),
      );
      const clients = Array.from({ length: count }, () => {
        const conn = new Connection();
        conn.channels.add('todos');
        broker.registerConnection(conn);
        return conn;
      });
      await broker.handleExternalChange({
        channel: 'todos',
        change: { kind: 'full', key: '1', row: { id: '1', title: 'x' } },
        cursor: 1,
        revision: 1,
      });
      expect(clients.every((conn) => conn.messages.length === 1)).toBe(true);
      expect(
        metrics.filter(
          (metric) =>
            metric.name === 'query' ||
            metric.name === 'rows-read' ||
            metric.name === 'write',
        ),
      ).toEqual([]);
    },
  );

  it('does not repeat a committed domain write on mutation replay', async () => {
    let writes = 0;
    const handler = defineSync({
      channel: 'todos',
      snapshot: async () => ({ mode: 'full', rows: [], cursor: 0 }),
      idempotency: atomic(),
      broadcast: 'none',
      mutate: async (_ctx, mutation) => {
        writes++;
        const row = mutation.data as { id: string };
        return {
          data: row,
          change: { kind: 'full', key: row.id, row },
          cursor: 1,
          revision: 1,
        };
      },
    });
    const broker = new SyncBroker([handler]);
    const conn = new Connection();
    broker.registerConnection(conn);
    const mutation = frame({
      type: 'mutate',
      id: 'm1',
      channel: 'todos',
      action: 'create',
      data: { id: '1' },
    });
    await broker.handleMessage(conn, mutation, runtime, request);
    await broker.handleMessage(conn, mutation, runtime, request);
    expect(writes).toBe(1);
    expect(
      conn.messages
        .filter((message) => message.type === 'ack')
        .map((message) => message.replayed),
    ).toEqual([false, true]);
  });

  it('loads an update original once and shares an in-flight context in a batch', async () => {
    let contextCalls = 0;
    let loads = 0;
    const context = async () => {
      contextCalls++;
      await Promise.resolve();
      return {};
    };
    const make = (channel: string) =>
      definePolicySync<{ id: string }, unknown, object>({
        channel,
        context,
        idempotency: atomic(),
        rules: {
          list: async () => ({ mode: 'full', rows: [], cursor: 0 }),
          update: () => true,
        },
        mutations: {
          load: async () => {
            loads++;
            return { id: '1' };
          },
          update: async (_app, id) => ({
            data: { id },
            change: { kind: 'full', key: id, row: { id } },
            cursor: 1,
            revision: 1,
          }),
        },
      });
    const broker = new SyncBroker([make('a'), make('b')]);
    const conn = new Connection();
    broker.registerConnection(conn);
    await broker.handleMessage(
      conn,
      frame({
        type: 'subscribe-batch',
        requestId: 'batch',
        subscriptions: [
          { requestId: 'a1', channel: 'a' },
          { requestId: 'b1', channel: 'b' },
        ],
      }),
      runtime,
      request,
    );
    expect(contextCalls).toBe(1);
    await broker.handleMessage(
      conn,
      frame({
        type: 'mutate',
        id: 'm',
        channel: 'a',
        action: 'update',
        key: '1',
        data: { title: 'x' },
      }),
      runtime,
      request,
    );
    expect(loads).toBe(1);
  });

  it('shares rejected batch context promises and rebuilds transaction-bound context for adapter retries', async () => {
    let rejectedCalls = 0;
    const rejectedContext = async () => {
      rejectedCalls++;
      throw new Error('context failed');
    };
    const rejected = (channel: string) =>
      definePolicySync({
        channel,
        context: rejectedContext,
        idempotency: atomic(),
        rules: {
          list: async () => ({ mode: 'full' as const, rows: [], cursor: 0 }),
        },
        mutations: { load: async () => null },
      });
    const rejectedBroker = new SyncBroker([rejected('a'), rejected('b')]);
    const rejectedConn = new Connection();
    rejectedBroker.registerConnection(rejectedConn);
    await rejectedBroker.handleMessage(
      rejectedConn,
      frame({
        type: 'subscribe-batch',
        requestId: 'batch',
        subscriptions: [
          { requestId: 'a', channel: 'a' },
          { requestId: 'b', channel: 'b' },
        ],
      }),
      runtime,
      request,
    );
    expect(rejectedCalls).toBe(1);

    const transactions: unknown[] = [];
    const retrying: AtomicIdempotencyAdapter = {
      async execute(_ctx, _key, perform) {
        await expect(perform({ attempt: 1 })).rejects.toThrow('retry');
        return { replayed: false, outcome: await perform({ attempt: 2 }) };
      },
    };
    const retryHandler = definePolicySync<
      { id: string },
      unknown,
      { transaction: unknown }
    >({
      channel: 'retry',
      idempotency: retrying,
      context: (ctx) => {
        transactions.push(ctx.transaction);
        return { transaction: ctx.transaction };
      },
      rules: {
        list: async () => ({ mode: 'full', rows: [], cursor: 0 }),
        create: () => true,
      },
      mutations: {
        load: async () => null,
        create: async (app, row) => {
          if ((app.transaction as { attempt: number }).attempt === 1)
            throw new Error('retry');
          return {
            data: row,
            change: { kind: 'full', key: row.id, row },
            cursor: 1,
            revision: 1,
          };
        },
      },
    });
    const retryBroker = new SyncBroker([retryHandler]);
    const retryConn = new Connection();
    retryBroker.registerConnection(retryConn);
    await retryBroker.handleMessage(
      retryConn,
      frame({
        type: 'mutate',
        id: 'retry',
        channel: 'retry',
        action: 'create',
        data: { id: '1' },
      }),
      runtime,
      request,
    );
    expect(transactions).toEqual([{ attempt: 1 }, { attempt: 2 }]);
  });

  it('reuses the trusted pre-delete row for scoped routing', async () => {
    let loads = 0;
    const handler = definePolicySync<
      { id: string; owner: string },
      unknown,
      object
    >({
      channel: 'todos',
      context: () => ({}),
      idempotency: atomic(),
      broadcast: 'scoped',
      broadcastTopics: (_ctx, _change, row) => [`owner:${row!.owner}`],
      rules: {
        list: async () => ({ mode: 'full', rows: [], cursor: 0 }),
        delete: () => true,
      },
      mutations: {
        load: async () => {
          loads++;
          return { id: '1', owner: 'user-1' };
        },
        delete: async (_app, id) => ({
          change: { kind: 'delete', key: id },
          cursor: 1,
          revision: 1,
        }),
      },
    });
    const broker = new SyncBroker([handler]);
    const conn = new Connection();
    conn.auth = {
      subject: 'user-1',
      user: {},
      topics: ['owner:user-1'],
    };
    conn.channels.add('todos');
    broker.registerConnection(conn);
    await broker.handleMessage(
      conn,
      frame({
        type: 'mutate',
        id: 'delete-1',
        channel: 'todos',
        action: 'delete',
        key: '1',
      }),
      runtime,
      request,
    );
    expect(loads).toBe(1);
    expect(conn.messages.map((message) => message.type)).toEqual([
      'ack',
      'change',
    ]);
  });

  it('passes a bounded cursor request to catch-up snapshots', async () => {
    let observed: unknown;
    const handler = defineSync({
      channel: 'todos',
      snapshotLimit: 25,
      snapshot: async (_ctx, input) => {
        observed = input;
        return {
          mode: 'delta',
          rows: [],
          cursor: 12,
          viewVersion: 'v1',
        };
      },
    });
    const broker = new SyncBroker([handler]);
    const conn = new Connection();
    broker.registerConnection(conn);
    await broker.handleMessage(
      conn,
      frame({
        type: 'subscribe',
        requestId: 's',
        channel: 'todos',
        cursor: 10,
        viewVersion: 'v1',
      }),
      runtime,
      request,
    );
    expect(observed).toEqual({
      cursor: 10,
      forceFull: false,
      limit: 25,
      viewVersion: 'v1',
    });
  });

  it('treats omitted delta visibility versions as the same null version', async () => {
    const handler = defineSync({
      channel: 'todos',
      snapshot: async () => ({ mode: 'delta' as const, rows: [], cursor: 2 }),
    });
    const broker = new SyncBroker([handler]);
    const conn = new Connection();
    broker.registerConnection(conn);
    await broker.handleMessage(
      conn,
      frame({
        type: 'subscribe',
        requestId: 'same-null-view',
        channel: 'todos',
        cursor: 1,
      }),
      runtime,
      request,
    );
    expect(conn.messages[0]).toMatchObject({
      type: 'snapshot',
      mode: 'delta',
      cursor: 2,
    });
    expect(conn.channels.has('todos')).toBe(true);
  });

  it.each([
    [
      'changed delta view',
      { mode: 'delta' as const, rows: [], cursor: 11, viewVersion: 'v2' },
    ],
    [
      'rewound delta cursor',
      { mode: 'delta' as const, rows: [], cursor: 9, viewVersion: 'v1' },
    ],
    [
      'stalled pagination cursor',
      {
        mode: 'delta' as const,
        rows: [],
        cursor: 10,
        viewVersion: 'v1',
        hasMore: true,
      },
    ],
    ['rewound full cursor', { mode: 'full' as const, rows: [], cursor: 9 }],
  ])('rejects a %s without joining the channel', async (_label, result) => {
    const handler = defineSync({
      channel: 'todos',
      snapshot: async () => result,
    });
    const broker = new SyncBroker([handler]);
    const conn = new Connection();
    broker.registerConnection(conn);
    await broker.handleMessage(
      conn,
      frame({
        type: 'subscribe',
        requestId: 'unsafe',
        channel: 'todos',
        cursor: 10,
        viewVersion: 'v1',
      }),
      runtime,
      request,
    );
    expect(conn.channels.has('todos')).toBe(false);
    expect(conn.messages).toHaveLength(1);
    expect(conn.messages[0]).toMatchObject({
      type: 'reject',
      requestId: 'unsafe',
      channel: 'todos',
    });
  });

  it('isolates throwing metrics from subscription, mutation and fan-out', async () => {
    const handler = defineSync({
      channel: 'todos',
      snapshot: async () => ({ mode: 'full', rows: [], cursor: 0 }),
      idempotency: atomic(),
      broadcast: 'public',
      mutate: async (_ctx, mutation) => {
        const row = mutation.data as { id: string };
        return {
          data: row,
          change: { kind: 'full' as const, key: row.id, row },
          cursor: 1,
          revision: 1,
        };
      },
    });
    const broker = new SyncBroker([handler], () => {
      throw new Error('metrics unavailable');
    });
    const conn = new Connection();
    broker.registerConnection(conn);
    await broker.handleMessage(
      conn,
      frame({
        type: 'subscribe',
        requestId: 's',
        channel: 'todos',
      }),
      runtime,
      request,
    );
    await broker.handleMessage(
      conn,
      frame({
        type: 'mutate',
        id: 'm',
        channel: 'todos',
        action: 'create',
        data: { id: '1' },
      }),
      runtime,
      request,
    );
    expect(conn.messages.map((message) => message.type)).toEqual([
      'snapshot',
      'ack',
      'change',
    ]);
  });

  it('buffers live events until the matching snapshot has been delivered', async () => {
    let release!: () => void;
    const boundary = new Promise<void>((resolve) => {
      release = resolve;
    });
    const handler = defineSync({
      channel: 'todos',
      broadcast: 'public',
      snapshot: async () => {
        await boundary;
        return { mode: 'full', rows: [], cursor: 1 };
      },
    });
    const broker = new SyncBroker([handler]);
    const conn = new Connection();
    broker.registerConnection(conn);
    const subscribing = broker.handleMessage(
      conn,
      frame({
        type: 'subscribe',
        requestId: 's',
        channel: 'todos',
        forceFull: true,
      }),
      runtime,
      request,
    );
    await Promise.resolve();
    await broker.handleExternalChange({
      channel: 'todos',
      change: { kind: 'full', key: '2', row: { id: '2' } },
      cursor: 2,
      revision: 2,
    });
    release();
    await subscribing;
    expect(conn.messages.map((message) => message.type)).toEqual([
      'snapshot',
      'change',
    ]);
  });

  it('validates mutation outcomes before the atomic adapter commits', async () => {
    let committedWrites = 0;
    const idempotency: AtomicIdempotencyAdapter = {
      async execute(_ctx, _key, perform) {
        const tx = { writes: 0 };
        const outcome = await perform(tx);
        committedWrites += tx.writes;
        return { replayed: false, outcome };
      },
    };
    const handler = defineSync({
      channel: 'todos',
      snapshot: async () => ({ mode: 'full', rows: [], cursor: 0 }),
      idempotency,
      mutate: async (ctx) => {
        (ctx.transaction as { writes: number }).writes++;
        return {
          change: { kind: 'full', key: '1', row: { id: '1' } },
          cursor: -1,
          revision: 1,
        };
      },
    });
    const broker = new SyncBroker([handler]);
    const conn = new Connection();
    broker.registerConnection(conn);
    await broker.handleMessage(
      conn,
      frame({
        type: 'mutate',
        id: 'bad',
        channel: 'todos',
        action: 'create',
        data: { id: '1' },
      }),
      runtime,
      request,
    );
    expect(committedWrites).toBe(0);
    expect(conn.messages.at(-1)).toMatchObject({ type: 'reject', id: 'bad' });
  });

  it('rejects public relay paths, cross-origin sockets, and unauthenticated sockets by default', async () => {
    const context = {
      waitUntil() {},
      passThroughOnException() {},
    } as unknown as ExecutionContext;
    const options = { handlers: [] };
    expect(
      (
        await handleSyncRequest(
          new Request('https://app.test/broadcast', { method: 'POST' }),
          {},
          context,
          options,
        )
      ).status,
    ).toBe(404);
    const crossOrigin = new Request('https://app.test/api/sync');
    crossOrigin.headers.set('upgrade', 'websocket');
    crossOrigin.headers.set('origin', 'https://evil.test');
    const anonymous = new Request('https://app.test/api/sync');
    anonymous.headers.set('upgrade', 'websocket');
    expect(
      (await handleSyncRequest(crossOrigin, {}, context, options)).status,
    ).toBe(403);
    expect(
      (await handleSyncRequest(anonymous, {}, context, options)).status,
    ).toBe(401);
  });

  it('removes failed subscriptions before later fan-out', async () => {
    const handler = defineSync({
      channel: 'private',
      broadcast: 'public',
      snapshot: async () => {
        throw new Error('denied');
      },
    });
    const broker = new SyncBroker([handler]);
    const conn = new Connection();
    broker.registerConnection(conn);
    await broker.handleMessage(
      conn,
      frame({
        type: 'subscribe',
        requestId: 'bad',
        channel: 'private',
      }),
      runtime,
      request,
    );
    await broker.handleExternalChange({
      channel: 'private',
      change: { kind: 'full', key: '1', row: { id: '1' } },
      cursor: 1,
      revision: 1,
    });
    expect(conn.channels.has('private')).toBe(false);
    expect(conn.messages.map((message) => message.type)).toEqual(['reject']);
  });

  it('routes dynamic external events without resolving against a subscriber', async () => {
    let dynamicResolutions = 0;
    const handler = defineSync({
      channel: (ctx) => {
        dynamicResolutions++;
        return `org:${(ctx.auth?.user as { org: string }).org}:todos`;
      },
      matchChannel: (channel) => /^org:[^:]+:todos$/.test(channel),
      snapshot: async () => ({ mode: 'full', rows: [], cursor: 0 }),
      broadcast: 'scoped',
      broadcastTopics: (_ctx, _change, row) => [
        `org:${(row as { org: string }).org}`,
      ],
    });
    const broker = new SyncBroker([handler]);
    const a = new Connection();
    a.auth = { subject: 'a', user: { org: 'a' }, topics: ['org:a'] };
    a.channels.add('org:a:todos');
    const b = new Connection();
    b.auth = { subject: 'b', user: { org: 'b' }, topics: ['org:b'] };
    b.channels.add('org:a:todos');
    broker.registerConnection(a);
    broker.registerConnection(b);
    await broker.handleExternalChange({
      channel: 'org:a:todos',
      change: { kind: 'full', key: '1', row: { id: '1', org: 'a' } },
      routingRow: { id: '1', org: 'a' },
      cursor: 1,
      revision: 1,
    });
    expect(a.messages).toHaveLength(1);
    expect(b.messages).toHaveLength(0);
    expect(dynamicResolutions).toBe(0);
  });

  it('expires idle sockets during fan-out and supports explicit subject revocation', async () => {
    let closes = 0;
    const handler = defineSync({
      channel: 'todos',
      broadcast: 'public',
      snapshot: async () => ({ mode: 'full', rows: [], cursor: 0 }),
    });
    const broker = new SyncBroker([handler]);
    const expired = new Connection();
    expired.auth = { ...expired.auth!, expiresAt: 1 };
    expired.channels.add('todos');
    expired.close = () => {
      closes++;
    };
    const revoked = new Connection();
    revoked.channels.add('todos');
    revoked.close = () => {
      closes++;
    };
    broker.registerConnection(expired);
    broker.registerConnection(revoked);
    await broker.handleExternalChange({
      channel: 'todos',
      change: { kind: 'full', key: '1', row: { id: '1' } },
      cursor: 1,
      revision: 1,
    });
    broker.revokeSubject('user-1');
    expect(closes).toBe(2);
    expect(expired.messages).toHaveLength(0);
  });
});
