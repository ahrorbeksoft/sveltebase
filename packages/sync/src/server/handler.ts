import type { SyncPlatform } from "./index.js";

/**
 * Auth object returned by a sync websocket auth resolver.
 *
 * Return `null` or `undefined` for unauthenticated requests. If
 * `allowUnauthenticated` is false, that will reject the websocket.
 */
export type SyncAuthResult<TAuth> = TAuth | null | undefined;

/**
 * Internal header used to forward trusted auth data to the Durable Object.
 *
 * Public request handlers delete this header before processing user requests so
 * clients cannot spoof auth.
 */
export const INTERNAL_AUTH_HEADER = "x-sveltebase-sync-auth";

/**
 * Payload type expected by `publishEvent` for each mutation action.
 */
export type PublishEventData<
  TRecord,
  TAction extends "create" | "update" | "delete",
> = TAction extends "create"
  ? TRecord
  : TAction extends "update"
    ? Partial<TRecord>
    : Partial<TRecord> | undefined;

/**
 * Type-safe function for publishing one server-side row change.
 *
 * `channel` may include a suffix such as `"todos:team-1"` when the server
 * handler uses prefix fallback or dynamic channel names.
 */
export type PublishFn<TSchema extends Record<string, unknown>> = <
  TChannel extends keyof TSchema & string,
  TAction extends "create" | "update" | "delete",
>(
  channel: TChannel | `${TChannel}:${string}`,
  action: TAction,
  key: string | undefined,
  data: PublishEventData<TSchema[TChannel], TAction>,
) => Promise<void>;

/**
 * Type-safe function for publishing multiple row changes for one channel.
 */
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

/** Alias kept for older imports. */
export type PublishEventFn<TSchema extends Record<string, unknown>> =
  PublishFn<TSchema>;

/** Alias kept for older imports. */
export type PublishBulkEventFn<TSchema extends Record<string, unknown>> =
  BulkPublishFn<TSchema>;

/**
 * Function for notifying clients that a channel should be resynced.
 *
 * Use this when server code knows something changed but does not have
 * row-level payloads.
 */
export type PublishChangeEventFn<TSchema extends Record<string, unknown>> = <
  TChannel extends keyof TSchema & string,
>(
  channel: TChannel | `${TChannel}:${string}`,
) => Promise<void>;

const GLOBAL_PLATFORM_KEY = "__sveltebase_sync_platform__";
const DEFAULT_SYNC_ENGINE_BINDING = "SYNC_ENGINE";

type PublisherRuntime = {
  platform: SyncPlatform;
  syncEngineBinding: string;
};

/**
 * Checks whether the Vite dev broker has been installed on `globalThis`.
 */
function hasDevBroker() {
  const globalObject = globalThis as unknown as Record<string, unknown>;
  return Boolean(globalObject.__sveltebase_sync_dev_broker__);
}

/**
 * Stores the production publish target for later `publishEvent` calls.
 *
 * Runtime adapters call this before handling requests so application code can
 * publish to the configured Durable Object without passing `env` each time.
 */
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

/**
 * Reads the publish runtime registered by the current adapter.
 */
function getPublisherRuntime() {
  const globalObject = globalThis as unknown as Record<
    string,
    PublisherRuntime | undefined
  >;
  return globalObject[GLOBAL_PLATFORM_KEY];
}

/**
 * Sends a publish payload to the configured Durable Object instance.
 */
async function publishToDurableObject(
  platform: SyncPlatform,
  syncEngineBinding: string,
  pathname: "/broadcast" | "/broadcast-batch" | "/broadcast-change",
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

/**
 * Sends a publish payload to the in-memory Vite dev broker.
 */
async function publishToDevBroker(
  pathname: "/broadcast" | "/broadcast-batch" | "/broadcast-change",
  body: any,
) {
  const devEngine = await import("./dev-engine.js");

  if (pathname === "/broadcast-change") {
    await devEngine.broadcastChannelChange(String(body.channel));
    return;
  }

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

/**
 * Dispatches a publish payload to production Durable Object or dev broker.
 */
async function publish(
  pathname: "/broadcast" | "/broadcast-batch" | "/broadcast-change",
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

/**
 * Creates a typed publisher for single row changes.
 *
 * @example
 * ```ts
 * const publish = createPublisher<{ todos: Todo }>();
 * await publish("todos", "update", todo.id, { title: todo.title });
 * ```
 */
export function createPublisher<
  TSchema extends Record<string, unknown>,
>(): PublishFn<TSchema>;

export function createPublisher() {
  return publishEvent;
}

/**
 * Publishes one server-side row change to connected sync clients.
 *
 * This does not write to your database. Call it after your own server code has
 * already created, updated, or deleted the row.
 */
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

/**
 * Creates a typed publisher for batch row changes.
 */
export function createBulkPublisher<
  TSchema extends Record<string, unknown>,
>(): BulkPublishFn<TSchema>;

export function createBulkPublisher() {
  return publishBulkEvent;
}

/**
 * Publishes multiple server-side row changes for one channel.
 *
 * If the server handler defines `scope`, each change is scoped independently by
 * the broker before it is sent.
 */
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

/**
 * Creates a typed publisher that asks clients to resync a channel.
 */
export function createPublishChangeEvent<
  TSchema extends Record<string, unknown>,
>(): PublishChangeEventFn<TSchema>;

export function createPublishChangeEvent() {
  return publishChangeEvent;
}

/**
 * Notifies connected clients that a channel changed and should be resynced.
 *
 * Use this when publishing row-level payloads would be expensive or impossible.
 */
export async function publishChangeEvent<
  TSchema extends Record<string, unknown>,
  TChannel extends keyof TSchema & string,
>(channel: TChannel | `${TChannel}:${string}`): Promise<void>;

export async function publishChangeEvent(channel: string): Promise<void> {
  await publish("/broadcast-change", {
    channel: String(channel),
  });
}
