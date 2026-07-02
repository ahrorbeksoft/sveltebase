import type { SyncClientOptions, SyncClient as SyncClientType } from "./index.js";

export type MaybeGetter<T> = T | (() => T);
export type SyncConnectionStatus = "connecting" | "connected" | "disconnected";

export type DynamicSyncClientOptions<TContext> = {
  /**
   * Initial context used to create the first inner `SyncClient`.
   */
  context?: MaybeGetter<TContext>;
  /**
   * Custom equality check for deciding whether a context update should rebuild
   * the inner client. Defaults to stable structural comparison.
   */
  equals?: (previous: TContext, next: TContext) => boolean;
};

export type DynamicSyncClient<
  TSchema extends Record<string, any> = Record<string, any>,
  TContext = unknown,
> = SyncClientType<TSchema> & {
  readonly isDynamicSyncClient: true;
  readonly client: SyncClientType<TSchema> | undefined;
  readonly context: TContext | undefined;
  readonly status: SyncConnectionStatus;
  setContext(context: MaybeGetter<TContext>): SyncClientType<TSchema> | undefined;
  setData(data: MaybeGetter<TContext>): SyncClientType<TSchema> | undefined;
  reconnect(): void;
  disconnect(): void;
  onClientChange(
    callback: (client: SyncClientType<TSchema>, context: TContext) => void,
  ): () => void;
};

type ClientFactory<
  TSchema extends Record<string, any>,
  TContext,
> = (context: TContext) => SyncClientOptions<TSchema>;

type SyncClientConstructor = new <
  TSchema extends Record<string, any> = Record<string, any>,
>(options: SyncClientOptions<TSchema>) => SyncClientType<TSchema>;

function stableSerialize(value: unknown, seen = new WeakSet<object>()): string {
  if (value instanceof Date) return JSON.stringify(value.toISOString());
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (seen.has(value)) return JSON.stringify("[Circular]");

  seen.add(value);

  if (Array.isArray(value)) {
    return `[${value.map((item) => stableSerialize(item, seen)).join(",")}]`;
  }

  const entries = Object.keys(value as Record<string, unknown>)
    .sort()
    .map((key) => {
      const serialized = stableSerialize((value as Record<string, unknown>)[key], seen);
      return `${JSON.stringify(key)}:${serialized}`;
    });

  return `{${entries.join(",")}}`;
}

function defaultEquals<T>(previous: T, next: T): boolean {
  if (Object.is(previous, next)) return true;

  try {
    return stableSerialize(previous) === stableSerialize(next);
  } catch {
    return false;
  }
}

class DynamicSyncClientController<
  TSchema extends Record<string, any>,
  TContext,
