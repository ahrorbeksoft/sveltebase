import { EventEmitter, once } from 'node:events';
import { createServer } from 'node:http';
import { WebSocket } from 'ws';
import type { IncomingMessage, Server } from 'node:http';
import type { ViteDevServer } from 'vite';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createDevEngine, type DevSocket } from './src/server/dev-engine.js';
import { syncDevPlugin } from './src/vite.js';
import { defineSync } from './src/server/index.js';
import { deferred } from '../../tests/support/fixtures.js';

class Socket extends EventEmitter implements DevSocket {
  readyState = 1;
  frames: Record<string, unknown>[] = [];
  closeCode?: number;
  send(value: string) {
    this.frames.push(JSON.parse(value) as Record<string, unknown>);
  }
  close(code?: number) {
    this.closeCode = code;
    if (this.readyState === 3) return;
    this.readyState = 3;
    this.emit('close');
  }
}
const request = (extra: Record<string, string | string[]> = {}) =>
  ({
    url: '/api/sync',
    headers: { host: 'app.test', ...extra },
  }) as IncomingMessage;
const channel = (name = 'todos') =>
  defineSync({
    channel: name,
    broadcast: 'public',
    snapshot: async () => ({ mode: 'full', rows: [{ id: '1' }], cursor: 1 }),
  });
const engines: ReturnType<typeof createDevEngine>[] = [];
const own = (engine: ReturnType<typeof createDevEngine>) => {
  engines.push(engine);
  return engine;
};
afterEach(async () => {
  await Promise.all(engines.splice(0).map((engine) => engine.dispose()));
  vi.restoreAllMocks();
});

describe('development runtime ownership', () => {
  it('denies missing, thrown, malformed, expired and topic-failed auth without a resolver loophole', async () => {
    for (const options of [
      {},
      {
        auth: () => {
          throw new Error('private');
        },
      },
      { auth: () => ({ subject: '', user: null }) },
      { auth: () => ({ subject: 'alice', user: null, expiresAt: 1 }) },
      {
        auth: () => ({ subject: 'alice', user: null }),
        topics: () => {
          throw new Error('private');
        },
      },
    ]) {
      const engine = own(createDevEngine([channel()], options));
      const socket = new Socket();
      expect((await engine.addClient(socket, request())).connected).toBe(false);
      expect(socket.closeCode).toBe(1008);
      expect(socket.listenerCount('message')).toBe(0);
    }
  });
  it('publishes only within its bound runtime and cleans up every socket listener', async () => {
    const first = own(
      createDevEngine([channel()], { allowUnauthenticated: true }),
    );
    const second = own(
      createDevEngine([channel()], { allowUnauthenticated: true }),
    );
    const a = new Socket(),
      b = new Socket();
    await first.addClient(a, request({ 'x-example': ['one', 'two'] }));
    await second.addClient(b, request());
    const subscribe = JSON.stringify({
      v: 1,
      type: 'subscribe',
      requestId: 's',
      channel: 'todos',
    });
    a.emit('message', Buffer.from(subscribe));
    b.emit('message', subscribe);
    await vi.waitFor(() => expect(a.frames.length + b.frames.length).toBe(2));
    const change = {
      channel: 'todos',
      change: { kind: 'full' as const, key: '2', row: { id: '2' } },
      cursor: 2,
      revision: 2,
    };
    await first.publish(change);
    await first.publishBatch([{ ...change, cursor: 3, revision: 3 }]);
    await first.resync('todos', true);
    await first.resync('todos');
    expect(a.frames.map((frame) => frame.type)).toEqual([
      'snapshot',
      'change',
      'change',
      'channel-reset',
      'channel-change',
    ]);
    expect(b.frames.map((frame) => frame.type)).toEqual(['snapshot']);
    first.setHandlers([channel('other')]);
    await first.dispose();
    await first.dispose();
    expect(a.eventNames()).toEqual([]);
    expect(a.readyState).toBe(3);
    await expect(first.publish(change)).rejects.toThrow('disposed');
  });
  it('memoizes asynchronous platform setup and cancels connections that close during auth', async () => {
    const gate = deferred<{ env: Record<string, unknown> }>();
    const platform = vi.fn(() => gate.promise);
    const engine = own(
      createDevEngine([channel()], {
        platform,
        auth: () => ({ subject: 'alice', user: {}, topics: [] }),
      }),
    );
    const a = new Socket(),
      b = new Socket();
    const first = engine.addClient(a, request()),
      second = engine.addClient(b, request());
    a.close();
    gate.resolve({ env: {} });
    expect((await first).connected).toBe(false);
    expect((await second).connected).toBe(true);
    expect(platform).toHaveBeenCalledTimes(1);
    b.emit('error', new Error('disconnected'));
    expect(b.eventNames()).toEqual([]);
  });
  it('does not attach a connection after runtime disposal during setup', async () => {
    const gate = deferred<{ env: Record<string, unknown> }>();
    const engine = own(
      createDevEngine([], {
        platform: () => gate.promise,
        allowUnauthenticated: true,
      }),
    );
    const socket = new Socket();
    const connecting = engine.addClient(socket, request());
    const disposal = engine.dispose();
    gate.resolve({ env: {} });
    await disposal;
    expect((await connecting).connected).toBe(false);
  });
});

