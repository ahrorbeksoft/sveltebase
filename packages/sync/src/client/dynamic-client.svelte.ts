import type {
  SyncClientOptions,
  SyncClient as SyncClientType,
} from './index.js';
import type { SyncConnectionStatus } from './status.svelte.js';
import { SvelteSet } from 'svelte/reactivity';

export type MaybeGetter<T> = T | (() => T);
export type DynamicSyncContextInput<T> =
  T | null | undefined | (() => T | null | undefined);
export type DynamicSyncClientOptions<TContext> = {
  context?: DynamicSyncContextInput<TContext>;
  /** Stable explicit key; equal keys do not rebuild a client. */
  contextKey?: (context: TContext) => string;
};
export type DynamicSyncClient<
  TSchema extends Record<string, unknown> = Record<string, unknown>,
  TContext = unknown,
> = {
  readonly isDynamicSyncClient: true;
  readonly client: SyncClientType<TSchema> | undefined;
  readonly context: TContext | undefined;
  readonly status: SyncConnectionStatus;
  readonly isSyncing: boolean;
  readonly pendingMutationCount: number;
  readonly pendingFetchCount: number;
  setContext(
    context: DynamicSyncContextInput<TContext>,
  ): SyncClientType<TSchema> | undefined;
  onClientChange(
    callback: (
      client: SyncClientType<TSchema> | undefined,
      context: TContext | undefined,
    ) => void,
  ): () => void;
  stop(): void;
  dispose(): void;
};

type ClientFactory<TSchema extends Record<string, unknown>, TContext> = (
  context: TContext,
) => SyncClientOptions<TSchema>;
type SyncClientConstructor = new <
  TSchema extends Record<string, unknown> = Record<string, unknown>,
>(
  options: SyncClientOptions<TSchema>,
) => SyncClientType<TSchema>;

export function createDynamicSyncClient<
  TSchema extends Record<string, unknown> = Record<string, unknown>,
  TContext = unknown,
>(
  Constructor: SyncClientConstructor,
  factory: ClientFactory<TSchema, TContext>,
  options?: DynamicSyncClientOptions<TContext>,
): DynamicSyncClient<TSchema, TContext> {
  let client = $state<SyncClientType<TSchema> | undefined>();
  let context = $state<TContext | undefined>();
  let key: string | undefined;
  let effectDispose: (() => void) | undefined;
  const listeners = new SvelteSet<
    (
      client: SyncClientType<TSchema> | undefined,
      context: TContext | undefined,
    ) => void
  >();
  const contextKey =
    options?.contextKey ??
    ((value: TContext) => {
      if (typeof value !== 'string')
        throw new Error(
          'Dynamic sync context requires contextKey unless context is a string',
        );
      return value;
    });

  const notify = () => {
    for (const listener of listeners) listener(client, context);
  };
  const teardown = () => {
    const old = client;
    client = undefined;
    context = undefined;
    key = undefined;
    old?.dispose();
    if (old) notify();
  };
  const apply = (next: TContext | null | undefined) => {
    if (next == null) {
      teardown();
      return;
    }
    const nextKey = contextKey(next);
    if (client && key === nextKey) {
      context = next;
      return;
    }
    teardown();
    context = next;
    key = nextKey;
    client = new Constructor<TSchema>(factory(next));
    notify();
  };
  const setContext = (input: DynamicSyncContextInput<TContext>) => {
    effectDispose?.();
    effectDispose = undefined;
    if (typeof input !== 'function') apply(input);
    else {
      const getter = input as () => TContext | null | undefined;
      try {
        effectDispose = $effect.root(() => {
          $effect(() => apply(getter()));
        });
      } catch {
        apply(getter());
      }
    }
    return client;
  };

  if ('context' in (options ?? {})) setContext(options!.context);
  return {
    isDynamicSyncClient: true,
    get client() {
      return client;
    },
    get context() {
      return context;
    },
    get status() {
      return client?.status ?? 'stopped';
    },
    get isSyncing() {
      return client?.isSyncing ?? false;
    },
    get pendingMutationCount() {
      return client?.pendingMutationCount ?? 0;
    },
    get pendingFetchCount() {
      return client?.pendingFetchCount ?? 0;
    },
    setContext,
    onClientChange(callback) {
      listeners.add(callback);
      return () => listeners.delete(callback);
    },
    stop() {
      client?.stop();
    },
    dispose() {
      effectDispose?.();
      effectDispose = undefined;
      teardown();
      listeners.clear();
    },
  };
}
