import type {
  SyncContext,
  SyncHandler,
  SyncHandlerConfig,
} from './contracts.js';

export function defineSync<TRow = unknown, TAuth = unknown>(
  config: SyncHandlerConfig<TRow, TAuth>,
): SyncHandler<TRow, TAuth> {
  if (
    typeof config.channel === 'string' &&
    (!config.channel || config.channel.length > 256)
  )
    throw new Error('Invalid sync channel');
  if (typeof config.channel === 'function' && !config.matchChannel)
    throw new Error('Dynamic sync channels require matchChannel');
  if (config.mutate && !config.idempotency)
    throw new Error('Mutation handlers require an atomic idempotency adapter');
  const limit = config.snapshotLimit ?? 1_000;
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 10_000)
    throw new Error('snapshotLimit must be between 1 and 10000');
  return {
    config,
    resolveChannel(ctx: SyncContext<TAuth>) {
      return typeof config.channel === 'function'
        ? config.channel(ctx)
        : config.channel;
    },
  };
}
