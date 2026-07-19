import type { IncomingMessage } from "node:http";
import { resolveIdentity } from "./auth.js";
import { SyncBroker, type ISyncConnection } from "./broker.js";
import type { ResolveTopics, SyncHandler, SyncPlatform } from "./index.js";

const GLOBAL_BROKER_KEY = "__sveltebase_sync_dev_broker__";
const GLOBAL_PLATFORM_KEY = "__sveltebase_sync_dev_platform__";

type DevBrokerState = {
  broker: SyncBroker;
};

let devBroker: SyncBroker | null = null;

export type SyncDevAuthOptions<TAuth = unknown> = {
  /**
   * Resolves auth for a local dev websocket request.
   *
   * Return `null` or `undefined` for guests.
   */
  auth?: (
    request: Request,
    platform: SyncPlatform,
  ) => Promise<TAuth | null | undefined> | TAuth | null | undefined;
  /** Converts the auth object into the identity used for the default user topic. */
  identity?: (auth: TAuth) => string | number | bigint | null | undefined;
  /** Resolves connection topics used for live row-payload routing. */
  topics?: ResolveTopics<TAuth>;
  /** Whether unauthenticated local websocket clients may connect. */
  allowUnauthenticated?: boolean;
  /** Platform object or resolver used by auth and handlers in dev. */
  platform?: SyncPlatform | (() => Promise<SyncPlatform> | SyncPlatform);
  /** Optional Wrangler config path for `getPlatformProxy`. */
  wranglerConfigPath?: string;
};

/**
 * Stores the dev broker on `globalThis` so Vite module reloads can reuse it.
 */
function setGlobalBroker(state: DevBrokerState) {
  const globalObject = globalThis as unknown as Record<
    string,
    DevBrokerState | undefined
  >;
  globalObject[GLOBAL_BROKER_KEY] = state;
}

/**
 * Reads the shared dev broker from `globalThis`.
 */
function getGlobalBroker() {
  const globalObject = globalThis as unknown as Record<
    string,
    DevBrokerState | undefined
  >;
  return globalObject[GLOBAL_BROKER_KEY];
}

/**
 * Creates or updates the in-memory dev broker handlers.
 *
 * Called by the Vite plugin when a websocket connects and after handlers are
 * loaded through Vite SSR.
 */
export function setHandlers(handlers: SyncHandler[]) {
  const existing = getGlobalBroker();
  if (!existing) {
    const state = { broker: new SyncBroker(handlers) };
    setGlobalBroker(state);
    devBroker = state.broker;
    return;
  }

  existing.broker.setHandlers(handlers);
  devBroker = existing.broker;
}

/**
 * Returns the active dev broker or throws if the plugin has not initialized it.
 */
function getDevBroker(): SyncBroker {
  if (devBroker) return devBroker;

  const existing = getGlobalBroker();
  if (existing) {
    devBroker = existing.broker;
    return existing.broker;
  }

  throw new Error("Sync dev broker not initialized. Call setHandlers first.");
}

/**
 * Normalizes Node request header values to a single string.
 */
function getHeaderValue(value: string | string[] | undefined) {
  if (Array.isArray(value)) return value[0];
  return value;
}

/**
 * Converts Node HTTP headers into a Fetch `Headers` object.
 */
function headersFromIncomingMessage(req: IncomingMessage) {
  const headers = new Headers();
  for (const [key, value] of Object.entries(req.headers)) {
    if (value === undefined) continue;
    if (Array.isArray(value)) {
      for (const item of value) headers.append(key, item);
      continue;
    }
    headers.set(key, value);
  }
  return headers;
}

/**
 * Builds a Fetch `Request` from Vite's websocket upgrade request.
 */
function requestFromIncomingMessage(req: IncomingMessage) {
  const host = getHeaderValue(req.headers.host) ?? "localhost";
  const url = new URL(req.url ?? "", `http://${host}`);
  return new Request(url.toString(), {
    headers: headersFromIncomingMessage(req),
  });
}

/**
 * Resolves the platform used in local dev auth and sync handlers.
 *
 * Prefer explicit `options.platform`, then a cached Wrangler platform proxy,
 * then an empty env fallback when Wrangler is unavailable.
 */
