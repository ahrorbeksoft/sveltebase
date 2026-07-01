import type { RequestHandler } from "@sveltejs/kit";
import { configurePublisherPlatform } from "../server/handler.js";
import {
  handleSyncRequest,
  type SyncWorkerOptions,
} from "../cloudflare/handler.js";

/**
 * Options for a SvelteKit route that serves the sync websocket.
 */
export type SyncEngineRouteOptions<TAuth = unknown> =
  SyncWorkerOptions<TAuth>;

type CloudflarePlatform = {
  env?: Record<string, unknown>;
  context?: ExecutionContext;
  ctx?: ExecutionContext;
};

/**
 * Returns the Cloudflare execution context or a no-op fallback for local dev.
 */
function getExecutionContext(platform: CloudflarePlatform | undefined) {
  const context = platform?.context ?? platform?.ctx;
  if (context) return context;

  return {
    waitUntil() {},
    passThroughOnException() {},
  } as unknown as ExecutionContext;
}

/**
 * Creates SvelteKit route handlers for the sync websocket endpoint.
 *
 * Place the returned `GET` in a SvelteKit server route such as
 * `src/routes/api/sync/+server.ts`. The route requires Cloudflare `platform.env`
 * because it forwards websocket traffic to the sync Durable Object.
 */
export function syncEngineRoute<TAuth = unknown>(
  options: SyncEngineRouteOptions<TAuth>,
): {
  GET: RequestHandler;
} {
  const handler: RequestHandler = async (event) => {
    const platform = event.platform as CloudflarePlatform | undefined;
    const env = platform?.env;

    if (!env) {
      return new Response(
        "Missing Cloudflare platform env. Configure adapter-cloudflare platformProxy for Vite dev or run under wrangler.",
        { status: 500 },
      );
    }

    configurePublisherPlatform(
      { env },
      options.syncEngineBinding ?? "SYNC_ENGINE",
    );

    return handleSyncRequest(
      event.request,
      env,
      getExecutionContext(platform),
      options,
    );
  };

  return {
    GET: handler,
  };
}
