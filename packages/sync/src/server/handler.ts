import type { SyncHandler } from "./index.js";

export type PublishEventData<TRecord, TAction extends "create" | "update" | "delete"> =
  TAction extends "create"
    ? TRecord
    : TAction extends "update"
      ? Partial<TRecord>
      : { updatedAt?: string } | undefined;

export type InferSchemaFromHandlers<T extends SyncHandler[]> = {
  [K in T[number] as K["config"]["channel"] extends string
    ? K["config"]["channel"]
    : K["config"]["channel"] extends (...args: any[]) => infer R
      ? R extends string
        ? R
        : string
      : string]: K extends SyncHandler<infer TRow> ? TRow : never;
};

export function createPublisher<TSchema extends Record<string, any>>(): <
  TChannel extends keyof TSchema & string,
  TAction extends "create" | "update" | "delete",
>(
  channel: TChannel | `${TChannel}:${string}`,
  action: TAction,
  key: string | undefined,
  data: PublishEventData<TSchema[TChannel], TAction>,
) => Promise<void>;

export function createPublisher<THandlers extends SyncHandler[]>(
  handlers: THandlers
): <
  TChannel extends keyof InferSchemaFromHandlers<THandlers> & string,
  TAction extends "create" | "update" | "delete",
>(
  channel: TChannel | `${TChannel}:${string}`,
  action: TAction,
  key: string | undefined,
  data: PublishEventData<InferSchemaFromHandlers<THandlers>[TChannel], TAction>,
) => Promise<void>;

export function createPublisher(handlers?: SyncHandler[]) {
  return async (
    channel: string,
    action: "create" | "update" | "delete",
    key: string | undefined,
    data: any,
  ): Promise<void> => {
    const resolvedChannel = String(channel);
    return publishEvent(resolvedChannel, action, key, data);
  };
}

export function createBulkPublisher<TSchema extends Record<string, any>>(): <
  TChannel extends keyof TSchema & string,
>(
  channel: TChannel | `${TChannel}:${string}`,
  changes: Array<{
    action: "create" | "update" | "delete";
    key?: string;
    data?: any;
  }>,
) => Promise<void>;

export function createBulkPublisher<THandlers extends SyncHandler[]>(
  handlers: THandlers
): <
  TChannel extends keyof InferSchemaFromHandlers<THandlers> & string,
>(
  channel: TChannel | `${TChannel}:${string}`,
  changes: Array<{
    action: "create" | "update" | "delete";
    key?: string;
    data?: any;
  }>,
) => Promise<void>;

export function createBulkPublisher(handlers?: SyncHandler[]) {
  return async (
    channel: string,
    changes: Array<{
      action: "create" | "update" | "delete";
      key?: string;
      data?: any;
    }>,
  ): Promise<void> => {
    const resolvedChannel = String(channel);
    return publishBulkEvent(resolvedChannel, changes);
  };
}

export async function publishEvent(
  channel: string,
  action: "create" | "update" | "delete",
  key: string | undefined,
  data: any,
) {
  const envId = "$app/environment";
  let isDev = false;
  try {
    const env = await import(/* @vite-ignore */ envId);
    isDev = env.dev;
  } catch {}

  if (!isDev) {
    const globalObj = typeof globalThis !== "undefined" ? globalThis : {};
    const processEnv = (globalObj as any).process?.env;
    if (
      processEnv?.NODE_ENV === "development" ||
      processEnv?.NODE_ENV === "test" ||
      (globalObj as any).__sync_dev_broker__
    ) {
      isDev = true;
    }
  }

  if (isDev) {
    const { broadcastExternalChange } = await import("./dev-engine.js");
    await broadcastExternalChange(channel, action, key, data);
    return;
  }

  try {
    const serverId = "$app/server";
    const { getRequestEvent } = await import(/* @vite-ignore */ serverId);
    const { platform } = getRequestEvent();
    const namespace = platform?.env.SYNC_ENGINE;
    if (!namespace) return;

    const id = namespace.idFromName("global");
    const stub = namespace.get(id);
    await stub.fetch("https://realtime.internal/broadcast", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ channel, action, key, data }),
    });
  } catch (err) {
    console.error("Failed to publish sync event to Durable Object:", err);
  }
}

export async function publishBulkEvent(
  channel: string,
  changes: Array<{
    action: "create" | "update" | "delete";
    key?: string;
    data?: any;
  }>,
) {
  const envId = "$app/environment";
  let isDev = false;
  try {
    const env = await import(/* @vite-ignore */ envId);
    isDev = env.dev;
  } catch {}

  if (!isDev) {
    const globalObj = typeof globalThis !== "undefined" ? globalThis : {};
    const processEnv = (globalObj as any).process?.env;
    if (
      processEnv?.NODE_ENV === "development" ||
      processEnv?.NODE_ENV === "test" ||
      (globalObj as any).__sync_dev_broker__
    ) {
      isDev = true;
    }
  }

  if (isDev) {
    const { broadcastExternalBatchChange } = await import("./dev-engine.js");
    await broadcastExternalBatchChange(channel, changes);
    return;
  }

  try {
    const serverId = "$app/server";
    const { getRequestEvent } = await import(/* @vite-ignore */ serverId);
    const { platform } = getRequestEvent();
    const namespace = platform?.env.SYNC_ENGINE;
    if (!namespace) return;

    const id = namespace.idFromName("global");
    const stub = namespace.get(id);
    await stub.fetch("https://realtime.internal/broadcast-batch", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ channel, changes }),
    });
  } catch (err) {
    console.error("Failed to publish bulk sync event to Durable Object:", err);
  }
}

export async function handleUpgrade(
  request: Request,
  platform: App.Platform | undefined,
): Promise<Response> {
  if (request.headers.get("Upgrade") !== "websocket") {
    return new Response("Expected Upgrade: websocket", { status: 426 });
  }

  const namespace = (platform as any)?.env?.SYNC_ENGINE;
  if (!namespace) {
    return new Response("SyncEngine binding is not available", { status: 500 });
  }

  try {
    const id = namespace.idFromName("global");
    const stub = namespace.get(id);
    return await stub.fetch(
      new Request("https://realtime.internal/websocket", request),
    );
  } catch (err: any) {
    return new Response(err.message || "SyncEngine binding is not available", {
      status: 503,
    });
  }
}
