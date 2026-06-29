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

export type SyncDevPluginOptions<TAuth = unknown> = SyncDevAuthOptions<TAuth> & {
  handlersPath?: string;
  path?: string;
};

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

              (client as any).off("message", onMessage);

              const connected = await (devEngine.addClient as (
                ws: unknown,
                req: IncomingMessage,
                options?: SyncDevAuthOptions<TAuth>,
              ) => Promise<boolean>)(client, request, {
                auth: options?.auth,
                identity: options?.identity,
                allowUnauthenticated: options?.allowUnauthenticated,
                platform: options?.platform,
                wranglerConfigPath: options?.wranglerConfigPath,
              });

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
