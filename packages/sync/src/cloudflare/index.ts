import { SyncEngineBase } from "../server/engine.js";
import { configurePublisherPlatform } from "../server/handler.js";
import {
  configureSyncEngine,
  getSyncEngineHandlers,
  handleSyncRequest,
  type SyncWorkerOptions,
} from "./handler.js";

export {
  configureSyncEngine,
  handleSyncRequest,
  type SyncWorkerOptions,
} from "./handler.js";

export type SyncAppWorker = {
  fetch: NonNullable<ExportedHandler["fetch"]>;
};

export function createSyncAppWorker<TAuth = unknown>(
  app: SyncAppWorker,
  options: SyncWorkerOptions<TAuth>,
): ExportedHandler {
  configureSyncEngine(options.handlers);

  return {
    async fetch(request, env, ctx) {
      const syncEngineBinding = options.syncEngineBinding ?? "SYNC_ENGINE";
      configurePublisherPlatform(
        { env: env as Record<string, unknown> },
        syncEngineBinding,
      );

      const url = new URL(request.url);
      const websocketPath = options.websocketPath ?? "/api/sync";
      if (
        (url.pathname === websocketPath && request.method === "GET") ||
        ((url.pathname === "/broadcast" ||
          url.pathname === "/broadcast-batch") &&
          request.method === "POST")
      ) {
        return handleSyncRequest(
          request,
          env as Record<string, unknown>,
          ctx,
          options,
        );
      }

      return app.fetch(request, env, ctx);
    },
  };
}

export class SyncEngine extends SyncEngineBase {
  constructor(ctx: DurableObjectState, env: Record<string, unknown>) {
    super(ctx, env, getSyncEngineHandlers());
  }
}
