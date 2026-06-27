import type { SyncHandler, SyncPlatform } from "./index.js";

export type SyncAuthResult<TAuth> = TAuth | null | undefined;

export const INTERNAL_AUTH_HEADER = "x-sveltebase-sync-auth";

export type PublishEventData<
  TRecord,
  TAction extends "create" | "update" | "delete",
> = TAction extends "create"
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

export type SyncPublisherOptions = {
  binding?: string;
  fallbackUrl?: string;
  durableObjectBinding?: string;
  platform?: SyncPlatform;
};

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

function getEnv(options: SyncPublisherOptions) {
  return options.platform?.env;
}

function normalizeEndpoint(baseUrl: string, pathname: string) {
  return new URL(pathname, baseUrl).toString();
}

async function publishToDurableObject(
  platform: SyncPlatform,
  durableObjectBinding: string,
  pathname: "/broadcast" | "/broadcast-batch",
  body: unknown,
) {
  const namespace = platform.env[durableObjectBinding] as
    | DurableObjectNamespace
    | undefined;
  if (!namespace) {
    throw new Error(`Missing ${durableObjectBinding} Durable Object binding`);
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

async function publishToServiceBinding(
  binding: Fetcher,
  pathname: "/broadcast" | "/broadcast-batch",
  body: unknown,
) {
  const response = await binding.fetch(`https://sync.internal${pathname}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });

  if (!response.ok) {
    throw new Error(await response.text());
  }
}

async function publishToFallbackUrl(
  fallbackUrl: string,
  pathname: "/broadcast" | "/broadcast-batch",
  body: unknown,
) {
  const response = await fetch(normalizeEndpoint(fallbackUrl, pathname), {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });

  if (!response.ok) {
    throw new Error(await response.text());
  }
}

async function publish(
  options: SyncPublisherOptions,
  pathname: "/broadcast" | "/broadcast-batch",
  body: unknown,
) {
  const env = getEnv(options);
  const durableObjectBinding = options.durableObjectBinding ?? "SYNC_ENGINE";
  const bindingName = options.binding ?? "SYNC_WORKER";

  if (options.platform && env?.[durableObjectBinding]) {
    await publishToDurableObject(
      options.platform,
      durableObjectBinding,
      pathname,
      body,
    );
    return;
  }

  const serviceBinding = env?.[bindingName] as Fetcher | undefined;
  if (serviceBinding?.fetch) {
    await publishToServiceBinding(serviceBinding, pathname, body);
    return;
  }

  if (options.fallbackUrl) {
    await publishToFallbackUrl(options.fallbackUrl, pathname, body);
    return;
  }

  throw new Error(
    `Missing sync publisher target: provide platform.env.${durableObjectBinding}, platform.env.${bindingName}, or fallbackUrl`,
  );
}

export function createPublisher<TSchema extends Record<string, unknown>>(
  options: SyncPublisherOptions,
): PublishFn<TSchema>;

export function createPublisher<THandlers extends SyncHandler[]>(
  options: SyncPublisherOptions,
  handlers: THandlers,
): PublishFn<InferSchemaFromHandlers<THandlers>>;

export function createPublisher(
  options: SyncPublisherOptions,
  handlers?: SyncHandler[],
) {
  void handlers;
  return async (
    channel: string,
    action: "create" | "update" | "delete",
    key: string | undefined,
    data: any,
  ): Promise<void> => {
    await publish(options, "/broadcast", {
      channel: String(channel),
      action,
      key,
      data,
    });
  };
}

export function createBulkPublisher<TSchema extends Record<string, unknown>>(
  options: SyncPublisherOptions,
): BulkPublishFn<TSchema>;

export function createBulkPublisher<THandlers extends SyncHandler[]>(
  options: SyncPublisherOptions,
  handlers: THandlers,
): BulkPublishFn<InferSchemaFromHandlers<THandlers>>;

export function createBulkPublisher(
  options: SyncPublisherOptions,
  handlers?: SyncHandler[],
) {
  void handlers;
  return async (
    channel: string,
    changes: Array<{
      action: "create" | "update" | "delete";
      key?: string;
      data?: any;
    }>,
  ): Promise<void> => {
    await publish(options, "/broadcast-batch", {
      channel: String(channel),
      changes,
    });
  };
}
