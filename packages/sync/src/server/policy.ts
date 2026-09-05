import type {
  AtomicIdempotencyAdapter,
  MutationOutcome,
  SnapshotRequest,
  SnapshotResult,
  SyncContext,
  SyncHandler,
  SyncHandlerConfig,
} from './index.js';

export type PolicyContextFn<TAuth, TApp> = (
  ctx: SyncContext<TAuth>,
) => Promise<TApp> | TApp;
export type PolicyRules<
  TApp,
  TRow,
  TInsert = TRow,
  TChanges = Partial<TRow>,
> = {
  list: (
    app: TApp,
    request: SnapshotRequest,
  ) => Promise<SnapshotResult<TRow>> | SnapshotResult<TRow>;
  create?: (app: TApp, data: TInsert) => boolean | Promise<boolean>;
  update?: (
    app: TApp,
    original: TRow,
    changes: TChanges,
  ) => boolean | Promise<boolean>;
  delete?: (app: TApp, original: TRow) => boolean | Promise<boolean>;
};
export type PolicyMutations<
  TApp,
  TRow,
  TInsert = TRow,
  TChanges = Partial<TRow>,
> = {
  load: (app: TApp, id: string) => Promise<TRow | null | undefined>;
  create?: (app: TApp, data: TInsert) => Promise<MutationOutcome<TRow>>;
  update?: (
    app: TApp,
    id: string,
    changes: TChanges,
    original: TRow,
  ) => Promise<MutationOutcome<TRow>>;
  delete?: (
    app: TApp,
    id: string,
    original: TRow,
  ) => Promise<MutationOutcome<TRow>>;
};
export type PolicySyncOptions<
  TRow,
  TAuth,
  TApp,
  TInsert = TRow,
  TChanges = Partial<TRow>,
> = {
  channel: SyncHandlerConfig<TRow, TAuth>['channel'];
  matchChannel?: SyncHandlerConfig<TRow, TAuth>['matchChannel'];
  context: PolicyContextFn<TAuth, TApp>;
  rules: PolicyRules<TApp, TRow, TInsert, TChanges>;
  mutations: PolicyMutations<TApp, TRow, TInsert, TChanges>;
  idempotency: AtomicIdempotencyAdapter<TAuth>;
  authorize?: SyncHandlerConfig<TRow, TAuth>['authorize'];
  validate?: SyncHandlerConfig<TRow, TAuth>['validate'];
  broadcast?: SyncHandlerConfig<TRow, TAuth>['broadcast'];
  broadcastTopics?: SyncHandlerConfig<TRow, TAuth>['broadcastTopics'];
  snapshotLimit?: number;
  forbidden?: () => never;
  notFound?: () => never;
};

export function definePolicySync<
  TRow = unknown,
  TAuth = unknown,
  TApp = unknown,
  TInsert = TRow,
  TChanges = Partial<TRow>,
>(
  options: PolicySyncOptions<TRow, TAuth, TApp, TInsert, TChanges>,
): SyncHandler<TRow, TAuth> {
  const contextKey = options.context;
  const app = async (ctx: SyncContext<TAuth>) => {
    let value = ctx.cache.get(contextKey) as Promise<TApp> | undefined;
    if (!value) {
      value = Promise.resolve().then(() => options.context(ctx));
      ctx.cache.set(contextKey, value);
    }
    return value;
  };
  const forbidden =
    options.forbidden ??
    (() => {
      throw new Error('Forbidden');
    });
  const notFound =
    options.notFound ??
    (() => {
      throw new Error('Not found');
    });
  const config: SyncHandlerConfig<TRow, TAuth> = {
    channel: options.channel,
    matchChannel: options.matchChannel,
    idempotency: options.idempotency,
    authorize: options.authorize,
    validate: options.validate,
    broadcast: options.broadcast,
    broadcastTopics: options.broadcastTopics,
    snapshotLimit: options.snapshotLimit,
    snapshot: async (ctx, request) =>
      options.rules.list(await app(ctx), request),
    mutate: async (ctx, mutation) => {
      const value = await app(ctx);
      if (mutation.action === 'create') {
        const create = options.mutations.create;
        const rule = options.rules.create;
        if (!create || !rule || !(await rule(value, mutation.data as TInsert)))
          return forbidden();
        return create(value, mutation.data as TInsert);
      }
      const original = await options.mutations.load(value, mutation.key!);
      if (original == null) notFound();
      const trusted = original as TRow;
      if (mutation.action === 'update') {
        const update = options.mutations.update;
        const rule = options.rules.update;
        if (
          !update ||
          !rule ||
          !(await rule(value, trusted, mutation.data as TChanges))
        )
          return forbidden();
        return update(value, mutation.key!, mutation.data as TChanges, trusted);
      }
      const remove = options.mutations.delete;
      const rule = options.rules.delete;
      if (!remove || !rule || !(await rule(value, trusted))) return forbidden();
      const outcome = await remove(value, mutation.key!, trusted);
      return { ...outcome, routingRow: outcome.routingRow ?? trusted };
    },
  };
  return {
    config,
    resolveChannel(ctx) {
      return typeof config.channel === 'function'
        ? config.channel(ctx)
        : config.channel;
    },
  };
}
