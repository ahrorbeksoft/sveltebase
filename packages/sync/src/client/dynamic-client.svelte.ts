import type { SyncClientOptions, SyncClient as SyncClientType } from "./index.js";

export type MaybeGetter<T> = T | (() => T);
export type SyncConnectionStatus = "connecting" | "connected" | "disconnected";

/**
 * Context value or getter for a dynamic sync client.
 *
 * Return `null` or `undefined` from a getter to tear down / skip creating the
 * inner client until all required inputs are ready.
 */
export type DynamicSyncContextInput<TContext> =
  | TContext
  | null
  | undefined
  | (() => TContext | null | undefined);

export type DynamicSyncClientOptions<TContext> = {
  /**
   * Initial context used to create the first inner `SyncClient`.
   * Omit this (or pass a getter that returns null/undefined) to wait until
   * `setContext` provides a real value.
   */
  context?: DynamicSyncContextInput<TContext>;
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
  /** True while mutations or snapshot fetches are in flight. */
  readonly isSyncing: boolean;
  readonly pendingMutationCount: number;
  readonly pendingFetchCount: number;
  setContext(
    context: DynamicSyncContextInput<TContext>,
  ): SyncClientType<TSchema> | undefined;
  setData(
    data: DynamicSyncContextInput<TContext>,
  ): SyncClientType<TSchema> | undefined;
  reconnect(options?: { force?: boolean }): void;
  whenConnected(options?: {
    timeoutMs?: number;
    reconnectIfDisconnected?: boolean;
  }): Promise<void>;
  whenIdle(options?: { timeoutMs?: number }): Promise<void>;
  resyncTables(
    tableNames: Array<keyof TSchema & string>,
    options?: { reconnect?: boolean; wait?: boolean },
  ): Promise<Record<string, any[]>>;
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
      this.setContext(options!.context as DynamicSyncContextInput<TContext>);
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

  get isSyncing(): boolean {
    return this.#client?.isSyncing ?? false;
  }

  get pendingMutationCount(): number {
    return this.#client?.pendingMutationCount ?? 0;
  }

  get pendingFetchCount(): number {
    return this.#client?.pendingFetchCount ?? 0;
  }

  setContext(
    context: DynamicSyncContextInput<TContext>,
  ): SyncClientType<TSchema> | undefined {
    this.#effectCleanup?.();
    this.#effectCleanup = undefined;

    if (typeof context !== "function") {
      this.#applyContext(context);
      return this.#client;
    }

    const getter = context as () => TContext | null | undefined;

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

  setData(
    data: DynamicSyncContextInput<TContext>,
  ): SyncClientType<TSchema> | undefined {
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

  reconnect(options?: { force?: boolean }): void {
    this.requireClient().reconnect(options);
  }

  whenConnected(options?: {
    timeoutMs?: number;
    reconnectIfDisconnected?: boolean;
  }): Promise<void> {
    return this.requireClient().whenConnected(options);
  }

  whenIdle(options?: { timeoutMs?: number }): Promise<void> {
    return this.requireClient().whenIdle(options);
  }

  resyncTables(
    tableNames: Array<keyof TSchema & string>,
    options?: { reconnect?: boolean; wait?: boolean },
  ): Promise<Record<string, any[]>> {
    return this.requireClient().resyncTables(tableNames, options);
  }

  disconnect(): void {
    this.#effectCleanup?.();
    this.#effectCleanup = undefined;
    this.#teardownClient();
  }

  requireClient(): SyncClientType<TSchema> {
    if (!this.#client) {
      throw new Error("Sync client context has not been set. Call sync.setContext(...) first.");
    }
    return this.#client;
  }

  #teardownClient() {
    const previousClient = this.#client;
    this.#client = undefined;
    this.#context = undefined;
    this.#hasContext = false;
    // Disconnect first so the old socket cannot race auto-reconnect after close().
    previousClient?.disconnect();
    try {
      previousClient?.close();
    } catch {
      // Dexie may already be closed.
    }
  }

  /**
   * Applies resolved context. `null` / `undefined` means "not ready yet":
   * tear down any existing client and wait.
   */
  #applyContext(next: TContext | null | undefined) {
    if (next == null) {
      if (!this.#hasContext && !this.#client) return;
      this.#teardownClient();
      return;
    }

    if (this.#hasContext && this.#equals(this.#context as TContext, next)) {
      return;
    }

    this.#context = next;
    this.#hasContext = true;

    // Tear down the previous client *before* opening the next one.
    // Otherwise two SyncClients share the same name/URL briefly and both log
    // "WebSocket connected", then fight over IndexedDB.
    const previousClient = this.#client;
    if (previousClient) {
      previousClient.disconnect();
      try {
        previousClient.close();
      } catch {
        // ignore
      }
      this.#client = undefined;
    }

    const nextClient = new this.#SyncClient<TSchema>(this.#factory(next));
    this.#client = nextClient;

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

  // Public surface as a plain object — never proxy the controller itself.
  // Proxying a class with private fields (#client, etc.) breaks when
  // Reflect.get(..., receiver) rebinds getters so `this` is the proxy:
  // "Cannot read private member #client from an object whose class did not declare it".
  const facade = {
    isDynamicSyncClient: true as const,
    get client() {
      return controller.client;
    },
    get context() {
      return controller.context;
    },
    get status() {
      return controller.status;
    },
    get isSyncing() {
      return controller.isSyncing;
    },
    get pendingMutationCount() {
      return controller.pendingMutationCount;
    },
    get pendingFetchCount() {
      return controller.pendingFetchCount;
    },
    setContext: (context: DynamicSyncContextInput<TContext>) =>
      controller.setContext(context),
    setData: (data: DynamicSyncContextInput<TContext>) => controller.setData(data),
    onClientChange: (
      callback: (client: SyncClientType<TSchema>, context: TContext) => void,
    ) => controller.onClientChange(callback),
    reconnect: (options?: { force?: boolean }) => controller.reconnect(options),
    whenConnected: (options?: {
      timeoutMs?: number;
      reconnectIfDisconnected?: boolean;
    }) => controller.whenConnected(options),
    whenIdle: (options?: { timeoutMs?: number }) => controller.whenIdle(options),
    resyncTables: (
      tableNames: Array<keyof TSchema & string>,
      options?: { reconnect?: boolean; wait?: boolean },
    ) => controller.resyncTables(tableNames, options),
    disconnect: () => controller.disconnect(),
  };

  return new Proxy(facade, {
    get(target, property, receiver) {
      if (property in target) {
        return Reflect.get(target, property, receiver);
      }

      const client = controller.requireClient() as any;
      // Route store names through table() — that's the decorated Dexie Table
      // instance. db[name] is a separate undecorated instance in Dexie.
      if (typeof property === "string" && isDexieTableName(client, property)) {
        return client.table(property);
      }

      const value = client[property as keyof typeof client];
      return typeof value === "function" ? value.bind(client) : value;
    },
    set(target, property, value, receiver) {
      if (property in target) {
        return Reflect.set(target, property, value, receiver);
      }

      const client = controller.requireClient() as any;
      client[property as keyof typeof client] = value;
      return true;
    },
    has(target, property) {
      return (
        property in target ||
        (controller.client ? property in controller.client : false)
      );
    },
    ownKeys(target) {
      const client = controller.client as any;
      return client
        ? [...new Set([...Reflect.ownKeys(target), ...Reflect.ownKeys(client)])]
        : Reflect.ownKeys(target);
    },
    getOwnPropertyDescriptor(target, property) {
      return (
        Reflect.getOwnPropertyDescriptor(target, property) ??
        Reflect.getOwnPropertyDescriptor(controller.client ?? {}, property)
      );
    },
  }) as unknown as DynamicSyncClient<TSchema, TContext>;
}

function isDexieTableName(client: any, name: string): boolean {
  const allTables = client?._allTables;
  if (allTables && Object.prototype.hasOwnProperty.call(allTables, name)) {
    return true;
  }
  const storeNames = client?._storeNames;
  return Array.isArray(storeNames) && storeNames.includes(name);
}
