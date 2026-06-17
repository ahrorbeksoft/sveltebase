import type { IncomingMessage } from "node:http";
import type { Duplex } from "node:stream";
import type { Plugin } from "vite";

const SYNC_PATH = "/api/sync";

interface WsWebSocketServer {
  handleUpgrade(
    request: IncomingMessage,
    socket: Duplex,
    head: Buffer,
    callback: (client: unknown) => void,
  ): void;
}

export type SyncDevPluginOptions = {
  handlersPath?: string;
};

export function syncDevPlugin(options?: SyncDevPluginOptions): Plugin {
  const handlersPath =
    options?.handlersPath ?? "/src/lib/server/sync-handlers.ts";

  return {
    name: "sync-dev-websocket",
    apply: "serve",

    async configureServer(server) {
      // Dynamic import — ws is a transitive dependency of Vite itself.
      // @ts-expect-error -- ws has no bundled type declarations
      const { WebSocketServer } = (await import("ws")) as unknown as {
        WebSocketServer: new (opts: { noServer: boolean }) => WsWebSocketServer;
      };

      const wss = new WebSocketServer({ noServer: true });

      server.httpServer?.on("upgrade", (request, socket, head) => {
        const url = new URL(
          request.url ?? "",
          `http://${request.headers.host}`,
        );

        if (url.pathname !== SYNC_PATH) {
          return;
        }

        wss.handleUpgrade(request, socket, head, (client) => {
          console.log("sync-dev-plugin: WebSocket upgrade handler starting (buffering messages)...");
          
          // Buffer messages while async ssrLoadModule runs to avoid race conditions
          const messageQueue: any[] = [];
          const onMessage = (data: any) => {
            messageQueue.push(data);
          };
          (client as any).on("message", onMessage);

          (async () => {
            try {
              // Load the handlers module dynamically from the user-configured path
              const handlersModule = await server.ssrLoadModule(handlersPath);
              const devEngine = await server.ssrLoadModule(
                "@sveltebase/sync/server/dev-engine",
              );

              // Register handlers dynamically before connecting client
              (devEngine.setHandlers as (handlers: any[]) => void)(
                handlersModule.handlers,
              );

              // Remove temporary buffering listener
              (client as any).off("message", onMessage);

              // Register client in the dev engine
              (devEngine.addClient as (ws: unknown, req: unknown) => void)(
                client,
                request,
              );
              console.log("sync-dev-plugin: WebSocket upgrade handler completed, replaying buffered messages:", messageQueue.length);

              // Replay any buffered messages
              for (const msg of messageQueue) {
                (client as any).emit("message", msg);
              }
            } catch (err) {
              console.error("sync-dev-plugin: Error in WebSocket upgrade handler:", err);
              try {
                (client as any).off("message", onMessage);
                (client as any).close(1011, "Internal server error");
              } catch {}
            }
          })();
        });
      });
    },
  };
}
