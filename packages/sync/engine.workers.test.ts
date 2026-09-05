import { env } from 'cloudflare:workers';
import { abortAllDurableObjects, evictDurableObject } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';
import { SYNC_PROTOCOL_VERSION } from './src/protocol.js';
import { serializeConnectionAuth } from './src/server/auth.js';

type TestEnv = {
  SYNC_ENGINE: DurableObjectNamespace;
  TRANSACTION_ENGINE: DurableObjectNamespace;
};
function nextMessage(socket: WebSocket) {
  return new Promise<Record<string, unknown>>((resolve) =>
    socket.addEventListener(
      'message',
      (event) =>
        resolve(JSON.parse(String(event.data)) as Record<string, unknown>),
      { once: true },
    ),
  );
}
async function connect(
  stub: DurableObjectStub,
  auth: { subject: string; topics: string[]; expiresAt?: number },
) {
  const response = await stub.fetch(
    'https://sync.internal/internal/websocket',
    {
      headers: {
        upgrade: 'websocket',
        'x-sveltebase-sync-auth': serializeConnectionAuth({
          ...auth,
          user: { id: auth.subject },
        }),
      },
    },
  );
  const socket = response.webSocket!;
  socket.accept();
  return socket;
}
async function subscribe(socket: WebSocket, requestId: string) {
  const snapshot = nextMessage(socket);
  socket.send(
    JSON.stringify({
      v: SYNC_PROTOCOL_VERSION,
      type: 'subscribe',
      requestId,
      channel: 'todos',
      forceFull: true,
    }),
  );
  await snapshot;
}

describe('Durable Object websocket hibernation', () => {
  it('restores trusted auth and channel membership after eviction', async () => {
    const namespace = (env as unknown as TestEnv).SYNC_ENGINE;
    const stub = namespace.get(namespace.idFromName('global'));
    const socket = await connect(stub, {
      subject: 'u1',
      topics: ['team:a'],
    });
    const denied = await connect(stub, {
      subject: 'u2',
      topics: ['team:b'],
    });
    await Promise.all([subscribe(socket, 's1'), subscribe(denied, 's2')]);
    let deniedChanges = 0;
    denied.addEventListener('message', () => deniedChanges++);

    await evictDurableObject(stub);
    const change = nextMessage(socket);
    const publish = await stub.fetch('https://sync.internal/internal/change', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        channel: 'todos',
        change: {
          kind: 'full',
          key: '2',
          row: { id: '2', title: 'After hibernation' },
        },
        cursor: 2,
        revision: 2,
      }),
    });
    expect(publish.status).toBe(204);
    expect(await change).toMatchObject({
      type: 'change',
      channel: 'todos',
      cursor: 2,
      change: { key: '2' },
    });
    await new Promise((resolve) => setTimeout(resolve, 5));
    expect(deniedChanges).toBe(0);
    socket.close(1000, 'done');
    denied.close(1000, 'done');
  });

  it('enforces restored expiry after hibernation', async () => {
    const namespace = (env as unknown as TestEnv).SYNC_ENGINE;
    const stub = namespace.get(namespace.idFromName('expired'));
    const socket = await connect(stub, {
      subject: 'expired-user',
      topics: ['team:a'],
      expiresAt: 1,
    });
    await evictDurableObject(stub);
    const closed = new Promise<CloseEvent>((resolve) =>
      socket.addEventListener('close', resolve, { once: true }),
    );
    socket.send(
      JSON.stringify({ v: SYNC_PROTOCOL_VERSION, type: 'ping', nonce: 'x' }),
    );
    expect((await closed).code).toBe(4001);
  });
});

describe('atomic durable idempotency fixture', () => {
  it('rolls back a crash and replays a committed outcome after an instance restart without a domain write', async () => {
    const namespace = (env as unknown as TestEnv).TRANSACTION_ENGINE;
    const stub = namespace.get(namespace.idFromName('atomic'));
    const mutation = {
      subject: 'u1',
      channel: 'todos',
      mutationId: 'm1',
    };
    const failed = await stub.fetch('https://sync.internal/mutate', {
      method: 'POST',
      body: JSON.stringify({ ...mutation, fail: true }),
    });
    expect(failed.status).toBe(409);
    expect(
      await (await stub.fetch('https://sync.internal/state')).json(),
    ).toEqual({ domainWrites: 0 });

    const committed = await stub.fetch('https://sync.internal/mutate', {
      method: 'POST',
      body: JSON.stringify(mutation),
    });
    expect(await committed.json()).toMatchObject({
      replayed: false,
      outcome: { domainWrites: 1 },
      metrics: {
        sourceReads: 1,
        sourceWrites: 1,
        brokerReads: 1,
        brokerWrites: 1,
      },
    });
    await abortAllDurableObjects();
    const restarted = namespace.get(namespace.idFromName('atomic'));
    const replay = await restarted.fetch('https://sync.internal/mutate', {
      method: 'POST',
      body: JSON.stringify(mutation),
    });
    expect(await replay.json()).toMatchObject({
      replayed: true,
      outcome: { domainWrites: 1 },
      metrics: {
        sourceReads: 0,
        sourceWrites: 0,
        brokerReads: 1,
        brokerWrites: 0,
      },
    });
    expect(
      await (await restarted.fetch('https://sync.internal/state')).json(),
    ).toEqual({ domainWrites: 1 });
  });
});
