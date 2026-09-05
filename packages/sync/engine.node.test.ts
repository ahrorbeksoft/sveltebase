import { beforeEach, describe, expect, it, vi } from 'vitest';
import { defineSync } from './src/server/index.js';
import { serializeConnectionAuth } from './src/server/auth.js';

vi.mock('cloudflare:workers', () => ({
  DurableObject: class {
    ctx: unknown;
    env: unknown;
    constructor(ctx: unknown, env: unknown) {
      this.ctx = ctx;
      this.env = env;
    }
  },
}));

class Socket {
  attachment: unknown;
  sent: string[] = [];
  closed?: number;
  serializeAttachment(value: unknown) {
    this.attachment = value;
  }
  deserializeAttachment() {
    return this.attachment;
  }
  send(value: string) {
    this.sent.push(value);
  }
  close(code?: number) {
    this.closed = code;
  }
}
class State {
  sockets: Socket[] = [];
  accepted: Socket[] = [];
  getWebSockets() {
    return this.sockets;
  }
  acceptWebSocket(socket: Socket) {
    this.accepted.push(socket);
  }
}

const handler = defineSync({
  channel: 'todos',
  broadcast: 'public',
  snapshot: async () => ({ mode: 'full' as const, rows: [], cursor: 1 }),
});
const NativeResponse = globalThis.Response;
const json = (path: string, body: unknown) =>
  new Request(`https://sync.internal${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });

describe('Durable Object engine adapter branches', () => {
  beforeEach(() => {
    vi.stubGlobal(
      'Response',
      class extends NativeResponse {
        webSocket?: unknown;
        constructor(
          body?: BodyInit | null,
          init: ResponseInit & { webSocket?: unknown } = {},
        ) {
          const intendedStatus = init.status ?? 200;
          super(body, {
            ...init,
            status: intendedStatus === 101 ? 200 : intendedStatus,
          });
          if (intendedStatus === 101)
            Object.defineProperty(this, 'status', { value: 101 });
          this.webSocket = init.webSocket;
        }
      },
    );
    vi.stubGlobal(
      'WebSocketPair',
      class {
        0 = new Socket();
        1 = new Socket();
      },
    );
  });

  it('recovers valid hibernated sockets and removes invalid attachments', async () => {
    const valid = new Socket();
    valid.attachment = {
      version: 1,
      auth: { subject: 'u', user: {}, topics: ['team:a'] },
      channels: ['todos'],
      url: 'https://app.test/internal/websocket',
    };
    const invalid = new Socket();
    invalid.attachment = { version: 2 };
    const state = new State();
    state.sockets = [valid, invalid];
    const { SyncEngineBase } = await import('./src/server/engine.js');
    const engine = new SyncEngineBase(
      state as unknown as DurableObjectState,
      {},
      [handler],
    );
    await engine.webSocketMessage(
      valid as unknown as WebSocket,
      JSON.stringify({ v: 1, type: 'ping', nonce: 'n' }),
    );
    expect(JSON.parse(valid.sent[0]!)).toMatchObject({ type: 'pong' });
    expect(invalid.closed).toBe(1008);
    engine.webSocketError(valid as unknown as WebSocket);
  });

  it('validates all internal publishing routes', async () => {
    const { SyncEngineBase } = await import('./src/server/engine.js');
    const engine = new SyncEngineBase(
      new State() as unknown as DurableObjectState,
      {},
      [handler],
    );
    const event = {
      channel: 'todos',
      change: { kind: 'full', key: '1', row: { id: '1' } },
      cursor: 1,
      revision: 1,
    };
    expect((await engine.fetch(json('/internal/change', event))).status).toBe(
      204,
    );
    expect(
      (await engine.fetch(json('/internal/changes', { events: [event] })))
        .status,
    ).toBe(204);
    expect(
      (
        await engine.fetch(
          json('/internal/resync', {
            channel: 'todos',
            reset: true,
            topics: 'all',
          }),
        )
      ).status,
    ).toBe(204);
    expect(
      (await engine.fetch(json('/internal/revoke', { subject: 'u' }))).status,
    ).toBe(204);
    expect(
      (await engine.fetch(new Request('https://sync.internal/internal/change')))
        .status,
    ).toBe(404);
    expect(
      (await engine.fetch(json('/internal/change', { nope: true }))).status,
    ).toBe(400);
    expect(
      (
        await engine.fetch(
          new Request('https://sync.internal/missing', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: '{',
          }),
        )
      ).status,
    ).toBe(400);
  });

  it('accepts websocket upgrades, persists attachment changes and handles close', async () => {
    const state = new State();
    const { SyncEngineBase } = await import('./src/server/engine.js');
    const engine = new SyncEngineBase(
      state as unknown as DurableObjectState,
      {},
      [handler],
    );
    const ordinary = await engine.fetch(
      new Request('https://sync.internal/internal/websocket'),
    );
    expect(ordinary.status).toBe(426);
    const request = new Request('https://sync.internal/internal/websocket');
    request.headers.set('upgrade', 'websocket');
    request.headers.set(
      'x-sveltebase-sync-auth',
      serializeConnectionAuth({ subject: 'u', user: {}, topics: [] }),
    );
    const response = await engine.fetch(request);
    expect(response.status).toBe(101);
    const server = state.accepted[0]!;
    await engine.webSocketMessage(
      server as unknown as WebSocket,
      JSON.stringify({
        v: 1,
        type: 'subscribe',
        requestId: 's',
        channel: 'todos',
      }),
    );
    expect((server.attachment as { channels: string[] }).channels).toEqual([
      'todos',
    ]);
    engine.webSocketClose(server as unknown as WebSocket, 1000, 'done');
    expect(server.closed).toBe(1000);
  });

  it('creates bound engine classes and delegates non-sync app requests', async () => {
    const { createSyncAppWorker, createSyncEngine } =
      await import('./src/cloudflare/factory.js');
    const Engine = createSyncEngine([handler]);
    const instance = new Engine(
      new State() as unknown as DurableObjectState,
      {},
    );
    expect(instance).toBeDefined();
    const app = {
      fetch: vi.fn(async () => new Response('app', { status: 202 })),
    };
    const worker = createSyncAppWorker(app, { handlers: [handler] });
    const context = {
      waitUntil() {},
      passThroughOnException() {},
    } as unknown as ExecutionContext;
    expect(
      (await worker.fetch!(new Request('https://app.test/other'), {}, context))
        .status,
    ).toBe(202);
    expect(app.fetch).toHaveBeenCalledOnce();
    expect(
      (
        await worker.fetch!(
          new Request('https://app.test/api/sync'),
          {},
          context,
        )
      ).status,
    ).toBe(426);
  });
});
