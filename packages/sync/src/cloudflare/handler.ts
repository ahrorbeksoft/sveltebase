import {
  configurePublisherPlatform,
  INTERNAL_AUTH_HEADER,
  type SyncAuthResult,
} from "../server/handler.js";
import { resolveIdentity, serializeConnectionAuth } from "../server/auth.js";
import type { SyncHandler, SyncPlatform } from "../server/index.js";

let activeHandlers: SyncHandler[] = [];

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

function withPath(request: Request, pathname: string) {
  const url = new URL(request.url);
  url.pathname = pathname;
  return url.toString();
}

function isWebSocketRequest(request: Request) {
  return request.headers.get("Upgrade")?.toLowerCase() === "websocket";
}

export function configureSyncEngine(handlers: SyncHandler[]) {
  activeHandlers = handlers;
}

export function getSyncEngineHandlers() {
  return activeHandlers;
}

export type SyncWorkerOptions<TAuth = unknown> = {
  handlers: SyncHandler[];
  syncEngineBinding?: string;
  websocketPath?: string;
  auth?: (
    request: Request,
    platform: SyncPlatform,
  ) => Promise<SyncAuthResult<TAuth>> | SyncAuthResult<TAuth>;
  identity?: (auth: TAuth) => string | number | bigint | null | undefined;
  allowUnauthenticated?: boolean;
};

type SyncAuthResolverMetadata = {
  allowUnauthenticated?: boolean;
};

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
    Pick<SyncWorkerOptions<TAuth>, "auth" | "identity" | "handlers">,
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

  const forwardedHeaders = new Headers(publicRequest.headers);
  forwardedHeaders.delete(INTERNAL_AUTH_HEADER);
  if (resolvedAuth) {
    forwardedHeaders.set(
      INTERNAL_AUTH_HEADER,
      serializeConnectionAuth(resolvedAuth, identity),
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

  if (url.pathname === websocketPath && request.method === "GET") {
    return handleWebSocket(request, env, ctx, {
      ...options,
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
      url.pathname === "/broadcast-batch") &&
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
