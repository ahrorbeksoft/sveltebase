import {
  configurePublisherPlatform,
  INTERNAL_AUTH_HEADER,
  type SyncAuthResult,
} from "../server/handler.js";
import { resolveIdentity, serializeConnectionAuth } from "../server/auth.js";
import type { ResolveTopics, SyncHandler, SyncPlatform } from "../server/index.js";

let activeHandlers: SyncHandler[] = [];

/**
 * Creates the platform object passed to sync auth and handlers.
 */
function createPlatform(
  request: Request,
  env: Record<string, unknown>,
  ctx: ExecutionContext,
): SyncPlatform {
  return {
    env,
    ctx,
    context: ctx,
    caches,
    cf: request.cf as IncomingRequestCfProperties | undefined,
  };
}

/**
 * Returns a copy of the request URL with a different pathname.
 */
function withPath(request: Request, pathname: string) {
  const url = new URL(request.url);
  url.pathname = pathname;
  return url.toString();
}

/**
 * Checks whether a request is trying to upgrade to a websocket.
 */
function isWebSocketRequest(request: Request) {
  return request.headers.get("Upgrade")?.toLowerCase() === "websocket";
}

/**
 * Stores the active sync handlers for the Durable Object constructor.
 *
 * Called by Cloudflare and SvelteKit adapters before requests are routed.
 */
export function configureSyncEngine(handlers: SyncHandler[]) {
  activeHandlers = handlers;
}

/**
 * Returns handlers previously registered with `configureSyncEngine`.
 *
 * `SyncEngine` calls this in its Durable Object constructor.
 */
export function getSyncEngineHandlers() {
  return activeHandlers;
}

/**
 * Options for handling sync requests in a Cloudflare Worker.
 */
export type SyncWorkerOptions<TAuth = unknown> = {
  /** Handlers returned by `defineSync`. */
  handlers: SyncHandler[];
  /** Durable Object binding name. Defaults to `"SYNC_ENGINE"`. */
  syncEngineBinding?: string;
  /** Public websocket path. Defaults to `"/api/sync"`. */
  websocketPath?: string;
  /**
   * Resolves auth for the websocket request before it is forwarded.
   *
   * Return a user/session object for authenticated clients or `null` for guests.
   */
  auth?: (
    request: Request,
    platform: SyncPlatform,
  ) => Promise<SyncAuthResult<TAuth>> | SyncAuthResult<TAuth>;
  /** Converts the auth object into the identity used for the default user topic. */
  identity?: (auth: TAuth) => string | number | bigint | null | undefined;
  /** Resolves connection topics used for live row-payload routing. */
  topics?: ResolveTopics<TAuth>;
  /**
   * Whether clients without auth may connect.
   *
   * Defaults to `true` unless the auth resolver carries metadata from helpers
   * such as `sessionCookieAuth`.
   */
  allowUnauthenticated?: boolean;
};

type SyncAuthResolverMetadata = {
  allowUnauthenticated?: boolean;
  identity?: (auth: any) => string | number | bigint | null | undefined;
};

/**
 * Forwards a request to the singleton sync Durable Object instance.
 */
async function forwardToEngine(
  request: Request,
  env: Record<string, unknown>,
  syncEngineBinding: string,
) {
  const namespace = env[syncEngineBinding] as
    | DurableObjectNamespace
    | undefined;
  if (!namespace) {
    return new Response(
      `Missing ${syncEngineBinding} Durable Object binding`,
      { status: 500 },
    );
  }

  const id = namespace.idFromName("global");
  return namespace.get(id).fetch(request);
}

/**
 * Authenticates and forwards a public websocket request to the Durable Object.
 *
 * Auth is serialized into an internal header after stripping any client-supplied
 * value with the same name.
 */
