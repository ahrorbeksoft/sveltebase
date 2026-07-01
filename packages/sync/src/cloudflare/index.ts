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

/**
 * Minimal Worker app shape accepted by `createSyncAppWorker`.
 */
export type SyncAppWorker = {
  fetch: NonNullable<ExportedHandler["fetch"]>;
};

/**
 * Wraps an existing Cloudflare Worker app with sync routing.
 *
 * Requests for the configured websocket path and internal broadcast endpoints
 * are handled by sync. Everything else is delegated to `app.fetch`.
 *
 * @example
 * ```ts
 * export default createSyncAppWorker(app, {
 *   handlers,
 *   auth: sessionCookieAuth({ secretBinding: "JWT_SECRET" })
 * });
 * ```
 */
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
          url.pathname === "/broadcast-batch" ||
          url.pathname === "/broadcast-change") &&
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

/**
 * Durable Object class that hosts the sync broker in production.
 *
 * Export this class from the worker module and bind it as `SYNC_ENGINE`.
 */
export class SyncEngine extends SyncEngineBase {
  /**
   * Creates the production Durable Object using handlers registered by the worker.
   */
  constructor(ctx: DurableObjectState, env: Record<string, unknown>) {
    super(ctx, env, getSyncEngineHandlers());
  }
}