async function resolvePlatform(options?: SyncDevAuthOptions) {
  if (options?.platform) {
    return typeof options.platform === "function"
      ? await options.platform()
      : options.platform;
  }

  const globalObject = globalThis as unknown as Record<
    string,
    { platform: SyncPlatform } | undefined
  >;
  const existing = globalObject[GLOBAL_PLATFORM_KEY];
  if (existing) return existing.platform;

  try {
    const { getPlatformProxy } = await import("wrangler");
    const proxy = await getPlatformProxy(
      options?.wranglerConfigPath
        ? { configPath: options.wranglerConfigPath }
        : undefined,
    );
    const platform = proxy as unknown as SyncPlatform;
    globalObject[GLOBAL_PLATFORM_KEY] = { platform };
    return platform;
  } catch {
    const platform: SyncPlatform = { env: {} };
    globalObject[GLOBAL_PLATFORM_KEY] = { platform };
    return platform;
  }
}

/**
 * Adds a Vite dev websocket client to the shared broker.
 *
 * The Vite plugin calls this after loading handlers. It resolves auth, creates
 * an `ISyncConnection`, then wires websocket events into the broker.
 */
export async function addClient(
  ws: {
    send: (data: string) => void;
    close: (code?: number, reason?: string) => void;
    on: (event: string, listener: (...args: any[]) => void) => void;
  },
  req: IncomingMessage,
  options?: SyncDevAuthOptions,
): Promise<boolean> {
  const broker = getDevBroker();
  const request = requestFromIncomingMessage(req);
  const platform = await resolvePlatform(options);
  const subscribedChannels = new Set<string>();
  let auth: any = null;
  let identity: string | null = null;
  let topics: string[] = [];

  try {
    if (options?.auth) {
      auth = (await options.auth(request, platform)) ?? null;

      if (!auth && options.allowUnauthenticated === false) {
        ws.close(1008, "Unauthorized");
        return false;
      }

      if (auth) {
        identity = resolveIdentity(auth, options.identity);
      }
    }

    if (identity) {
      topics.push(`user:${identity}`);
    }

    if (options?.topics) {
      const baseTopics = topics;
      const topicCtx = {
        platform,
        request,
        auth: auth
          ? {
              user: auth,
              identity,
              topics,
            }
          : null,
        identity,
        topics: new Set(baseTopics),
        cache: new Map<string, unknown>(),
      };
      topics = Array.from(
        new Set([...baseTopics, ...(await options.topics(topicCtx))]),
      );
    }
  } catch (error) {
    console.error("sync dev engine: websocket setup failed", error);
    ws.close(1011, "Internal server error");
    return false;
  }

  const conn: ISyncConnection = {
    send(data) {
      ws.send(data);
    },
    close(code, reason) {
      ws.close(code, reason);
    },
    getAuth() {
      return auth;
    },
    setAuth(newAuth) {
      auth = newAuth;
    },
    getIdentity() {
      return identity;
    },
    setIdentity(newIdentity) {
      identity = newIdentity;
    },
    getTopics() {
      return new Set(topics);
    },
    setTopics(newTopics) {
      topics = Array.from(newTopics);
    },
    getSubscribedChannels() {
      return subscribedChannels;
    },
    headers: request.headers,
    url: request.url,
  };

  broker.registerConnection(conn);

  ws.on("message", async (data: any) => {
    const message = typeof data === "string" ? data : String(data);
    try {
      await broker.handleMessage(conn, message, platform, request);
    } catch (err) {
      console.error("sync dev engine: error handling message", err);
    }
  });

  ws.on("close", () => {
    broker.removeConnection(conn);
  });

  ws.on("error", () => {
    broker.removeConnection(conn);
  });

  return true;
}

/**
 * Publishes one external row change through the dev broker.
 */
export async function broadcastExternalChange(
  channel: string,
  action: "create" | "update" | "delete",
  key: string | undefined,
  data: any,
) {
  const broker = getDevBroker();
  const platform = await resolvePlatform();
  await broker.handleExternalChange(channel, action, key, data, platform);
}

/**
 * Publishes multiple external row changes through the dev broker.
 */
export async function broadcastExternalBatchChange(
  channel: string,
  changes: Array<{
    action: "create" | "update" | "delete";
    key?: string;
    data?: any;
  }>,
) {
  const broker = getDevBroker();
  const platform = await resolvePlatform();
  await broker.handleExternalBatchChange(channel, changes, platform);
}

/**
 * Notifies dev clients that a channel should be resynced.
 */
export async function broadcastChannelChange(channel: string) {
  const broker = getDevBroker();
  await broker.handleExternalChannelChange(channel);
}

/**
 * Notifies dev clients that a channel should be fully replaced.
 */
export async function broadcastChannelReset(
  channel: string,
  topics: string[] | "all" = "all",
) {
  const broker = getDevBroker();
  await broker.handleExternalChannelReset(channel, topics);
}
