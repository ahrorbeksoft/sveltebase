import type { ZodSchema } from "zod";

export { SerializableError } from "../errors.js";
export type {
  SerializableErrorConstructor,
  SyncErrorInput,
  SyncErrorPayload,
} from "../errors.js";

/**
 * Auth data attached to a live sync connection after the websocket auth step.
 *
 * `user` is whatever your `auth` resolver returned. `identity` is usually the
 * user id. `topics` are used for live row-payload routing.
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
  topics: string[];
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
  topics: Set<string>;
};

/**
 * Resolves the broadcast topics attached to one websocket connection.
 *
 * Row broadcasts are delivered only when a connection topic intersects the
 * changed row's `broadcastTopics`. Keep topics coarse and derived from the
 * authenticated user's current visibility graph.
 */
export type ResolveTopics<TAuth = unknown> = (
  ctx: SyncContext<TAuth>,
) => Promise<string[]> | string[];

/**
 * Server-side behavior for one sync channel.
 *
 * `fetch` is called when a client subscribes or resyncs. `create`, `update`,
 * and `delete` are called for client-side Dexie writes. `authorize` runs before
 * subscribing and before every mutation; throw to reject the operation.
 *
 * Row broadcasts are an optimization, not the authorization boundary. `fetch`
 * must return only the rows the current connection may hold locally.
 *
 * @example
 * ```ts
 * defineSync({
 *   channel: "todos",
 *   authorize: async ({ auth }) => {
 *     if (!auth) throw new Error("Login required");
 *   },
 *   fetch: async ({ auth }, since) => db.todos.list(auth!.identity, since),
 *   broadcastTopics: (_ctx, _action, todo) => [`user:${todo.userId}`]
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
   * `since` is sent by the client when it has a local `updatedAt` value in UTC
   * milliseconds, so handlers can return only changed rows for delta sync.
   */
  fetch: (ctx: SyncContext<TAuth>, since?: number) => Promise<TRow[]>;
  /**
   * Handles a client-created row after optional validation.
   *
   * The returned row is acknowledged to the sender and broadcast to matching
   * subscribers when `broadcastTopics` allows it.
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
   * Controls whether row payloads are broadcast after writes.
   *
   * Defaults to `"scoped"`, which requires `broadcastTopics`. Use `"public"`
   * only for channels where every subscriber may receive every row payload.
   * Use `"none"` for channels that should only update through resync/reset.
   */
  broadcast?: "public" | "scoped" | "none";
  /**
   * Tags describing which connection topics may receive this row change.
   *
   * Called after local mutations and external publish events. Return `"all"`
   * only for public row payloads. Missing topics default to no delivery.
   * Prefer deriving tags from row columns; do not use this as authorization.
   */
  broadcastTopics?: (
    ctx: SyncContext<TAuth>,
    action: "create" | "update" | "delete",
    data: TRow,
  ) => Promise<string[] | "all"> | string[] | "all";
  /**
   * Current version of this connection's visible view for the channel.
   *
   * When the client sends a stale `viewVersion`, the broker ignores `since` and
   * returns a full snapshot so local rows that are no longer visible are removed.
   */
  viewVersion?: (
    ctx: SyncContext<TAuth>,
  ) => Promise<string | number | null | undefined> | string | number | null | undefined;
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
  definePolicySync,
} from "./policy.js";
export type {
  PolicyContextFn,
  PolicyMutations,
  PolicyRules,
  PolicySyncOptions,
} from "./policy.js";

export {
  createBulkPublisher,
  createPublishChangeEvent,
  createPublishResetEvent,
  createPublisher,
  INTERNAL_AUTH_HEADER,
  publishBulkEvent,
  publishChangeEvent,
  publishEvent,
  publishResetEvent,
} from "./handler.js";
export type {
  BulkPublishFn,
  PublishChangeEventFn,
  PublishBulkEventFn,
  PublishEventData,
  PublishEventFn,
  PublishFn,
  PublishResetEventFn,
  SyncAuthResult,
} from "./handler.js";
