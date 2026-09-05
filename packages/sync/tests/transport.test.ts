import { describe, expect, it, vi } from 'vitest';
import {
  resolveSocketUrl,
  SyncTransport,
  type SocketLike,
} from '../src/client/transport.js';

class FakeSocket implements SocketLike {
  readyState = 0;
  listeners = new Map<string, Set<(event: { data?: unknown }) => void>>();
  sent: string[] = [];
  addEventListener(
    type: string,
    listener: (event: { data?: unknown }) => void,
  ) {
    const set = this.listeners.get(type) ?? new Set();
    set.add(listener);
    this.listeners.set(type, set);
  }
  removeEventListener(
    type: string,
    listener: (event: { data?: unknown }) => void,
  ) {
    this.listeners.get(type)?.delete(listener);
  }
  send(data: string) {
    this.sent.push(data);
  }
  close() {
    this.readyState = 3;
    this.emit('close', {});
  }
  emit(type: string, event: { data?: unknown }) {
    for (const listener of this.listeners.get(type) ?? []) listener(event);
  }
  open() {
    this.readyState = 1;
    this.emit('open', {});
  }
}

describe('SyncTransport', () => {
  it('does not let a superseded socket change the active generation', async () => {
    const sockets: FakeSocket[] = [];
    const states: string[] = [];
    const transport = new SyncTransport({
      url: 'ws://example.test',
      socketFactory: () => {
        const socket = new FakeSocket();
        sockets.push(socket);
        return socket;
      },
      onMessage: () => {},
      onStateChange: (state) => states.push(state),
    });
    const first = transport.start();
    const second = transport.reconnect();
    await expect(first).rejects.toThrow(/superseded/);
    sockets[0].open();
    expect(transport.state).toBe('connecting');
    sockets[1].open();
    await second;
    expect(transport.state).toBe('connected');
    expect(states.at(-1)).toBe('connected');
    transport.dispose();
  });

  it('bounds failed opens and can be disposed without reconnecting', async () => {
    vi.useFakeTimers();
    const socket = new FakeSocket();
    const transport = new SyncTransport({
      url: 'ws://example.test',
      socketFactory: () => socket,
      onMessage: () => {},
      openTimeoutMs: 25,
    });
    const starting = expect(transport.start()).rejects.toThrow(/Timed out/);
    await vi.advanceTimersByTimeAsync(25);
    await starting;
    transport.dispose();
    await vi.advanceTimersByTimeAsync(60_000);
    expect(transport.state).toBe('stopped');
    vi.useRealTimers();
  });

  it('validates URL and timing configuration', () => {
    expect(resolveSocketUrl('ws://example.test/sync')).toBe(
      'ws://example.test/sync',
    );
    expect(resolveSocketUrl('/sync')).toMatch(/^ws:/);
    expect(() => resolveSocketUrl('')).toThrow(/empty/);
    expect(() => resolveSocketUrl('sync')).toThrow(/root-relative/);
    expect(
      () =>
        new SyncTransport({
          url: 'ws://x',
          onMessage: () => {},
          openTimeoutMs: 0,
        }),
    ).toThrow(/positive/);
    expect(
      () =>
        new SyncTransport({
          url: 'ws://x',
          onMessage: () => {},
          minReconnectMs: 10,
          maxReconnectMs: 5,
        }),
    ).toThrow(/at least/);
  });

  it('settles resolver and socket-construction failures', async () => {
    const resolverFailure = new SyncTransport({
      url: async () => {
        throw new Error('resolve failed');
      },
      onMessage: () => {},
    });
    await expect(resolverFailure.start()).rejects.toThrow(/resolve failed/);
    resolverFailure.dispose();
    const constructorFailure = new SyncTransport({
      url: 'ws://example.test',
      socketFactory: () => {
        throw new Error('construct failed');
      },
      onMessage: () => {},
    });
    await expect(constructorFailure.start()).rejects.toThrow(
      /construct failed/,
    );
    constructorFailure.dispose();
  });

  it('requires a correlated pong and reports async message failures', async () => {
    vi.useFakeTimers();
    const socket = new FakeSocket();
    const errors: unknown[] = [];
    const transport = new SyncTransport({
      url: 'ws://example.test',
      socketFactory: () => socket,
      heartbeatIntervalMs: 20,
      pongTimeoutMs: 10,
      onMessage: async () => {
        throw new Error('handler failed');
      },
      onStateChange: (_state, error) => {
        if (error) errors.push(error);
      },
    });
    const started = transport.start();
    socket.open();
    await started;
    socket.emit('message', {
      data: JSON.stringify({ v: 1, type: 'snapshot' }),
    });
    await Promise.resolve();
    expect(errors).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(20);
    const ping = JSON.parse(socket.sent.at(-1)!) as { nonce: string };
    socket.emit('message', {
      data: JSON.stringify({ v: 1, type: 'pong', nonce: 'wrong' }),
    });
    await vi.advanceTimersByTimeAsync(10);
    expect(socket.readyState).toBe(3);
    expect(ping.nonce).toBeTruthy();
    transport.dispose();
    vi.useRealTimers();
  });

  it('accepts the expected pong and reconnects after a later close', async () => {
    vi.useFakeTimers();
    const sockets: FakeSocket[] = [];
    const transport = new SyncTransport({
      url: 'ws://example.test',
      socketFactory: () => {
        const socket = new FakeSocket();
        sockets.push(socket);
        return socket;
      },
      heartbeatIntervalMs: 20,
      pongTimeoutMs: 10,
      minReconnectMs: 10,
      maxReconnectMs: 10,
      jitter: () => 0.5,
      onMessage: () => {},
    });
    const started = transport.start();
    sockets[0].open();
    await started;
    await vi.advanceTimersByTimeAsync(20);
    const ping = JSON.parse(sockets[0].sent.at(-1)!) as { nonce: string };
    sockets[0].emit('message', {
      data: JSON.stringify({ v: 1, type: 'pong', nonce: ping.nonce }),
    });
    await vi.advanceTimersByTimeAsync(10);
    expect(sockets[0].readyState).toBe(1);
    sockets[0].close();
    await vi.advanceTimersByTimeAsync(10);
    expect(sockets).toHaveLength(2);
    sockets[1].open();
    expect(transport.state).toBe('connected');
    transport.dispose();
    vi.useRealTimers();
  });
});
