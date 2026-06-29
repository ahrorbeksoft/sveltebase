import type { IncomingMessage } from "node:http";
import { resolveIdentity } from "./auth.js";
import { SyncBroker, type ISyncConnection } from "./broker.js";
import type { SyncHandler, SyncPlatform } from "./index.js";

const GLOBAL_BROKER_KEY = "__sveltebase_sync_dev_broker__";
const GLOBAL_PLATFORM_KEY = "__sveltebase_sync_dev_platform__";

type DevBrokerState = {
  broker: SyncBroker;
};

let devBroker: SyncBroker | null = null;

export type SyncDevAuthOptions<TAuth = unknown> = {
  auth?: (
    request: Request,
    platform: SyncPlatform,
  ) => Promise<TAuth | null | undefined> | TAuth | null | undefined;
  identity?: (auth: TAuth) => string | number | bigint | null | undefined;
  allowUnauthenticated?: boolean;
  platform?: SyncPlatform | (() => Promise<SyncPlatform> | SyncPlatform);
  wranglerConfigPath?: string;
};

function setGlobalBroker(state: DevBrokerState) {
  const globalObject = globalThis as unknown as Record<
    string,
    DevBrokerState | undefined
  >;
  globalObject[GLOBAL_BROKER_KEY] = state;
}

function getGlobalBroker() {
  const globalObject = globalThis as unknown as Record<
    string,
    DevBrokerState | undefined
  >;
  return globalObject[GLOBAL_BROKER_KEY];
}

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

function getDevBroker(): SyncBroker {
  if (devBroker) return devBroker;

  const existing = getGlobalBroker();
  if (existing) {
    devBroker = existing.broker;
    return existing.broker;
  }

  throw new Error("Sync dev broker not initialized. Call setHandlers first.");
}

function getHeaderValue(value: string | string[] | undefined) {
  if (Array.isArray(value)) return value[0];
  return value;
}

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

function requestFromIncomingMessage(req: IncomingMessage) {
  const host = getHeaderValue(req.headers.host) ?? "localhost";
  const url = new URL(req.url ?? "", `http://${host}`);
  return new Request(url.toString(), {
    headers: headersFromIncomingMessage(req),
  });
}

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
  } catch {
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

export async function broadcastExternalChange(
  channel: string,
  action: "create" | "update" | "delete",
  key: string | undefined,
  data: any,
) {
  const broker = getDevBroker();
  await broker.handleExternalChange(channel, action, key, data);
}

export async function broadcastExternalBatchChange(
  channel: string,
  changes: Array<{
    action: "create" | "update" | "delete";
    key?: string;
    data?: any;
  }>,
) {
  const broker = getDevBroker();
  await broker.handleExternalBatchChange(channel, changes);
}
