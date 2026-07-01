import type { ZodSchema } from "zod";

/**
 * Auth data attached to a live sync connection after the websocket auth step.
 *
 * `user` is whatever your `auth` resolver returned. `identity` is the stable
 * string used by `scope` filtering, usually the user id.
 *
 * @example
 * ```ts
 * ctx.auth?.user.email
 * ctx.auth?.identity
 * ```
 */
export type SyncConnectionAuth<TUser = unknown> = {
  user: TUser;
  identity: string | null;
};

/**
 * Runtime platform data passed into sync handlers.
 *
 * In Cloudflare Workers, `env` contains bindings such as databases and Durable
 * Object namespaces. In dev, this may be an empty object or a wrangler platform
 * proxy.
 */
export type SyncPlatform<
  TEnv extends Record<string, unknown> = Record<string, unknown>,
> = {
  env: TEnv;
  ctx?: ExecutionContext;
  context?: ExecutionContext;
  caches?: CacheStorage;
  cf?: IncomingRequestCfProperties;
};

/**
 * Per-request context passed to every sync handler callback.
 *
 * `auth` is available for websocket subscribe/mutate messages after the worker
 * auth resolver succeeds. External publish events use `auth: null` because they
 * come from server code, not from one connected client.
 */
export type SyncContext<
  TAuth = any,
  TEnv extends Record<string, unknown> = Record<string, unknown>,
> = {
  platform: SyncPlatform<TEnv>;
  request: Request;
  auth: SyncConnectionAuth<TAuth> | null;
  identity: string | null;
};

/**
 * Server-side behavior for one sync channel.
 *
 * `fetch` is called when a client subscribes or resyncs. `create`, `update`,
 * and `delete` are called for client-side Dexie writes. `authorize` runs before
 * subscribing and before every mutation; throw to reject the operation.
 *
 * `scope` controls who receives broadcast changes. Return `"all"` to notify
 * every subscriber on the channel, or return identity strings to notify only
 * matching connections.
 *
 * @example
 * ```ts
 * defineSync({
 *   channel: "todos",
 *   authorize: async ({ auth }) => {
 *     if (!auth) throw new Error("Login required");
 *   },
 *   fetch: async ({ auth }, since) => db.todos.list(auth!.identity, since),
 *   scope: (_ctx, _action, todo) => [todo.userId]
 * });
 * ```
 */
export type SyncHandlerConfig<TRow = any, TAuth = any> = {
  /**
   * Channel name clients subscribe to, or a resolver for auth-specific channels.
   *
   * A string channel like `"todos"` maps directly to client table config. A
   * function can produce channels such as `user:${ctx.identity}`.
   */
  channel: string | ((ctx: SyncContext<TAuth>) => string);
  /**
   * Returns rows for a subscription snapshot.
   *
   * `since` is sent by the client when it has a local `updatedAt` value, so
   * handlers can return only changed rows for delta sync.
   */
  fetch: (ctx: SyncContext<TAuth>, since?: string) => Promise<TRow[]>;
  /**
   * Handles a client-created row after optional validation.
   *
   * The returned row is acknowledged to the sender and broadcast to other
   * scoped subscribers.
   */
  create?: (ctx: SyncContext<TAuth>, data: TRow) => Promise<TRow>;
  /**
   * Handles a client update for an existing key after optional validation.
   *
   * Return the canonical row that should replace local IndexedDB copies.
   */
  update?: (
    ctx: SyncContext<TAuth>,
    key: string,
    changes: Partial<TRow>,
  ) => Promise<TRow>;
  /**
   * Handles a client delete for an existing key.
   *
   * Return nothing; the broker broadcasts the deleted key to subscribers.
   */
  delete?: (ctx: SyncContext<TAuth>, key: string) => Promise<void>;
  /**
   * Guards subscribe and mutation access for this channel.
   *
   * It is called before `fetch`, `create`, `update`, and `delete`. Throw an
   * error to reject the current operation.
   */
  authorize?: (ctx: SyncContext<TAuth>) => Promise<void>;
  /**
   * Optional Zod schemas for client mutation payloads.
   *
   * Parsed values replace the incoming payload before your handler is called.
   */
  validate?: {
    create?: ZodSchema<any>;
    update?: ZodSchema<any>;
  };
  /**
   * Determines which identities receive a broadcast change.
   *
   * Called after local mutations and external publish events. Return `"all"` for
   * every subscriber, `[]` for nobody, or user identity strings for targeted
   * delivery.
   */
  scope?: (
    ctx: SyncContext<TAuth>,
    action: "create" | "update" | "delete",
    data: TRow,
  ) => Promise<string[] | "all"> | string[] | "all";
};

/**
 * Compiled sync handler consumed by the broker.
 *
 * Use `defineSync` instead of constructing this shape manually so channel
 * resolution stays consistent.
 */
export interface SyncHandler<TRow = any, TAuth = any> {
  config: SyncHandlerConfig<TRow, TAuth>;
  /**
   * Resolves the configured channel for the current connection context.
   */
  resolveChannel(ctx: SyncContext<TAuth>): string;
}

/**
 * Defines one server sync channel.
 *
 * Call this in your server handlers module and pass the resulting handlers into
 * the Cloudflare worker, SvelteKit route, or Vite dev plugin.
 *
 * @example
 * ```ts
 * export const handlers = [
 *   defineSync({
 *     channel: "todos",
 *     fetch: async () => db.todos.findMany()
 *   })
 * ];
 * ```
 */
export function defineSync<TRow = any, TAuth = any>(
  config: SyncHandlerConfig<TRow, TAuth>,
): SyncHandler<TRow, TAuth> {
  return {
    config,
    resolveChannel(ctx: SyncContext<TAuth>): string {
      return typeof config.channel === "function"
        ? config.channel(ctx)
        : config.channel;
    },
  };
}

export {
  createBulkPublisher,
  createPublishChangeEvent,
  createPublisher,
  INTERNAL_AUTH_HEADER,
  publishBulkEvent,
  publishChangeEvent,
  publishEvent,
} from "./handler.js";
export type {
  BulkPublishFn,
  PublishChangeEventFn,
  PublishBulkEventFn,
  PublishEventData,
  PublishEventFn,
  PublishFn,
  SyncAuthResult,
} from "./handler.js";
