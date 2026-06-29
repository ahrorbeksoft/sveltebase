import type { RequestHandler } from "@sveltejs/kit";
import { configurePublisherPlatform } from "../server/handler.js";
import {
  handleSyncRequest,
  type SyncWorkerOptions,
} from "../cloudflare/handler.js";

export type SyncEngineRouteOptions<TAuth = unknown> =
  SyncWorkerOptions<TAuth>;

type CloudflarePlatform = {
  env?: Record<string, unknown>;
  context?: ExecutionContext;
  ctx?: ExecutionContext;
};

function getExecutionContext(platform: CloudflarePlatform | undefined) {
  const context = platform?.context ?? platform?.ctx;
  if (context) return context;

  return {
    waitUntil() {},
    passThroughOnException() {},
  } as unknown as ExecutionContext;
}

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
