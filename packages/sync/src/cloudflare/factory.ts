import { SyncEngineBase } from '../server/engine.js';
import type { SyncHandler, SyncMetrics } from '../server/index.js';
import { handleSyncRequest, type SyncWorkerOptions } from './handler.js';

export type SyncAppWorker = { fetch: NonNullable<ExportedHandler['fetch']> };
export function createSyncAppWorker<TAuth = unknown>(
  app: SyncAppWorker,
  options: SyncWorkerOptions<TAuth>,
): ExportedHandler {
  return {
    async fetch(request, env, ctx) {
      const url = new URL(request.url);
      if (
        url.pathname === (options.websocketPath ?? '/api/sync') &&
        request.method === 'GET'
      )
        return handleSyncRequest(
          request,
          env as Record<string, unknown>,
          ctx,
          options,
        );
      return app.fetch(request, env, ctx);
    },
  };
}
export type SyncEngineClass = new (
  ctx: DurableObjectState,
  env: Record<string, unknown>,
) => SyncEngineBase;
export function createSyncEngine(
  handlers: SyncHandler[],
  options: { metrics?: SyncMetrics } = {},
): SyncEngineClass {
  return class SyncEngine extends SyncEngineBase {
    constructor(ctx: DurableObjectState, env: Record<string, unknown>) {
      super(ctx, env, handlers, options.metrics);
    }
  };
}
