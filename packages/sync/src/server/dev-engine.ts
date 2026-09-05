import type { IncomingMessage } from 'node:http';
import type { TLSSocket } from 'node:tls';
import { SyncBroker, type ISyncConnection } from './broker.js';
import { deserializeConnectionAuth, serializeConnectionAuth } from './auth.js';
import type { PublishChange, SyncAuthResult } from './handler.js';
import type {
  ResolveTopics,
  SyncConnectionAuth,
  SyncHandler,
  SyncMetrics,
  SyncPlatform,
} from './index.js';

export type DevSocket = {
  readonly readyState: number;
  send(data: string): void;
  close(code?: number, reason?: string): void;
  on(event: string, listener: (...args: unknown[]) => void): void;
  off(event: string, listener: (...args: unknown[]) => void): void;
};
export type SyncDevAuthOptions<TAuth = unknown> = {
  auth?: (
    request: Request,
    platform: SyncPlatform,
  ) => Promise<SyncAuthResult<TAuth>> | SyncAuthResult<TAuth>;
  topics?: ResolveTopics<TAuth>;
  allowUnauthenticated?: boolean;
  platform?: SyncPlatform | (() => Promise<SyncPlatform> | SyncPlatform);
  /** Explicit opt-in to a Wrangler platform proxy. No proxy is created by default. */
  wranglerConfigPath?: string;
  metrics?: SyncMetrics;
};

function request(incoming: IncomingMessage) {
  const headers = new Headers();
  for (const [key, value] of Object.entries(incoming.headers)) {
    if (Array.isArray(value))
      value.forEach((item) => headers.append(key, item));
    else if (value !== undefined) headers.set(key, value);
  }
  const protocol = (incoming.socket as TLSSocket | undefined)?.encrypted
    ? 'https'
    : 'http';
  return new Request(
    new URL(
      incoming.url ?? '',
      `${protocol}://${incoming.headers.host ?? 'localhost'}`,
    ),
    { headers },
  );
}

/** One development runtime owns its broker, clients and optional platform proxy. */
export function createDevEngine<TAuth = unknown>(
  handlers: SyncHandler[],
  options: SyncDevAuthOptions<TAuth> = {},
) {
  const broker = new SyncBroker(handlers, options.metrics);
  const clients = new Set<() => void>();
  let disposed = false;
  let runtimePromise: Promise<SyncPlatform> | undefined;
  let disposeProxy: (() => Promise<void>) | undefined;
  const platform = (): Promise<SyncPlatform> => {
    runtimePromise ??= (async () => {
      if (options.platform)
        return typeof options.platform === 'function'
          ? options.platform()
          : options.platform;
      if (!options.wranglerConfigPath) return { env: {} };
      const { getPlatformProxy } = await import('wrangler');
      const proxy = await getPlatformProxy({
        configPath: options.wranglerConfigPath,
      });
      disposeProxy = () => proxy.dispose();
      return { env: proxy.env, context: proxy.ctx } as SyncPlatform;
    })();
    return runtimePromise;
  };
  const alive = () => {
    if (disposed) throw new Error('Sync development runtime is disposed');
  };
  return {
    setHandlers(next: SyncHandler[]) {
      alive();
      broker.setHandlers(next);
    },
    async addClient(
      ws: DevSocket,
      incoming: IncomingMessage,
    ): Promise<{ connected: boolean; dispose(): void }> {
      alive();
      let cancelled = false;
      const cancel = () => {
        cancelled = true;
      };
      ws.on('close', cancel);
      ws.on('error', cancel);
      const denied = () => {
        ws.off('close', cancel);
        ws.off('error', cancel);
        ws.close(1008, 'Unauthorized');
        return { connected: false, dispose() {} };
      };
      let req: Request;
      let runtime: SyncPlatform;
      let auth: SyncConnectionAuth<TAuth> | null;
      try {
        req = request(incoming);
        runtime = await platform();
        const resolved = options.auth ? await options.auth(req, runtime) : null;
        if (!resolved && options.allowUnauthenticated !== true) return denied();
        auth = resolved
          ? { ...resolved, topics: [`subject:${resolved.subject}`] }
          : null;
        if (auth && options.topics) {
          const topics = await options.topics({
            platform: runtime,
            request: req,
            auth,
            subject: auth.subject,
            topics: new Set(auth.topics),
            cache: new Map(),
            metrics: options.metrics,
          });
          auth.topics = [...new Set([...auth.topics, ...topics])];
        }
        if (
          auth &&
          (!deserializeConnectionAuth(serializeConnectionAuth(auth)) ||
            (auth.expiresAt !== undefined && auth.expiresAt <= Date.now()))
        )
          return denied();
      } catch {
        return denied();
      }
      ws.off('close', cancel);
      ws.off('error', cancel);
      if (cancelled || disposed || ws.readyState !== 1) return denied();
      const channels = new Set<string>();
      const connection: ISyncConnection = {
        send: (data) => ws.send(data),
        close: (code, reason) => ws.close(code, reason),
        getConnectionAuth: () => auth,
        setConnectionAuth: (next) => {
          auth = next as SyncConnectionAuth<TAuth> | null;
        },
        getSubscribedChannels: () => channels,
        headers: req.headers,
        url: req.url,
      };
      const message = (...args: unknown[]) => {
        void broker
          .handleMessage(connection, String(args[0]), runtime, req)
          .catch(() => dispose());
      };
      const dispose = () => {
        broker.removeConnection(connection);
        ws.off('message', message);
        ws.off('close', dispose);
        ws.off('error', dispose);
        clients.delete(dispose);
        if (ws.readyState === 1)
          ws.close(1001, 'Sync development runtime stopped');
      };
      broker.registerConnection(connection);
      clients.add(dispose);
      ws.on('message', message);
      ws.on('close', dispose);
      ws.on('error', dispose);
      return { connected: true, dispose };
    },
    async publish(event: PublishChange) {
      alive();
      await broker.handleExternalChange(event, await platform());
    },
    async publishBatch(events: PublishChange[]) {
      alive();
      await broker.handleExternalChanges(events, await platform());
    },
    async resync(
      channel: string,
      reset = false,
      topics: Iterable<string> | 'all' = 'all',
    ) {
      alive();
      await broker.handleExternalChannelChange(channel, reset, topics);
    },
    async dispose() {
      if (disposed) return;
      disposed = true;
      for (const dispose of [...clients]) dispose();
      // A proxy finishing after teardown is still owned and must be released.
      try {
        await runtimePromise;
      } catch {
        /* Failed setup has no proxy to dispose. */
      }
      await disposeProxy?.();
    },
  };
}
export type SyncDevEngine = ReturnType<typeof createDevEngine>;
