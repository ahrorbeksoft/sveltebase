import { serializeConnectionAuth } from '../server/auth.js';
import { INTERNAL_AUTH_HEADER } from '../server/handler.js';
import type {
  SyncMetric,
  SyncAuthResult,
  SyncPlatform,
  SyncServerRouteOptions,
} from '../server/index.js';

export type SyncWorkerOptions<TAuth = unknown> = SyncServerRouteOptions<TAuth>;

function report(metrics: SyncWorkerOptions['metrics'], metric: SyncMetric) {
  try {
    metrics?.(metric);
  } catch {
    // Observability must never change request handling.
  }
}

function platform(
  request: Request,
  env: Record<string, unknown>,
  ctx: ExecutionContext,
): SyncPlatform {
  return {
    env,
    context: {
      waitUntil(promise) {
        ctx.waitUntil(promise);
      },
    },
    metadata: request.cf,
  };
}
function websocket(request: Request) {
  return request.headers.get('upgrade')?.toLowerCase() === 'websocket';
}
async function validOrigin<TAuth>(
  request: Request,
  options: SyncWorkerOptions<TAuth>,
) {
  const origin = request.headers.get('origin');
  if (!origin) return true;
  if (typeof options.trustedOrigins === 'function')
    return options.trustedOrigins(origin, request);
  const allowed = options.trustedOrigins ?? [new URL(request.url).origin];
  return allowed.includes(origin);
}
async function acceptsOrigin<TAuth>(
  request: Request,
  options: SyncWorkerOptions<TAuth>,
) {
  try {
    return await validOrigin(request, options);
  } catch {
    return false;
  }
}
async function shardName<TAuth>(
  request: Request,
  auth: SyncAuthResult<TAuth>,
  option: SyncWorkerOptions<TAuth>['shard'],
) {
  const value =
    typeof option === 'function'
      ? await option({ request, auth })
      : (option ?? 'global');
  if (!value || value.length > 128) throw new Error('Invalid sync shard');
  return value;
}
async function forward(
  request: Request,
  env: Record<string, unknown>,
  binding: string,
  shard: string,
) {
  const namespace = env[binding] as DurableObjectNamespace | undefined;
  if (!namespace)
    return new Response(`Missing ${binding} Durable Object binding`, {
      status: 500,
    });
  return namespace.get(namespace.idFromName(shard)).fetch(request);
}

export async function handleSyncRequest<TAuth = unknown>(
  request: Request,
  env: Record<string, unknown>,
  ctx: ExecutionContext,
  options: SyncWorkerOptions<TAuth>,
) {
  const url = new URL(request.url);
  const path = options.websocketPath ?? '/api/sync';
  if (url.pathname !== path || request.method !== 'GET')
    return new Response('Not found', { status: 404 });
  if (!websocket(request))
    return new Response('Expected Upgrade: websocket', { status: 426 });
  if (!(await acceptsOrigin(request, options)))
    return new Response('Forbidden origin', { status: 403 });

  const headers = new Headers(request.headers);
  headers.delete(INTERNAL_AUTH_HEADER);
  const publicRequest = new Request(request, { headers });
  const runtime = platform(publicRequest, env, ctx);
  let auth: SyncAuthResult<TAuth>;
  try {
    auth = options.auth ? await options.auth(publicRequest, runtime) : null;
  } catch {
    return new Response('Unauthorized', { status: 401 });
  }
  if (!auth && options.allowUnauthenticated !== true)
    return new Response('Unauthorized', { status: 401 });
  if (
    auth &&
    (!auth.subject ||
      auth.subject.length > 256 ||
      (auth.expiresAt !== undefined &&
        (!Number.isFinite(auth.expiresAt) || auth.expiresAt <= Date.now())))
  )
    return new Response('Unauthorized', { status: 401 });

  let topics: string[] = auth ? [`subject:${auth.subject}`] : [];
  if (auth && options.topics) {
    const context = {
      platform: runtime,
      request: publicRequest,
      auth: { ...auth, topics },
      subject: auth.subject,
      topics: new Set(topics),
      cache: new Map<unknown, unknown>(),
      metrics: options.metrics,
    };
    try {
      for (const topic of await options.topics(context)) {
        if (topics.length >= 256)
          return new Response('Unauthorized', { status: 401 });
        topics.push(topic);
      }
      topics = [...new Set(topics)];
    } catch {
      return new Response('Unauthorized', { status: 401 });
    }
  }
  if (topics.some((topic) => !topic || topic.length > 256))
    return new Response('Unauthorized', { status: 401 });

  const internalHeaders = new Headers(headers);
  if (auth) {
    try {
      internalHeaders.set(
        INTERNAL_AUTH_HEADER,
        serializeConnectionAuth({ ...auth, topics }),
      );
    } catch {
      return new Response('Sync authentication failed', { status: 500 });
    }
  }
  const internalUrl = new URL(publicRequest.url);
  internalUrl.pathname = '/internal/websocket';
  const forwarded = new Request(internalUrl, {
    method: 'GET',
    headers: internalHeaders,
  });
  const binding = options.syncEngineBinding ?? 'SYNC_ENGINE';
  report(options.metrics, {
    name: 'broker-read',
    count: 1,
    operation: 'connection',
  });
  try {
    return await forward(
      forwarded,
      env,
      binding,
      await shardName(publicRequest, auth, options.shard),
    );
  } catch {
    return new Response('Sync service unavailable', { status: 503 });
  }
}
