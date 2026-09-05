import type { IncomingMessage } from 'node:http';
import type { Duplex } from 'node:stream';
import type { TLSSocket } from 'node:tls';
import type { Plugin } from 'vite';
import type {
  DevSocket,
  SyncDevAuthOptions,
  SyncDevEngine,
} from './server/dev-engine.js';
import type { SyncHandler } from './server/index.js';

const MAX_PREAUTH_MESSAGES = 64;
const MAX_PREAUTH_BYTES = 256 * 1024;
export type SyncDevPluginOptions<TAuth = unknown> =
  SyncDevAuthOptions<TAuth> & {
    handlersPath?: string;
    path?: string;
    trustedOrigins?: readonly string[];
  };
function originAllowed(request: IncomingMessage, trusted?: readonly string[]) {
  const origin = request.headers.origin;
  if (!origin) return true;
  if (trusted) return trusted.includes(origin);
  try {
    const protocol = (request.socket as TLSSocket | undefined)?.encrypted
      ? 'https'
      : 'http';
    return new URL(origin).origin === `${protocol}://${request.headers.host}`;
  } catch {
    return false;
  }
}

/** Vite adapter with one explicitly owned broker per plugin instance. */
export function syncDevPlugin<TAuth = unknown>(
  options: SyncDevPluginOptions<TAuth> = {},
): Plugin {
  const handlersPath =
    options.handlersPath ?? '/src/lib/server/sync-handlers.ts';
  let reload: (() => Promise<void>) | undefined;
  return {
    name: 'sveltebase-sync-dev-websocket',
    apply: 'serve',
    async handleHotUpdate(context) {
      if (context.file.replaceAll('\\', '/').endsWith(handlersPath))
        await reload?.();
    },
    async configureServer(server) {
      const { WebSocketServer } = await import('ws');
      const wss = new WebSocketServer({
        noServer: true,
        maxPayload: MAX_PREAUTH_BYTES,
      });
      let generation = 0;
      let closed = false;
      let engine: Promise<SyncDevEngine> | undefined;
      const sockets = new Set<DevSocket>();
      const loadEngine = () => {
        engine ??= (async () => {
          const [handlers, module] = await Promise.all([
            server.ssrLoadModule(handlersPath),
            server.ssrLoadModule('@sveltebase/sync/server/dev-engine'),
          ]);
          if (!Array.isArray(handlers.handlers))
            throw new Error('Sync handlers module must export handlers');
          return (
            module.createDevEngine as (
              handlers: SyncHandler[],
              options: SyncDevAuthOptions<TAuth>,
            ) => SyncDevEngine
          )(handlers.handlers, options);
        })();
        return engine;
      };
      reload = async () => {
        ++generation;
        for (const socket of sockets)
          socket.close(1012, 'Sync development runtime reloading');
        sockets.clear();
        const previous = engine;
        engine = undefined;
        try {
          await (await previous)?.dispose();
        } catch {
          /* Failed setup owns no runtime. */
        }
      };
      const upgrade = (
        request: IncomingMessage,
        socket: Duplex,
        head: Buffer,
      ) => {
        let url: URL;
        try {
          url = new URL(
            request.url ?? '',
            `http://${request.headers.host ?? 'localhost'}`,
          );
        } catch {
          socket.destroy();
          return;
        }
        if (url.pathname !== (options.path ?? '/api/sync')) return;
        if (!originAllowed(request, options.trustedOrigins)) {
          socket.destroy();
          return;
        }
        const current = generation;
        wss.handleUpgrade(request, socket, head, (client) => {
          const ws: DevSocket = client;
          sockets.add(ws);
          client.once('close', () => sockets.delete(ws));
          const queued: unknown[] = [];
          let bytes = 0;
          let overflow = false;
          const queue = (...args: unknown[]) => {
            bytes += Buffer.byteLength(String(args[0]));
            if (
              queued.length >= MAX_PREAUTH_MESSAGES ||
              bytes > MAX_PREAUTH_BYTES
            ) {
              overflow = true;
              client.close(1009, 'Authentication queue limit exceeded');
              return;
            }
            queued.push(args[0]);
          };
          client.on('message', queue);
          void (async () => {
            try {
              const runtime = await loadEngine();
              if (
                closed ||
                current !== generation ||
                overflow ||
                client.readyState !== 1
              )
                return;
              const handle = await runtime.addClient(ws, request);
              client.off('message', queue);
              if (
                closed ||
                current !== generation ||
                overflow ||
                !handle.connected
              ) {
                handle.dispose();
                return;
              }
              for (const message of queued) client.emit('message', message);
            } catch {
              client.close(1011, 'Sync setup failed');
              // Permit a later connection to retry a failed module load.
              engine = undefined;
            } finally {
              client.off('message', queue);
            }
          })();
        });
      };
      server.httpServer?.on('upgrade', upgrade);
      server.httpServer?.once('close', () => {
        closed = true;
        server.httpServer?.off('upgrade', upgrade);
        void reload?.();
        wss.close();
      });
      // configureServer's returned function is a post-configuration hook, not a disposer.
    },
  };
}
