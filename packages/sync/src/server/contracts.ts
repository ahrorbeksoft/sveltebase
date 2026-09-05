import type { SyncChange } from '../protocol.js';

export type SyncConnectionAuth<TUser = unknown, TClaims = unknown> = {
  subject: string;
  user: TUser;
  claims?: TClaims;
  topics: string[];
  expiresAt?: number;
};
export type SyncAuthResult<TAuth> =
  | { subject: string; user: TAuth; claims?: unknown; expiresAt?: number }
  | null
  | undefined;
export type SyncPlatform<
  TEnv extends Record<string, unknown> = Record<string, unknown>,
> = {
  env: TEnv;
  context?: { waitUntil(promise: Promise<unknown>): void };
  metadata?: unknown;
};
export type SyncMetricName =
  | 'query'
  | 'rows-read'
  | 'write'
  | 'transaction-attempt'
  | 'broker-read'
  | 'broker-write'
  | 'retry'
  | 'replay-hit'
  | 'snapshot-row'
  | 'reset'
  | 'publish';
export type SyncMetric = {
  name: SyncMetricName;
  count: number;
  operation: 'subscribe' | 'mutation' | 'publish' | 'connection';
  channel?: string;
  reason?: string;
};
export type SyncMetrics = (metric: SyncMetric) => void;
export type SyncContext<
  TAuth = unknown,
  TEnv extends Record<string, unknown> = Record<string, unknown>,
> = {
  platform: SyncPlatform<TEnv>;
  request: Request;
  auth: SyncConnectionAuth<TAuth> | null;
  subject: string | null;
  topics: Set<string>;
  cache: Map<unknown, unknown>;
  transaction?: unknown;
  metrics?: SyncMetrics;
};
export type ResolveTopics<TAuth = unknown> = (
  ctx: SyncContext<TAuth>,
) => Promise<Iterable<string>> | Iterable<string>;
export type SyncServerRouteOptions<TAuth = unknown> = {
  handlers: SyncHandler[];
  syncEngineBinding?: string;
  websocketPath?: string;
  auth?: (
    request: Request,
    platform: SyncPlatform,
  ) => Promise<SyncAuthResult<TAuth>> | SyncAuthResult<TAuth>;
  topics?: ResolveTopics<TAuth>;
  allowUnauthenticated?: boolean;
  trustedOrigins?:
    | readonly string[]
    | ((origin: string, request: Request) => boolean | Promise<boolean>);
  shard?:
    | string
    | ((input: {
        request: Request;
        auth: SyncAuthResult<TAuth>;
      }) => string | Promise<string>);
  metrics?: SyncMetrics;
};
export type RuntimeSchema<T = unknown> = { parse(input: unknown): T };
export type SnapshotRequest = {
  cursor?: number;
  forceFull: boolean;
  limit: number;
  viewVersion: string | null;
};
export type SnapshotResult<TRow> = {
  mode: 'full' | 'delta';
  rows: TRow[];
  events?: SyncChange[];
  cursor: number;
  hasMore?: boolean;
  viewVersion?: string | number | null;
};
export type MutationRequest = {
  id: string;
  subject: string;
  channel: string;
  action: 'create' | 'update' | 'delete';
  key?: string;
  data?: unknown;
};
export type MutationOutcome<TRow = unknown> = {
  data?: TRow;
  change: SyncChange;
  cursor: number;
  revision: number;
  routingRow?: TRow;
};
export type AtomicIdempotencyResult<T> = { replayed: boolean; outcome: T };
export type AtomicIdempotencyAdapter<
  TAuth = unknown,
  TTransaction = unknown,
> = {
  execute<T>(
    ctx: SyncContext<TAuth>,
    key: { subject: string; channel: string; mutationId: string },
    perform: (transaction: TTransaction) => Promise<T>,
  ): Promise<AtomicIdempotencyResult<T>>;
};
export type SyncHandlerConfig<TRow = unknown, TAuth = unknown> = {
  channel: string | ((ctx: SyncContext<TAuth>) => string);
  matchChannel?: (channel: string) => boolean;
  snapshot: (
    ctx: SyncContext<TAuth>,
    request: SnapshotRequest,
  ) => Promise<SnapshotResult<TRow>>;
  mutate?: (
    ctx: SyncContext<TAuth>,
    mutation: MutationRequest,
  ) => Promise<MutationOutcome<TRow>>;
  idempotency?: AtomicIdempotencyAdapter<TAuth>;
  authorize?: (
    ctx: SyncContext<TAuth>,
    operation: 'subscribe' | 'mutate',
  ) => Promise<void> | void;
  validate?: { create?: RuntimeSchema; update?: RuntimeSchema };
  broadcast?: 'public' | 'scoped' | 'none';
  broadcastTopics?(
    ctx: SyncContext<TAuth>,
    change: SyncChange,
    routingRow?: TRow,
  ): Promise<Iterable<string> | 'all'> | Iterable<string> | 'all';
  snapshotLimit?: number;
};
export interface SyncHandler<TRow = unknown, TAuth = unknown> {
  config: SyncHandlerConfig<TRow, TAuth>;
  resolveChannel(ctx: SyncContext<TAuth>): string;
}