describe('Vite hook lifecycle', () => {
  it('keeps the upgrade listener through post-configuration and removes it on server close', async () => {
    const http = new EventEmitter();
    const load = vi.fn();
    const server = {
      httpServer: http,
      ssrLoadModule: load,
    } as unknown as ViteDevServer;
    const plugin = syncDevPlugin();
    const configure = plugin.configureServer;
    if (typeof configure !== 'function')
      throw new Error('Missing configure hook');
    const postHook = await configure.call({} as never, server);
    // Vite calls this after internal middleware setup. Returning cleanup here used to disable sync.
    expect(postHook).toBeUndefined();
    expect(http.listenerCount('upgrade')).toBe(1);
    http.emit('close');
    expect(http.listenerCount('upgrade')).toBe(0);
    expect(load).not.toHaveBeenCalled();
  });
  it('rejects hostile origins before websocket upgrade and ignores other routes', async () => {
    const http = new EventEmitter();
    const server = {
      httpServer: http as unknown as Server,
      ssrLoadModule: vi.fn(),
    } as unknown as ViteDevServer;
    const plugin = syncDevPlugin();
    if (typeof plugin.configureServer !== 'function')
      throw new Error('Missing hook');
    await plugin.configureServer.call({} as never, server);
    const socket = { destroy: vi.fn() };
    http.emit(
      'upgrade',
      request({ origin: 'https://evil.test' }),
      socket,
      Buffer.alloc(0),
    );
    expect(socket.destroy).toHaveBeenCalledTimes(1);
    http.emit(
      'upgrade',
      { ...request(), url: '/unrelated' },
      socket,
      Buffer.alloc(0),
    );
    expect(socket.destroy).toHaveBeenCalledTimes(1);
    http.emit('close');
  });
});

async function runningPlugin(
  options: Parameters<typeof syncDevPlugin>[0] = {},
  moduleLoader?: (id: string) => Promise<Record<string, unknown>>,
) {
  const http = createServer((_req, res) => {
    res.end('fixture');
  });
  const plugin = syncDevPlugin(options);
  const load = vi.fn(
    moduleLoader ??
      (async (id: string) =>
        id.includes('dev-engine')
          ? { createDevEngine }
          : { handlers: [channel()] }),
  );
  const server = {
    httpServer: http,
    ssrLoadModule: load,
  } as unknown as ViteDevServer;
  if (typeof plugin.configureServer !== 'function')
    throw new Error('Missing hook');
  await plugin.configureServer.call({} as never, server);
  http.listen(0, '127.0.0.1');
  await once(http, 'listening');
  const address = http.address();
  if (!address || typeof address === 'string') throw new Error('Missing port');
  const origin = `http://127.0.0.1:${address.port}`;
  const sockets: WebSocket[] = [];
  return {
    server,
    plugin,
    load,
    async connect() {
      const socket = new WebSocket(
        `${origin.replace('http:', 'ws:')}/api/sync`,
        { origin },
      );
      sockets.push(socket);
      await once(socket, 'open');
      return socket;
    },
    async close() {
      for (const socket of sockets) socket.terminate();
      await new Promise<void>((resolve) => http.close(() => resolve()));
    },
  };
}

describe('Vite real websocket setup', () => {
  it('buffers pre-auth messages, shares runtime creation, and closes active clients on reload', async () => {
    const auth = deferred<{ subject: string; user: object }>();
    const runtime = await runningPlugin({ auth: () => auth.promise });
    try {
      const first = await runtime.connect(),
        second = await runtime.connect();
      const pong = once(first, 'message');
      first.send(JSON.stringify({ v: 1, type: 'ping', nonce: 'early' }));
      auth.resolve({ subject: 'alice', user: {} });
      expect(JSON.parse(String((await pong)[0]))).toMatchObject({
        type: 'pong',
        nonce: 'early',
      });
      expect(runtime.load).toHaveBeenCalledTimes(2);
      const closedFirst = once(first, 'close'),
        closedSecond = once(second, 'close');
      if (typeof runtime.plugin.handleHotUpdate !== 'function')
        throw new Error('Missing reload hook');
      await runtime.plugin.handleHotUpdate.call(
        {} as never,
        { file: '/project/src/lib/server/sync-handlers.ts' } as never,
      );
      expect((await closedFirst)[0]).toBe(1012);
      expect((await closedSecond)[0]).toBe(1012);
    } finally {
      await runtime.close();
    }
  });
  it('closes failed module setups and retries the next connection', async () => {
    let failed = true;
    const runtime = await runningPlugin(
      { allowUnauthenticated: true },
      async (id) => {
        if (id.includes('dev-engine')) return { createDevEngine };
        if (failed) return { handlers: 'invalid' };
        return { handlers: [channel()] };
      },
    );
    try {
      const first = await runtime.connect();
      expect((await once(first, 'close'))[0]).toBe(1011);
      failed = false;
      const second = await runtime.connect();
      const pong = once(second, 'message');
      second.send(JSON.stringify({ v: 1, type: 'ping' }));
      expect(JSON.parse(String((await pong)[0])).type).toBe('pong');
    } finally {
      await runtime.close();
    }
  });
  it('bounds the pre-authentication queue and never replays overflowed intent', async () => {
    const auth = deferred<{ subject: string; user: object }>();
    const runtime = await runningPlugin({ auth: () => auth.promise });
    try {
      const socket = await runtime.connect();
      const closed = once(socket, 'close');
      for (let index = 0; index < 65; index++)
        socket.send(
          JSON.stringify({ v: 1, type: 'ping', nonce: String(index) }),
        );
      expect((await closed)[0]).toBe(1009);
      auth.resolve({ subject: 'alice', user: {} });
    } finally {
      auth.resolve({ subject: 'alice', user: {} });
      await runtime.close();
    }
  });
});
