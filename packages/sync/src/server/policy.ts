import type { SyncContext, SyncHandler, SyncHandlerConfig } from "./index.js";

/**
 * App-built context for a policy-backed channel.
 *
 * Build this once per operation so rules and mutators share DB handles, roles,
 * and other request-scoped data without re-fetching.
 */
export type PolicyContextFn<TAuth, TApp> = (
  ctx: SyncContext<TAuth>,
) => Promise<TApp> | TApp;

/**
 * Row-visibility and mutation rules for `definePolicySync`.
 *
 * - `list` is async-capable and may return rows or a filter helper outcome.
 * - `create` / `update` / `delete` return `true` to allow, `false` to deny.
 * - `update` and `delete` always receive the trusted server row (`original`).
 */
export type PolicyRules<TApp, TRow, TInsert = TRow, TChanges = Partial<TRow>> = {
  list: (app: TApp, since?: number) => Promise<TRow[]> | TRow[];
  create?: (
    app: TApp,
    data: TInsert,
  ) => boolean | Promise<boolean>;
  update?: (
    app: TApp,
    original: TRow,
    changes: TChanges,
  ) => boolean | Promise<boolean>;
  delete?: (
    app: TApp,
    original: TRow,
  ) => boolean | Promise<boolean>;
};

/**
 * App-owned DB mutators. Policy only decides allow/deny; you still write rows.
 */
export type PolicyMutations<TApp, TRow, TInsert = TRow, TChanges = Partial<TRow>> = {
  create?: (app: TApp, data: TInsert) => Promise<TRow>;
  /** Load the trusted original row for update/delete. */
  load: (app: TApp, id: string) => Promise<TRow | null | undefined>;
  update?: (app: TApp, id: string, changes: TChanges, original: TRow) => Promise<TRow>;
  delete?: (app: TApp, id: string, original: TRow) => Promise<void>;
};

export type PolicySyncOptions<
  TRow,
  TAuth,
  TApp,
  TInsert = TRow,
  TChanges = Partial<TRow>,
> = {
  channel: SyncHandlerConfig<TRow, TAuth>["channel"];
  context: PolicyContextFn<TAuth, TApp>;
  rules: PolicyRules<TApp, TRow, TInsert, TChanges>;
  mutations: PolicyMutations<TApp, TRow, TInsert, TChanges>;
  authorize?: SyncHandlerConfig<TRow, TAuth>["authorize"];
  validate?: SyncHandlerConfig<TRow, TAuth>["validate"];
  broadcast?: SyncHandlerConfig<TRow, TAuth>["broadcast"];
  broadcastTopics?: SyncHandlerConfig<TRow, TAuth>["broadcastTopics"];
  viewVersion?: SyncHandlerConfig<TRow, TAuth>["viewVersion"];
  /**
   * Error factory when a rule denies the operation.
   * @default throws Error("Forbidden")
   */
  forbidden?: (reason?: string) => never;
  /**
   * Error factory when the original row is missing.
   * @default throws Error("Not found")
   */
  notFound?: () => never;
};

function defaultForbidden(reason = "Forbidden"): never {
  throw new Error(reason);
}

function defaultNotFound(): never {
  throw new Error("Not found");
}

/**
 * Higher-level `defineSync` wrapper with standardized authorization flow.
 *
 * The package owns: build context once, list via rules, load original before
 * update/delete, apply rules, then call app mutators. Domain rules stay in the
 * app via `context` / `rules` / `mutations`.
 *
 * @example
 * ```ts
 * definePolicySync({
 *   channel: "todos",
 *   context: (ctx) => getApp(ctx),
 *   rules: {
 *     list: (app, since) => app.db.listTodos(app.userId, since),
 *     create: (app, data) => data.userId === app.userId,
 *     update: (app, original) => original.userId === app.userId,
 *     delete: (app, original) => original.userId === app.userId,
 *   },
 *   mutations: {
 *     load: (app, id) => app.db.getTodo(id),
 *     create: (app, data) => app.db.insertTodo(data),
 *     update: (app, id, changes) => app.db.updateTodo(id, changes),
 *     delete: (app, id) => app.db.deleteTodo(id),
 *   },
 * });
 * ```
 */
export function definePolicySync<
  TRow = any,
  TAuth = any,
  TApp = any,
  TInsert = TRow,
  TChanges = Partial<TRow>,
>(
  options: PolicySyncOptions<TRow, TAuth, TApp, TInsert, TChanges>,
): SyncHandler<TRow, TAuth> {
  const forbidden = options.forbidden ?? defaultForbidden;
  const notFound = options.notFound ?? defaultNotFound;

  const config: SyncHandlerConfig<TRow, TAuth> = {
    channel: options.channel,
    authorize: options.authorize,
    validate: options.validate,
    broadcast: options.broadcast,
    broadcastTopics: options.broadcastTopics,
    viewVersion: options.viewVersion,
    fetch: async (ctx, since) => {
      const app = await options.context(ctx);
      return options.rules.list(app, since);
    },
    create: options.mutations.create
      ? async (ctx, data) => {
          const app = await options.context(ctx);
          const allowed = options.rules.create
            ? await options.rules.create(app, data as unknown as TInsert)
            : false;
          if (!allowed) forbidden();
          return options.mutations.create!(app, data as unknown as TInsert);
        }
      : undefined,
    update: options.mutations.update
      ? async (ctx, id, changes) => {
          const app = await options.context(ctx);
          const original = await options.mutations.load(app, id);
          if (original == null) notFound();
          const row = original as TRow;
          const allowed = options.rules.update
            ? await options.rules.update(
                app,
                row,
                changes as unknown as TChanges,
              )
            : false;
          if (!allowed) forbidden();
          return options.mutations.update!(
            app,
            id,
            changes as unknown as TChanges,
            row,
          );
        }
      : undefined,
    delete: options.mutations.delete
      ? async (ctx, id) => {
          const app = await options.context(ctx);
          const original = await options.mutations.load(app, id);
          if (original == null) notFound();
          const row = original as TRow;
          const allowed = options.rules.delete
            ? await options.rules.delete(app, row)
            : false;
          if (!allowed) forbidden();
          await options.mutations.delete!(app, id, row);
        }
      : undefined,
  };

  return {
    config,
    resolveChannel(ctx: SyncContext<TAuth>): string {
      return typeof config.channel === "function"
        ? config.channel(ctx)
        : config.channel;
    },
  };
}
