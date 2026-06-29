import type { SyncPlatform } from "./index.js";

export type SyncAuthResult<TAuth> = TAuth | null | undefined;

export const INTERNAL_AUTH_HEADER = "x-sveltebase-sync-auth";

export type PublishEventData<
  TRecord,
  TAction extends "create" | "update" | "delete",
> = TAction extends "create"
  ? TRecord
  : TAction extends "update"
    ? Partial<TRecord>
    : Partial<TRecord> | undefined;

export type PublishFn<TSchema extends Record<string, unknown>> = <
  TChannel extends keyof TSchema & string,
  TAction extends "create" | "update" | "delete",
>(
  channel: TChannel | `${TChannel}:${string}`,
  action: TAction,
  key: string | undefined,
  data: PublishEventData<TSchema[TChannel], TAction>,
) => Promise<void>;

export type BulkPublishFn<TSchema extends Record<string, unknown>> = <
  TChannel extends keyof TSchema & string,
>(
  channel: TChannel | `${TChannel}:${string}`,
  changes: Array<{
    action: "create" | "update" | "delete";
    key?: string;
    data?: any;
  }>,
) => Promise<void>;

export type PublishEventFn<TSchema extends Record<string, unknown>> =
  PublishFn<TSchema>;

export type PublishBulkEventFn<TSchema extends Record<string, unknown>> =
  BulkPublishFn<TSchema>;

const GLOBAL_PLATFORM_KEY = "__sveltebase_sync_platform__";
const DEFAULT_SYNC_ENGINE_BINDING = "SYNC_ENGINE";

type PublisherRuntime = {
  platform: SyncPlatform;
  syncEngineBinding: string;
};

function hasDevBroker() {
  const globalObject = globalThis as unknown as Record<string, unknown>;
  return Boolean(globalObject.__sveltebase_sync_dev_broker__);
}

export function configurePublisherPlatform(
  platform: SyncPlatform,
  syncEngineBinding = DEFAULT_SYNC_ENGINE_BINDING,
) {
  const globalObject = globalThis as unknown as Record<
    string,
    PublisherRuntime | undefined
  >;
  globalObject[GLOBAL_PLATFORM_KEY] = { platform, syncEngineBinding };
}

function getPublisherRuntime() {
  const globalObject = globalThis as unknown as Record<
    string,
    PublisherRuntime | undefined
  >;
  return globalObject[GLOBAL_PLATFORM_KEY];
}

async function publishToDurableObject(
  platform: SyncPlatform,
  syncEngineBinding: string,
  pathname: "/broadcast" | "/broadcast-batch",
  body: unknown,
) {
  const namespace = platform.env[syncEngineBinding] as
    | DurableObjectNamespace
    | undefined;
  if (!namespace) {
    throw new Error(
      `Missing ${syncEngineBinding} Durable Object binding`,
    );
  }

  const id = namespace.idFromName("global");
  const stub = namespace.get(id);
  const response = await stub.fetch(`https://sync.internal${pathname}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });

  if (!response.ok) {
    throw new Error(await response.text());
  }
}

async function publishToDevBroker(
  pathname: "/broadcast" | "/broadcast-batch",
  body: any,
) {
  const devEngine = await import("./dev-engine.js");

  if (pathname === "/broadcast-batch") {
    await devEngine.broadcastExternalBatchChange(
      String(body.channel),
      Array.isArray(body.changes) ? body.changes : [],
    );
    return;
  }

  await devEngine.broadcastExternalChange(
    String(body.channel),
    body.action,
    body.key,
    body.data,
  );
}

async function publish(
  pathname: "/broadcast" | "/broadcast-batch",
  body: unknown,
) {
  const runtime = getPublisherRuntime();

  if (runtime?.platform.env[runtime.syncEngineBinding]) {
    await publishToDurableObject(
      runtime.platform,
      runtime.syncEngineBinding,
      pathname,
      body,
    );
    return;
  }

  if (hasDevBroker()) {
    await publishToDevBroker(pathname, body);
    return;
  }

  throw new Error(
    "Missing sync publisher target: use createSyncAppWorker() in production or syncDevPlugin() in Vite dev",
  );
}

export function createPublisher<
  TSchema extends Record<string, unknown>,
>(): PublishFn<TSchema>;

export function createPublisher() {
  return publishEvent;
}

export async function publishEvent<
  TSchema extends Record<string, unknown>,
  TChannel extends keyof TSchema & string,
  TAction extends "create" | "update" | "delete",
>(
  channel: TChannel | `${TChannel}:${string}`,
  action: TAction,
  key: string | undefined,
  data: PublishEventData<TSchema[TChannel], TAction>,
): Promise<void>;

export async function publishEvent(
    channel: string,
    action: "create" | "update" | "delete",
    key: string | undefined,
    data: any,
): Promise<void> {
  await publish("/broadcast", {
    channel: String(channel),
    action,
    key,
    data,
  });
}

export function createBulkPublisher<
  TSchema extends Record<string, unknown>,
>(): BulkPublishFn<TSchema>;

export function createBulkPublisher() {
  return publishBulkEvent;
}

export async function publishBulkEvent<
  TSchema extends Record<string, unknown>,
  TChannel extends keyof TSchema & string,
>(
  channel: TChannel | `${TChannel}:${string}`,
  changes: Array<{
    action: "create" | "update" | "delete";
    key?: string;
    data?: any;
  }>,
): Promise<void>;

export async function publishBulkEvent(
    channel: string,
    changes: Array<{
      action: "create" | "update" | "delete";
      key?: string;
      data?: any;
    }>,
): Promise<void> {
  await publish("/broadcast-batch", {
    channel: String(channel),
    changes,
  });
}
