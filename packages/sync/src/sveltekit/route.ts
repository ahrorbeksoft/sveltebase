import type { RequestHandler } from '@sveltejs/kit';
import { handleSyncRequest } from '../cloudflare/handler.js';
import type { SyncServerRouteOptions } from '../server/index.js';

export type SyncEngineRouteOptions<TAuth = unknown> =
  SyncServerRouteOptions<TAuth>;
type WorkerContext = { waitUntil(promise: Promise<unknown>): void };
type CloudflarePlatform = {
  env?: Record<string, unknown>;
  context?: WorkerContext;
  ctx?: WorkerContext;
};
export function syncEngineRoute<TAuth = unknown>(
  options: SyncEngineRouteOptions<TAuth>,
): { GET: RequestHandler } {
  return {
    GET: async (event) => {
      const platform = event.platform as CloudflarePlatform | undefined;
      const env = platform?.env;
      const context = platform?.context ?? platform?.ctx;
      if (!env || !context)
        return new Response('Sync requires the Cloudflare runtime', {
          status: 503,
        });
      return handleSyncRequest(
        event.request,
        env,
        context as unknown as ExecutionContext,
        options,
      );
    },
  };
}