> {
  readonly isDynamicSyncClient = true;

  #factory: ClientFactory<TSchema, TContext>;
  #SyncClient: SyncClientConstructor;
  #equals: (previous: TContext, next: TContext) => boolean;
  #client = $state<SyncClientType<TSchema> | undefined>(undefined);
  #context = $state<TContext | undefined>(undefined);
  #hasContext = false;
  #effectCleanup: (() => void) | undefined;
  #listeners = new Set<(client: SyncClientType<TSchema>, context: TContext) => void>();

  constructor(
    SyncClientConstructor: SyncClientConstructor,
    factory: ClientFactory<TSchema, TContext>,
    options?: DynamicSyncClientOptions<TContext>,
  ) {
    this.#SyncClient = SyncClientConstructor;
    this.#factory = factory;
    this.#equals = options?.equals ?? defaultEquals;

    if ("context" in (options ?? {})) {
      this.setContext(options!.context as MaybeGetter<TContext>);
    }
  }

  get client(): SyncClientType<TSchema> | undefined {
    return this.#client;
  }

  get context(): TContext | undefined {
    return this.#context;
  }

  get status(): SyncConnectionStatus {
    return this.#client?.status ?? "disconnected";
  }

  setContext(context: MaybeGetter<TContext>): SyncClientType<TSchema> | undefined {
    this.#effectCleanup?.();
    this.#effectCleanup = undefined;

    if (typeof context !== "function") {
      this.#applyContext(context);
      return this.#client;
    }

    const getter = context as () => TContext;

    try {
      this.#effectCleanup = $effect.root(() => {
        $effect(() => {
          this.#applyContext(getter());
        });
      });
    } catch {
      this.#applyContext(getter());
    }

    return this.#client;
  }

  setData(data: MaybeGetter<TContext>): SyncClientType<TSchema> | undefined {
    return this.setContext(data);
  }

  onClientChange(
    callback: (client: SyncClientType<TSchema>, context: TContext) => void,
  ): () => void {
    this.#listeners.add(callback);
    return () => {
      this.#listeners.delete(callback);
    };
  }

  reconnect(): void {
    this.requireClient().reconnect();
  }

  disconnect(): void {
    this.#effectCleanup?.();
    this.#effectCleanup = undefined;
    this.#client?.disconnect();
    this.#client?.close();
    this.#client = undefined;
    this.#context = undefined;
    this.#hasContext = false;
  }

  requireClient(): SyncClientType<TSchema> {
    if (!this.#client) {
      throw new Error("Sync client context has not been set. Call sync.setContext(...) first.");
    }
    return this.#client;
  }

  #applyContext(next: TContext) {
    if (this.#hasContext && this.#equals(this.#context as TContext, next)) {
      return;
    }

    this.#context = next;
    this.#hasContext = true;

    const previousClient = this.#client;
    const nextClient = new this.#SyncClient<TSchema>(this.#factory(next));
    this.#client = nextClient;

    previousClient?.disconnect();
    previousClient?.close();

    for (const listener of this.#listeners) {
      listener(nextClient, next);
    }
  }
}

/**
 * Creates a sync client whose options are derived from reactive context.
 *
 * Call `sync.setContext(...)` or `sync.setData(...)` with a value or Svelte
 * getter. When the resolved context changes structurally, the wrapper rebuilds
 * the inner `SyncClient`, which reconnects with the new table/channel config.
 *
 * @example
 * ```ts
 * const sync = createSyncClient<AppDatabaseSchema, { orgId: string }>((data) => ({
 *   name: `app-sync-${data.orgId}`,
 *   url: "/api/sync",
 *   tables: {
 *     todos: { indexes: "id, updatedAt", channel: `org:${data.orgId}:todos` },
 *   },
 * }));
 *
 * sync.setContext(() => ({ orgId: data.org.id }));
 * ```
 */
export function createDynamicSyncClient<
  TSchema extends Record<string, any> = Record<string, any>,
  TContext = unknown,
>(
  SyncClientConstructor: SyncClientConstructor,
  factory: ClientFactory<TSchema, TContext>,
  options?: DynamicSyncClientOptions<TContext>,
): DynamicSyncClient<TSchema, TContext> {
  const controller = new DynamicSyncClientController<TSchema, TContext>(
    SyncClientConstructor,
    factory,
    options,
  );

  return new Proxy(controller, {
    get(target, property, receiver) {
      if (property in target) {
        return Reflect.get(target, property, receiver);
      }

      const client = target.requireClient() as any;
      const value = client[property as keyof typeof client];
      return typeof value === "function" ? value.bind(client) : value;
    },
    set(target, property, value, receiver) {
      if (property in target) {
        return Reflect.set(target, property, value, receiver);
      }

      const client = target.requireClient() as any;
      client[property as keyof typeof client] = value;
      return true;
    },
    has(target, property) {
      return property in target || (target.client ? property in target.client : false);
    },
    ownKeys(target) {
      const client = target.client as any;
      return client
        ? [...new Set([...Reflect.ownKeys(target), ...Reflect.ownKeys(client)])]
        : Reflect.ownKeys(target);
    },
    getOwnPropertyDescriptor(target, property) {
      return Reflect.getOwnPropertyDescriptor(target, property)
        ?? Reflect.getOwnPropertyDescriptor(target.client ?? {}, property);
    },
  }) as unknown as DynamicSyncClient<TSchema, TContext>;
}
