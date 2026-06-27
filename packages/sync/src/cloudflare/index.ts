import { SyncEngineBase } from "../server/engine.js";
import {
  INTERNAL_AUTH_HEADER,
  type SyncAuthResult,
} from "../server/handler.js";
import type { SyncHandler, SyncPlatform } from "../server/index.js";

type SerializedConnectionAuth = {
  auth: any;
  identity: string | null;
};

let activeHandlers: SyncHandler[] = [];

function defaultIdentity(auth: any): string | null {
  const value = auth?.identity ?? auth?.user?.id ?? auth?.userId;
  return value == null ? null : String(value);
}

function serializeConnectionAuth(auth: any, identity: string | null): string {
  const payload: SerializedConnectionAuth = { auth, identity };
  return btoa(unescape(encodeURIComponent(JSON.stringify(payload))));
}

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

export type SyncWorkerOptions<TAuth = unknown> = {
  handlers: SyncHandler[];
  durableObjectBinding?: string;
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
  durableObjectBinding: string,
) {
  const namespace = env[durableObjectBinding] as
    | DurableObjectNamespace
    | undefined;
  if (!namespace) {
    return new Response(
      `Missing ${durableObjectBinding} Durable Object binding`,
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
      "durableObjectBinding" | "websocketPath" | "allowUnauthenticated"
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
      const identityValue = options.identity
        ? options.identity(resolvedAuth)
        : defaultIdentity(resolvedAuth);
      identity = identityValue == null ? null : String(identityValue);
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
    options.durableObjectBinding,
  );
}

export function createSyncWorker<TAuth = unknown>(
  options: SyncWorkerOptions<TAuth>,
): ExportedHandler {
  activeHandlers = options.handlers;

  const durableObjectBinding = options.durableObjectBinding ?? "SYNC_ENGINE";
  const websocketPath = options.websocketPath ?? "/api/sync";
  const authMetadata = options.auth as
    | (SyncAuthResolverMetadata & Function)
    | undefined;
  const allowUnauthenticated =
    options.allowUnauthenticated ??
    authMetadata?.allowUnauthenticated ??
    true;

  return {
    async fetch(request, env, ctx) {
      const url = new URL(request.url);
      const workerEnv = env as Record<string, unknown>;

      if (url.pathname === websocketPath && request.method === "GET") {
        return handleWebSocket(request, workerEnv, ctx, {
          ...options,
          durableObjectBinding,
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
          workerEnv,
          durableObjectBinding,
        );
      }

      return new Response("Not found", { status: 404 });
    },
  };
}

export function defineSyncWorker<TAuth = unknown>(
  options: SyncWorkerOptions<TAuth>,
): ExportedHandler {
  return createSyncWorker(options);
}

export class SyncEngine extends SyncEngineBase {
  constructor(ctx: DurableObjectState, env: Record<string, unknown>) {
    super(ctx, env, activeHandlers);
  }
}
