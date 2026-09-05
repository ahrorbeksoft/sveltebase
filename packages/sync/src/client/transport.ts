import { parseServerMessage } from '../protocol.js';

type SocketEvent = { data?: unknown };
export type ConnectionState =
  'stopped' | 'connecting' | 'connected' | 'waiting';

export type SocketLike = {
  readonly readyState: number;
  send(data: string): void;
  close(code?: number, reason?: string): void;
  addEventListener(
    type: string,
    listener: (event: SocketEvent) => void,
    options?: unknown,
  ): void;
  removeEventListener(
    type: string,
    listener: (event: SocketEvent) => void,
  ): void;
};

export type TransportOptions = {
  url: string | (() => string | Promise<string>);
  socketFactory?: (url: string) => SocketLike;
  openTimeoutMs?: number;
  heartbeatIntervalMs?: number;
  pongTimeoutMs?: number;
  minReconnectMs?: number;
  maxReconnectMs?: number;
  jitter?: () => number;
  onMessage: (data: string) => void | Promise<void>;
  onStateChange?: (state: ConnectionState, error?: unknown) => void;
};

const OPEN = 1;

/** A cancellable, generation-guarded websocket state machine. */
export class SyncTransport {
  #options: Required<
    Pick<
      TransportOptions,
      | 'openTimeoutMs'
      | 'heartbeatIntervalMs'
      | 'pongTimeoutMs'
      | 'minReconnectMs'
      | 'maxReconnectMs'
      | 'jitter'
    >
  > &
    TransportOptions;
  #socket?: SocketLike;
  #state: ConnectionState = 'stopped';
  #generation = 0;
  #attempt = 0;
  #reconnectTimer?: ReturnType<typeof setTimeout>;
  #openTimer?: ReturnType<typeof setTimeout>;
  #heartbeatTimer?: ReturnType<typeof setInterval>;
  #pongTimer?: ReturnType<typeof setTimeout>;
  #startPromise?: Promise<void>;
  #startResolve?: () => void;
  #startReject?: (error: unknown) => void;
  #expectedPong?: string;

  constructor(options: TransportOptions) {
    this.#options = {
      ...options,
      openTimeoutMs: options.openTimeoutMs ?? 10_000,
      heartbeatIntervalMs: options.heartbeatIntervalMs ?? 30_000,
      pongTimeoutMs: options.pongTimeoutMs ?? 10_000,
      minReconnectMs: options.minReconnectMs ?? 500,
      maxReconnectMs: options.maxReconnectMs ?? 30_000,
      jitter: options.jitter ?? Math.random,
    };
    for (const [name, value] of Object.entries({
      openTimeoutMs: this.#options.openTimeoutMs,
      heartbeatIntervalMs: this.#options.heartbeatIntervalMs,
      pongTimeoutMs: this.#options.pongTimeoutMs,
      minReconnectMs: this.#options.minReconnectMs,
      maxReconnectMs: this.#options.maxReconnectMs,
    })) {
      if (!Number.isFinite(value) || value <= 0)
        throw new Error(`${name} must be a positive finite number`);
    }
    if (this.#options.maxReconnectMs < this.#options.minReconnectMs)
      throw new Error('maxReconnectMs must be at least minReconnectMs');
  }

  get state() {
    return this.#state;
  }
  get connected() {
    return this.#socket?.readyState === OPEN;
  }

