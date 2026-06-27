import { SyncBroker, type ISyncConnection } from "./broker.js";
import type { SyncHandler } from "./index.js";
import type { SyncUpgradeOptions } from "./handler.js";
import type { IncomingMessage } from "node:http";

const GLOBAL_KEY = "__sync_dev_broker__";

type DevBrokerState = {
  broker: SyncBroker;
};

let devBroker: SyncBroker | null = null;

export function setHandlers(handlers: SyncHandler[]) {
  const g = globalThis as unknown as Record<string, DevBrokerState | undefined>;
  if (!g[GLOBAL_KEY]) {
    const broker = new SyncBroker(handlers);
    g[GLOBAL_KEY] = { broker };
  } else {
    g[GLOBAL_KEY].broker.setHandlers(handlers);
  }
  devBroker = g[GLOBAL_KEY].broker;
}

function getDevBroker(): SyncBroker {
  if (devBroker) return devBroker;

  const g = globalThis as unknown as Record<string, DevBrokerState | undefined>;
  if (g[GLOBAL_KEY]) {
    devBroker = g[GLOBAL_KEY].broker;
    return devBroker!;
  }

  throw new Error("Sync dev broker not initialized. Call setHandlers first.");
}

export async function addClient(
  ws: {
    send: (data: string) => void;
    close: (code?: number, reason?: string) => void;
    on: (event: string, listener: (...args: any[]) => void) => void;
  },
  req: IncomingMessage,
  options?: SyncUpgradeOptions,
): Promise<boolean> {
  const broker = getDevBroker();
  const subscribedChannels = new Set<string>();
  let auth: any = null;
  let identity: string | null = null;

  // Convert Node IncomingMessage headers to web-standard Headers
  const headers = new Headers();
  for (const [key, value] of Object.entries(req.headers)) {
    if (value === undefined) continue;
    if (Array.isArray(value)) {
      for (const v of value) {
        headers.append(key, v);
      }
    } else {
      headers.set(key, value);
    }
  }

  const urlObj = new URL(
    req.url ?? "",
    `http://${req.headers.host || "localhost"}`,
  );

  const initConnection = async () => {
    const request = new Request(urlObj.toString(), { headers });

    if (options?.auth) {
      auth = (await options.auth(request, undefined)) ?? null;

      if (!auth && options.allowUnauthenticated === false) {
        ws.close(1008, "Unauthorized");
        return false;
      }

      if (auth) {
        const identityValue = options.identity
          ? options.identity(auth)
          : ((auth as any)?.user?.id ?? (auth as any)?.userId);
        identity = identityValue == null ? null : String(identityValue);
      }
    }

    // Legacy fallback for existing demos/apps that pass identity in URL/header.
    const userId = urlObj.searchParams.get("userId") || headers.get("x-user-id");
    if (userId && !auth) {
      auth = { userId };
      identity = userId;
    }

    return true;
  };

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
    headers,
    url: urlObj.toString(),
  };

  try {
    const ok = await initConnection();
    if (!ok) return false;
    broker.registerConnection(conn);
    console.log("dev-engine: addClient registered connection");
  } catch (err) {
    console.error("dev-engine: Error initializing connection:", err);
    try {
      ws.close(1011, "Internal server error");
    } catch {}
    return false;
  }

  ws.on("message", async (data: any) => {
    const messageString = String(data);
    console.log("dev-engine: WebSocket message received:", messageString.slice(0, 100));
    const request = new Request(conn.url, {
      headers: conn.headers,
    });
    try {
      console.log("dev-engine: getting platform proxy...");
      const platform = await getPlatform();
      console.log("dev-engine: platform proxy obtained, handling message...");
      await broker.handleMessage(conn, messageString, platform, request);
      console.log("dev-engine: message handled successfully");
    } catch (err) {
      console.error("dev-engine: Error handling message:", err);
    }
  });

  ws.on("close", () => {
    console.log("dev-engine: WebSocket connection closed");
    broker.removeConnection(conn);
  });

  ws.on("error", (err) => {
    console.error("dev-engine: WebSocket connection error:", err);
    broker.removeConnection(conn);
  });

  return true;
}

const GLOBAL_PLATFORM_KEY = "__sync_dev_platform__";

type DevPlatformState = {
  platform: any;
};

async function getPlatform() {
  const g = globalThis as unknown as Record<string, DevPlatformState | undefined>;
  if (!g[GLOBAL_PLATFORM_KEY]) {
    try {
      console.log("dev-engine: calling getPlatformProxy()...");
      const startTime = Date.now();
      const { getPlatformProxy } = await import("wrangler");
      const platform = await getPlatformProxy();
      g[GLOBAL_PLATFORM_KEY] = { platform };
      console.log(`dev-engine: getPlatformProxy() succeeded in ${Date.now() - startTime}ms`);
    } catch (err) {
      console.error("dev-engine: Failed to load wrangler platform proxy:", err);
    }
  }
  return g[GLOBAL_PLATFORM_KEY]?.platform;
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
