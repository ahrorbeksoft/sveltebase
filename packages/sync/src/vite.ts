import type { IncomingMessage } from "node:http";
import type { Duplex } from "node:stream";
import type { Plugin } from "vite";
import type { SyncDevAuthOptions } from "./server/dev-engine.js";

const DEFAULT_SYNC_PATH = "/api/sync";

interface WsWebSocketServer {
  handleUpgrade(
    request: IncomingMessage,
    socket: Duplex,
    head: Buffer,
    callback: (client: unknown) => void,
  ): void;
}

/**
 * Options for the local Vite websocket sync plugin.
 */
export type SyncDevPluginOptions<TAuth = unknown> =
  SyncDevAuthOptions<TAuth> & {
    /** Module path loaded by Vite SSR to get `handlers`. */
    handlersPath?: string;
    /** Local websocket path. Defaults to `"/api/sync"`. */
    path?: string;
  };

/**
 * Vite dev plugin that serves sync websockets without Cloudflare Durable Objects.
 *
 * The plugin loads your handlers through Vite SSR on each websocket upgrade, so
 * handler edits are reflected during development.
 */
export function syncDevPlugin<TAuth = unknown>(
  options?: SyncDevPluginOptions<TAuth>,
): Plugin {
  const handlersPath =
    options?.handlersPath ?? "/src/lib/server/sync-handlers.ts";
  const syncPath = options?.path ?? DEFAULT_SYNC_PATH;

  return {
    name: "sveltebase-sync-dev-websocket",
    apply: "serve",

    async configureServer(server) {
      const { WebSocketServer } = (await import("ws")) as unknown as {
        WebSocketServer: new (opts: { noServer: boolean }) => WsWebSocketServer;
      };
      const wss = new WebSocketServer({ noServer: true });

      // Install the in-memory broker immediately so server-side publish*
      // works before any client opens a WebSocket (login, remote commands).
      // Handlers are replaced on the first upgrade once Vite can SSR-load them.
      try {
        const devEngine = await import("@sveltebase/sync/server/dev-engine");
        if (typeof devEngine.setHandlers === "function") {
          // Empty handlers are fine for broadcast-only fan-out; upgrade path
          // calls setHandlers again with the real module.
          (devEngine.setHandlers as (handlers: unknown[]) => void)([]);
        }
      } catch (err) {
        console.warn(
          "sync dev plugin: could not install publisher broker early",
          err,
        );
      }

      server.httpServer?.on("upgrade", (request, socket, head) => {
        const url = new URL(
          request.url ?? "",
          `http://${request.headers.host ?? "localhost"}`,
        );

        if (url.pathname !== syncPath) {
          return;
        }

        wss.handleUpgrade(request, socket, head, (client) => {
          const messageQueue: unknown[] = [];
          const onMessage = (data: unknown) => {
            messageQueue.push(data);
          };

          (client as any).on("message", onMessage);

          void (async () => {
            try {
              const handlersModule = await server.ssrLoadModule(handlersPath);
              const devEngine = await server.ssrLoadModule(
                "@sveltebase/sync/server/dev-engine",
              );

              (devEngine.setHandlers as (handlers: unknown[]) => void)(
                handlersModule.handlers,
              );

              const authMetadata = options?.auth as
                | {
                    identity?: (
                      auth: TAuth,
                    ) => string | number | bigint | null | undefined;
                    allowUnauthenticated?: boolean;
                  }
                | undefined;

              // Prefer explicit options.topics; otherwise use resolveSyncTopics
              // exported next to handlers (avoids $lib imports in vite.config).
              const topics =
                options?.topics ??
                (handlersModule.resolveSyncTopics as
                  | SyncDevAuthOptions<TAuth>["topics"]
                  | undefined);

              const connected = await (
                devEngine.addClient as (
                  ws: unknown,
                  req: IncomingMessage,
                  options?: SyncDevAuthOptions<TAuth>,
                ) => Promise<boolean>
              )(client, request, {
                auth: options?.auth,
                identity: options?.identity ?? authMetadata?.identity,
                topics,
                allowUnauthenticated:
                  options?.allowUnauthenticated ??
                  authMetadata?.allowUnauthenticated,
                platform: options?.platform,
                wranglerConfigPath: options?.wranglerConfigPath,
              });

              // addClient installs the permanent message listener. Keep the
              // temporary queue attached until that listener exists so eager
              // subscriptions sent immediately after `open` cannot disappear
              // during async auth/topic resolution.
              (client as any).off("message", onMessage);

              if (!connected) return;

              for (const message of messageQueue) {
                (client as any).emit("message", message);
              }
            } catch (err) {
              console.error("sync dev plugin: websocket upgrade failed", err);
              try {
                (client as any).off("message", onMessage);
                (client as any).close(1011, "Internal server error");
              } catch {
                // Ignore close errors.
              }
            }
          })();
        });
      });
    },
  };
}