async function handleWebSocket<TAuth>(
  request: Request,
  env: Record<string, unknown>,
  ctx: ExecutionContext,
  options: Required<
    Pick<
      SyncWorkerOptions<TAuth>,
      "syncEngineBinding" | "websocketPath" | "allowUnauthenticated"
    >
  > &
    Pick<SyncWorkerOptions<TAuth>, "auth" | "identity" | "topics" | "handlers">,
) {
  if (!isWebSocketRequest(request)) {
    return new Response("Expected Upgrade: websocket", { status: 426 });
  }

  const publicHeaders = new Headers(request.headers);
  publicHeaders.delete(INTERNAL_AUTH_HEADER);

  const publicRequest = new Request(request, {
    headers: publicHeaders,
  });
  const platform = createPlatform(publicRequest, env, ctx);

  let resolvedAuth: TAuth | null = null;
  let identity: string | null = null;
  let topics: string[] = [];

  if (options.auth) {
    resolvedAuth = (await options.auth(publicRequest, platform)) ?? null;

    if (!resolvedAuth && options.allowUnauthenticated === false) {
      return new Response("Unauthorized", { status: 401 });
    }

    if (resolvedAuth) {
      identity = resolveIdentity(resolvedAuth, options.identity);
    }
  } else if (options.allowUnauthenticated === false) {
    return new Response("Unauthorized", { status: 401 });
  }

  if (identity) {
    topics.push(`user:${identity}`);
  }

  if (options.topics) {
    const baseTopics = topics;
    const topicCtx = {
      platform,
      request: publicRequest,
      auth: resolvedAuth
        ? {
            user: resolvedAuth,
            identity,
            topics,
          }
        : null,
      identity,
      topics: new Set(baseTopics),
    };
    topics = Array.from(
      new Set([...baseTopics, ...(await options.topics(topicCtx))]),
    );
  } else if (
    options.handlers?.some((handler) => Boolean(handler.config.broadcastTopics))
  ) {
    // Footgun: scoped live delivery and topic-targeted resets need a topics
    // resolver. Without it, only the default user:{id} topic is attached.
    console.warn(
      "[@sveltebase/sync] Handlers declare broadcastTopics but no `topics` resolver was passed to the worker. Scoped live payloads will not reach clients.",
    );
  }

  const forwardedHeaders = new Headers(publicRequest.headers);
  forwardedHeaders.delete(INTERNAL_AUTH_HEADER);
  if (resolvedAuth || topics.length > 0) {
    forwardedHeaders.set(
      INTERNAL_AUTH_HEADER,
      serializeConnectionAuth(resolvedAuth, identity, topics),
    );
  }

  const forwardedRequest = new Request(
    withPath(publicRequest, "/websocket"),
    publicRequest,
  );
  for (const [key, value] of forwardedHeaders) {
    forwardedRequest.headers.set(key, value);
  }

  return forwardToEngine(
    forwardedRequest,
    env,
    options.syncEngineBinding,
  );
}

/**
 * Handles public sync HTTP requests in a Cloudflare Worker.
 *
 * Websocket requests are authenticated and forwarded to `/websocket` on the
 * Durable Object. Broadcast endpoints are also forwarded after internal headers
 * are stripped.
 */
export async function handleSyncRequest<TAuth = unknown>(
  request: Request,
  env: Record<string, unknown>,
  ctx: ExecutionContext,
  options: SyncWorkerOptions<TAuth>,
) {
  configureSyncEngine(options.handlers);

  const syncEngineBinding = options.syncEngineBinding ?? "SYNC_ENGINE";
  configurePublisherPlatform({ env }, syncEngineBinding);

  const url = new URL(request.url);
  const websocketPath = options.websocketPath ?? "/api/sync";
  const authMetadata = options.auth as
    | (SyncAuthResolverMetadata & Function)
    | undefined;
  const allowUnauthenticated =
    options.allowUnauthenticated ??
    authMetadata?.allowUnauthenticated ??
    true;
  const identity = options.identity ?? authMetadata?.identity;

  if (url.pathname === websocketPath && request.method === "GET") {
    return handleWebSocket(request, env, ctx, {
      ...options,
      identity,
      syncEngineBinding,
      websocketPath,
      allowUnauthenticated,
    });
  }

  if (url.pathname === "/websocket") {
    return new Response("Not found", { status: 404 });
  }

  if (
    (url.pathname === "/broadcast" ||
      url.pathname === "/broadcast-batch" ||
      url.pathname === "/broadcast-change" ||
      url.pathname === "/broadcast-reset") &&
    request.method === "POST"
  ) {
    const headers = new Headers(request.headers);
    headers.delete(INTERNAL_AUTH_HEADER);
    return forwardToEngine(
      new Request(request, { headers }),
      env,
      syncEngineBinding,
    );
  }

  return new Response("Not found", { status: 404 });
}