  start(): Promise<void> {
    if (this.connected) return Promise.resolve();
    if (this.#startPromise) return this.#startPromise;
    this.#startPromise = new Promise<void>((resolve, reject) => {
      this.#startResolve = resolve;
      this.#startReject = reject;
    });
    const started = this.#startPromise;
    void this.#connect(++this.#generation);
    return started;
  }

  reconnect(): Promise<void> {
    this.#clearTimers();
    this.#closeSocket();
    this.#attempt = 0;
    this.#settleStart(new Error('Sync connection superseded'));
    return this.start();
  }

  send(message: unknown): void {
    if (!this.#socket || this.#socket.readyState !== OPEN) {
      throw new Error('Sync transport is not connected');
    }
    this.#socket.send(JSON.stringify(message));
  }

  stop(reason = 'Sync transport stopped'): void {
    ++this.#generation;
    this.#clearTimers();
    this.#closeSocket();
    this.#setState('stopped');
    this.#settleStart(new Error(reason));
  }

  dispose(): void {
    this.stop('Sync transport disposed');
  }

  async #connect(generation: number): Promise<void> {
    if (generation !== this.#generation) return;
    this.#setState('connecting');
    let socket: SocketLike;
    try {
      const raw =
        typeof this.#options.url === 'function'
          ? await this.#options.url()
          : this.#options.url;
      if (generation !== this.#generation) return;
      const url = resolveSocketUrl(raw);
      const factory =
        this.#options.socketFactory ?? ((value) => new WebSocket(value));
      socket = factory(url);
    } catch (error) {
      if (generation !== this.#generation) return;
      this.#setState('waiting', error);
      this.#settleStart(error);
      this.#scheduleReconnect(generation);
      return;
    }

    if (generation !== this.#generation) {
      socket.close();
      return;
    }
    this.#socket = socket;

    const onOpen = () => {
      if (generation !== this.#generation || socket !== this.#socket) return;
      if (this.#openTimer) clearTimeout(this.#openTimer);
      this.#openTimer = undefined;
      this.#attempt = 0;
      this.#setState('connected');
      this.#settleStart();
      this.#startHeartbeat(generation, socket);
    };
    const cleanup = () => {
      socket.removeEventListener('open', onOpen);
      socket.removeEventListener('message', onMessage);
      socket.removeEventListener('close', onClose);
      socket.removeEventListener('error', onError);
    };
    const onMessage = (event: SocketEvent) => {
      if (generation !== this.#generation || socket !== this.#socket) return;
      if (typeof event.data !== 'string') return;
      const parsed = parseServerMessage(event.data);
      if (parsed?.type === 'pong' && parsed.nonce === this.#expectedPong) {
        if (this.#pongTimer) clearTimeout(this.#pongTimer);
        this.#pongTimer = undefined;
        this.#expectedPong = undefined;
        return;
      }
      Promise.resolve(this.#options.onMessage(event.data)).catch((error) => {
        this.#options.onStateChange?.(this.#state, error);
      });
    };
    const onClose = () => {
      if (generation !== this.#generation || socket !== this.#socket) return;
      this.#socket = undefined;
      cleanup();
      this.#stopHeartbeat();
      this.#setState('waiting');
      this.#settleStart(new Error('Sync websocket closed before opening'));
      this.#scheduleReconnect(generation);
    };
    const onError = (event: unknown) => {
      if (generation !== this.#generation || socket !== this.#socket) return;
      this.#options.onStateChange?.(this.#state, event);
    };
    socket.addEventListener('open', onOpen);
    socket.addEventListener('message', onMessage);
    socket.addEventListener('close', onClose);
    socket.addEventListener('error', onError);
    this.#openTimer = setTimeout(() => {
      if (
        generation !== this.#generation ||
        socket !== this.#socket ||
        socket.readyState === OPEN
      )
        return;
      cleanup();
      this.#socket = undefined;
      try {
        socket.close(4000, 'Sync open timeout');
      } catch {
        /* already closed */
      }
      this.#setState('waiting', new Error('Timed out opening sync websocket'));
      this.#settleStart(new Error('Timed out opening sync websocket'));
      this.#scheduleReconnect(generation);
    }, this.#options.openTimeoutMs);
  }

  #startHeartbeat(generation: number, socket: SocketLike) {
    this.#stopHeartbeat();
    this.#heartbeatTimer = setInterval(() => {
      if (
        generation !== this.#generation ||
        socket !== this.#socket ||
        socket.readyState !== OPEN
      )
        return;
      if (this.#pongTimer) {
        socket.close(4001, 'Sync pong timeout');
        return;
      }
      const nonce = crypto.randomUUID();
      this.#expectedPong = nonce;
      socket.send(JSON.stringify({ v: 1, type: 'ping', nonce }));
      this.#pongTimer = setTimeout(() => {
        if (generation === this.#generation && socket === this.#socket) {
          socket.close(4001, 'Sync pong timeout');
        }
      }, this.#options.pongTimeoutMs);
    }, this.#options.heartbeatIntervalMs);
  }

  #scheduleReconnect(generation: number) {
    if (
      generation !== this.#generation ||
      this.#state === 'stopped' ||
      this.#reconnectTimer
    )
      return;
    const base = Math.min(
      this.#options.maxReconnectMs,
      this.#options.minReconnectMs * 2 ** Math.min(this.#attempt++, 16),
    );
    const delay = Math.max(
      0,
      Math.round(base * (0.75 + this.#options.jitter() * 0.5)),
    );
    this.#reconnectTimer = setTimeout(() => {
      this.#reconnectTimer = undefined;
      void this.#connect(generation);
    }, delay);
  }

  #setState(state: ConnectionState, error?: unknown) {
    this.#state = state;
    this.#options.onStateChange?.(state, error);
  }

  #settleStart(error?: unknown) {
    if (!this.#startPromise) return;
    const resolve = this.#startResolve;
    const reject = this.#startReject;
    this.#startPromise = undefined;
    this.#startResolve = undefined;
    this.#startReject = undefined;
    if (error) reject?.(error);
    else resolve?.();
  }

  #stopHeartbeat() {
    if (this.#heartbeatTimer) clearInterval(this.#heartbeatTimer);
    if (this.#pongTimer) clearTimeout(this.#pongTimer);
    this.#heartbeatTimer = undefined;
    this.#pongTimer = undefined;
    this.#expectedPong = undefined;
  }

  #clearTimers() {
    if (this.#reconnectTimer) clearTimeout(this.#reconnectTimer);
    if (this.#openTimer) clearTimeout(this.#openTimer);
    this.#reconnectTimer = undefined;
    this.#openTimer = undefined;
    this.#stopHeartbeat();
  }

  #closeSocket() {
    const socket = this.#socket;
    this.#socket = undefined;
    if (socket)
      try {
        socket.close(1000, 'Sync client stopped');
      } catch {
        /* closed */
      }
  }
}

export function resolveSocketUrl(value: string): string {
  if (typeof value !== 'string' || value.length === 0)
    throw new Error('Sync websocket URL is empty');
  if (/^wss?:\/\//.test(value)) return new URL(value).toString();
  if (!value.startsWith('/'))
    throw new Error('Sync websocket URL must be ws(s):// or root-relative');
  if (typeof location === 'undefined')
    throw new Error('A relative sync URL requires a browser location');
  const url = new URL(value, location.href);
  url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:';
  return url.toString();
}
