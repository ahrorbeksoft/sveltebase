import Dexie, { type Table } from "dexie";
import {
  createErrorCodec,
  type ErrorCodec,
  type SerializableErrorConstructor,
} from "../errors.js";
import { parseSyncMessage, type SyncMessage } from "../protocol.js";
import { createDynamicSyncClient } from "./dynamic-client.svelte.js";
import type {
  DynamicSyncClient,
  DynamicSyncClientOptions,
} from "./dynamic-client.svelte.js";
import { ConnectionStatus, SyncActivity } from "./status.svelte.js";

export { createLiveQuery } from "./live-query.svelte.js";
export { SerializableError } from "../errors.js";
export type {
  SerializableErrorConstructor,
  SyncErrorInput,
  SyncErrorPayload,
} from "../errors.js";
export type {
  DynamicSyncClient,
  DynamicSyncClientOptions,
  DynamicSyncContextInput,
  MaybeGetter,
} from "./dynamic-client.svelte.js";
export type { LiveQueryState } from "./live-query.svelte.js";

const SYNC_META_TABLE = "__sync_meta";
/** Durable queue of mutations not yet acked by the server. */
const SYNC_OUTBOX_TABLE = "__sync_outbox";

/**
 * Local IndexedDB table configuration for one synced table.
 *
 * `indexes` is the Dexie schema string. `channel` must match a server
 * `defineSync({ channel })` value. `updatedAtField` enables delta snapshots by
 * telling the client which timestamp to send as `since`.
 */
export type TableConfig = {
  indexes: string;
  channel: string;
  updatedAtField?: string;
};

/**
 * Options for creating a sync client database.
 */
export type SyncClientOptions<
  TSchema extends Record<string, any> = Record<string, any>,
> = {
  /** Dexie database name stored in the browser. */
  name: string;
  /**
   * Websocket URL or async URL resolver.
   *
   * Relative paths such as `"/api/sync"` are resolved against the current
   * browser host and protocol.
   */
  url: string | (() => string | Promise<string>);
  /** Dexie tables that should be kept in sync with server channels. */
  tables: Record<keyof TSchema & string, TableConfig>;
  /** Error classes to restore from rejected server mutations. */
  errorClasses?: readonly SerializableErrorConstructor[];
};

type PendingMutation = {
  id: string;
  channel: string;
  action: "create" | "update" | "delete";
  key: string;
  data?: any;
  /** Previous row for update/delete rollback after reload. */
  previous?: any;
  rollback: () => Promise<void>;
  resolve: (value: any) => void;
  reject: (reason: any) => void;
};

type PendingSnapshot = {
  resolve: (rows: any[]) => void;
  reject: (reason: any) => void;
};

/** Serialized mutation stored in IndexedDB so refresh/crash does not drop it. */
type OutboxEntry = {
  id: string;
  channel: string;
  action: "create" | "update" | "delete";
  key: string;
  data?: any;
  previous?: any;
  createdAt: number;
};

class SyncClientClass<
  TSchema extends Record<string, any> = Record<string, any>,
> extends Dexie {
  private wsUrl: string | (() => string | Promise<string>);
  private socket: WebSocket | undefined;
  private tableConfigs: Record<string, TableConfig>;
  private errorCodec: ErrorCodec;
  private reconnectTimer: ReturnType<typeof setTimeout> | undefined;
  private pingInterval: ReturnType<typeof setInterval> | undefined;
  private closedByClient = false;
  private activeChannels = new Set<string>();
  private changeTimers = new Map<string, ReturnType<typeof setTimeout>>();

  // Reactive connection status delegated to status.svelte.ts
  private _statusState = new ConnectionStatus();
  // Reactive upload/download activity for UI "syncing" indicators
  private _activity = new SyncActivity();

  // Mutations waiting for ack/reject from server
  private pendingMutations = new Map<string, PendingMutation>();
  private pendingSnapshots = new Map<string, PendingSnapshot[]>();
  /** Channels with an outstanding subscribe → snapshot round-trip. */
  private pendingFetchChannels = new Set<string>();
  // Mutations queued to be sent when connection is established
  private mutationQueue: Array<{
    id: string;
    channel: string;
    action: "create" | "update" | "delete";
    key: string;
    data?: any;
  }> = [];

  /**
   * Creates the local Dexie database and starts the websocket connection in the browser.
   *
   * The constructor also decorates configured tables so normal Dexie writes
   * become optimistic sync mutations.
   */
  constructor(options: SyncClientOptions<TSchema>) {
    super(options.name);
    this.wsUrl = options.url;
    this.tableConfigs = options.tables;
    this.errorCodec = createErrorCodec(options.errorClasses);

    // Initialize Dexie database
    const schema: Record<string, string> = {};
    for (const [tableName, config] of Object.entries(options.tables)) {
      schema[tableName] = config.indexes;
    }
    schema[SYNC_META_TABLE] = "key";

    // v1: app tables + meta (existing installs)
    this.version(1).stores({ ...schema });
    // v2: durable mutation outbox (survives refresh before server ack)
    this.version(2).stores({
      ...schema,
      [SYNC_OUTBOX_TABLE]: "id, channel, createdAt",
    });

    // Decorate tables to intercept native Dexie write operations.
    // Re-run on ready in case Dexie rebuilt Table objects during open.
    this.decorateTables();
    this.on("ready", () => {
      this.decorateTables();
    });

    if (typeof window !== "undefined") {
      this.connect();
    }
  }

  /**
   * Current reactive websocket status.
   *
   * Useful in Svelte components for showing offline/connecting state.
   */
  public get status() {
    return this._statusState.value;
  }

  /**
   * True while mutations are waiting for ack (or queued offline) **or**
   * channels are waiting for a snapshot fetch.
   *
   * Use for a global "syncing" indicator — it can flash briefly for fast ops.
   */
  public get isSyncing() {
    return this._activity.isSyncing;
  }

  /** Count of mutations not yet acked (includes offline queue). */
  public get pendingMutationCount() {
    return this._activity.pendingMutations;
  }

  /** Count of channels waiting on a snapshot response. */
  public get pendingFetchCount() {
    return this._activity.pendingFetches;
  }

  private refreshActivity() {
    // pendingMutations already tracks offline writes; mutationQueue is only
    // the outbound buffer for those same ids.
    this._activity.setCounts(
      this.pendingMutations.size,
      this.pendingFetchChannels.size,
    );
  }

  private markFetchPending(channel: string) {
    this.pendingFetchChannels.add(channel);
    this.refreshActivity();
  }

  private clearFetchPending(channel: string) {
    if (this.pendingFetchChannels.delete(channel)) {
      this.refreshActivity();
    }
  }

  private clearAllFetches() {
    if (this.pendingFetchChannels.size === 0) return;
    this.pendingFetchChannels.clear();
    this.refreshActivity();
  }

  /**
   * Wraps configured Dexie table write methods with sync-aware versions.
   *
   * Local writes resolve immediately (snappy UI). Server `mutate` runs in the
   * background; on `reject` the stored rollback restores the previous row.
   *
   * Dexie installs separate `Table` instances for `db[name]` vs `db.table(name)`.
   * We decorate `_allTables` and expose it via a getter so both access paths
   * hit the intercepted table.
   *
   * Safe to call more than once (idempotent per Table instance).
   */
  private decorateTables() {
    for (const [tableName, config] of Object.entries(this.tableConfigs)) {
      const table = this.table(tableName);
      this.interceptTableWrites(table, config);

      // Always resolve db.courses → db.table("courses") (decorated instance).
      Object.defineProperty(this, tableName, {
        configurable: true,
        enumerable: true,
        get: () => this.table(tableName),
      });
    }
  }

  /**
   * Replaces add/put/update/delete on one Dexie Table with optimistic sync wrappers.
   *
   * Contract: the Promise returned to the caller resolves/rejects with the
   * **local IndexedDB write only**. Server transport is scheduled in a later
   * macrotask (`setTimeout(0)`) *after* that resolve, so it cannot participate
   * in the caller's `await` chain (no waiting for server `ack`).
   */
  private interceptTableWrites(table: Table, config: TableConfig) {
    // Walk to the Dexie Table.prototype that actually owns add/put/… —
    // never use table.add (may already be a sync wrapper from a prior decorate).
    const dexieMethod = (name: "add" | "put" | "update" | "delete" | "get") => {
      let obj: object | null = table;
      while (obj) {
        const desc = Object.getOwnPropertyDescriptor(obj, name);
        if (desc && typeof desc.value === "function" && obj !== table) {
          return (desc.value as Function).bind(table);
        }
        obj = Object.getPrototypeOf(obj);
      }
      // Fallback: current own/prototype method
      return (table as any)[name].bind(table);
    };

    const originalAdd = dexieMethod("add");
    const originalPut = dexieMethod("put");
    const originalUpdate = dexieMethod("update");
    const originalDelete = dexieMethod("delete");
    const originalGet = dexieMethod("get");

    (table as any)._originalMethods = {
      add: originalAdd,
      put: originalPut,
      update: originalUpdate,
      delete: originalDelete,
    };

    const channel = config.channel;

    /**
     * Local write → durable outbox + wire dispatch → resolve caller.
     * Awaits only IDB (row + outbox), never the server ack.
     */
    const localThenSync = <T>(
      localWrite: () => PromiseLike<T>,
      action: "create" | "update" | "delete",
      key: string,
      data: any,
      previous: any | undefined,
      rollback: () => PromiseLike<unknown> | unknown,
    ): Promise<T> => {
      return new Promise<T>((resolve, reject) => {
        Promise.resolve(localWrite()).then(
          async (result) => {
            try {
              // Persist outbox + start wire send (does not wait for server ack).
              await this.dispatchMutation(
                channel,
                action,
                key,
                data,
                async () => {
                  await rollback();
                },
                previous,
              );
            } catch (err) {
              console.warn("SyncClient: failed to dispatch mutation", err);
            }
            resolve(result);
          },
          reject,
        );
      });
    };

    table.add = ((row: any) => {
      const id = row.id || crypto.randomUUID();
      const fullRow = row.id ? row : { ...row, id };
      return localThenSync(
        () => originalAdd(fullRow),
        "create",
        id,
        fullRow,
        undefined,
        () => originalDelete(id),
      ).then(() => id);
    }) as any;

    table.put = ((rowOrId: any, changes?: any) => {
      if (changes !== undefined) {
        const id = rowOrId;
        return Promise.resolve(originalGet(id)).then((existing: any) => {
          if (!existing) {
            throw new Error(`Cannot update item ${id}: not found locally.`);
          }
          return localThenSync(
            () => originalUpdate(id, changes),
            "update",
            id,
            changes,
            existing,
            () => originalPut(existing),
          ).then(() => id);
        });
      }

      const row = rowOrId;
      const id = row?.id;
      if (!id) {
        throw new Error("put operation requires an inline 'id' property.");
      }

      return Promise.resolve(originalGet(id)).then((existing: any) => {
        if (!existing) {
          return table.add(row);
        }
        return localThenSync(
          () => originalPut(row),
          "update",
          id,
          row,
          existing,
          () => originalPut(existing),
        ).then(() => id);
      });
    }) as any;

    table.update = ((id: any, changes: any) => {
      return Promise.resolve(originalGet(id)).then((existing: any) => {
        if (!existing) {
          throw new Error(`Cannot update item ${id}: not found locally.`);
        }
        return localThenSync(
          () => originalUpdate(id, changes),
          "update",
          id,
          changes,
          existing,
          () => originalPut(existing),
        );
      });
    }) as any;

    table.delete = ((id: any) => {
      return Promise.resolve(originalGet(id)).then((existing: any) => {
        if (!existing) return;
        return localThenSync(
          () => originalDelete(id),
          "delete",
          id,
          undefined,
          existing,
          () => originalPut(existing),
        );
      });
    }) as any;

    (table as any)._syncWriteIntercepted = true;
  }

  /**
   * Opens the websocket and installs message/reconnect handlers.
   *
   * Called automatically in the browser constructor and again after disconnects
   * unless `disconnect()` was called by user code.
   */
  private async connect() {
    if (this.closedByClient) return;
    this._statusState.value = "connecting";

    const protocol = window.location.protocol === "https:" ? "wss:" : "ws:";
    const host = window.location.host;

    let resolvedUrl: string;
    try {
      resolvedUrl = typeof this.wsUrl === "function" ? await this.wsUrl() : this.wsUrl;
    } catch (err) {
      console.error("SyncClient: Failed to resolve wsUrl", err);
      this._statusState.value = "disconnected";
      if (!this.closedByClient) {
        this.reconnectTimer = setTimeout(() => this.connect(), 2000);
      }
      return;
    }

    const fullUrl =
      resolvedUrl.startsWith("ws://") || resolvedUrl.startsWith("wss://")
        ? resolvedUrl
        : `${protocol}//${host}${resolvedUrl}`;

    const socket = new WebSocket(fullUrl);
    this.socket = socket;

    socket.addEventListener("open", async () => {
      if (this.socket !== socket) return;

      console.log("SyncClient: WebSocket connected");
      this._statusState.value = "connected";
      this.activeChannels.clear();
      this.startHeartbeat();

      // Re-subscribe to all tables (delta-sync aware)
      for (const config of Object.values(this.tableConfigs)) {
        await this.subscribeToChannel(config.channel, { socket });
      }

      if (this.socket !== socket || socket.readyState !== WebSocket.OPEN) return;

      // Restore durable outbox from a previous session, then send everything.
      await this.hydrateOutbox();
      this.flushPendingMutations(socket);
    });

    socket.addEventListener("message", async (message) => {
      if (this.socket !== socket) return;
      if (typeof message.data !== "string") return;
      if (message.data === "pong") return;

      const msg = parseSyncMessage(message.data);
      if (!msg) return;

      await this.handleServerMessage(msg);
    });

    socket.addEventListener("close", () => {
      if (this.socket === socket) {
        this.socket = undefined;
        this._statusState.value = "disconnected";
        this.clearAllFetches();
        this.stopHeartbeat();
        if (!this.closedByClient) {
          this.reconnectTimer = setTimeout(() => this.connect(), 2000);
        }
      }
    });

    socket.addEventListener("error", (err) => {
      if (this.socket === socket) {
        console.error("SyncClient: WebSocket error", err);
      }
    });
  }

  /**
   * Forces the client to open a fresh websocket connection.
   *
   * Use this after auth changes, for example after login, so the websocket is
   * recreated with the latest cookies.
   */
  public reconnect() {
    this.closedByClient = false;
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = undefined;
    }
    if (this.socket) {
      try {
        this.socket.close();
      } catch {}
      this.socket = undefined;
      this._statusState.value = "disconnected";
    }
    this.connect();
  }

  /**
   * Starts a periodic ping so intermediaries do not close an idle websocket.
   */
  private startHeartbeat() {
    this.stopHeartbeat();
    this.pingInterval = setInterval(() => {
      if (this.socket && this.socket.readyState === WebSocket.OPEN) {
        this.socket.send(JSON.stringify({ type: "ping" }));
      }
    }, 55000); // 55 seconds
  }

  /**
   * Stops the websocket heartbeat timer.
   */
  private stopHeartbeat() {
    if (this.pingInterval) {
      clearInterval(this.pingInterval);
      this.pingInterval = undefined;
    }
  }

  /**
   * Returns the timestamp field used for delta sync on a table.
   */
  private getUpdatedAtField(tableName: string) {
    return this.tableConfigs[tableName]?.updatedAtField ?? "updatedAt";
  }

  /**
   * Reads a comparable timestamp from a row for last-write-wins checks.
   */
  private getUpdatedAtValue(tableName: string, row: any): number | undefined {
    const value = row?.[this.getUpdatedAtField(tableName)];
    if (typeof value === "number" && Number.isFinite(value)) return value;
    if (value instanceof Date) return value.getTime();

    return undefined;
  }

  private async getChannelViewVersion(
    channel: string,
  ): Promise<string | undefined> {
    try {
      const row = await this.table(SYNC_META_TABLE).get(`view:${channel}`);
      return row?.value == null ? undefined : String(row.value);
    } catch {
      return undefined;
    }
  }

  private async setChannelViewVersion(
    channel: string,
    viewVersion: string | null | undefined,
  ) {
    if (viewVersion === undefined) return;

    const table = this.table(SYNC_META_TABLE);
    const originalPut = (table as any)._originalMethods?.put
      || table.put.bind(table);
    await originalPut({ key: `view:${channel}`, value: viewVersion });
  }

  /**
   * Subscribes the websocket to a server channel and requests a snapshot.
   *
   * When possible, sends `since` from the newest local row so the server can
   * return only changed rows. `forceFull` disables that optimization.
   */
  private async subscribeToChannel(
    channel: string,
    options?: { forceFull?: boolean; socket?: WebSocket },
  ) {
    const socket = options?.socket ?? this.socket;
    if (socket && socket === this.socket && socket.readyState === WebSocket.OPEN) {
      const tableName = this.findTableByChannel(channel);
      let since: number | undefined;
      if (tableName && !options?.forceFull) {
        try {
          const table = this.table(tableName);
          const updatedAtField = this.getUpdatedAtField(tableName);
          const latestRow = await table.orderBy(updatedAtField).last();
          if (latestRow) {
            since = this.getUpdatedAtValue(tableName, latestRow);
          }
        } catch {
          // Ignore if query fails or table is empty
        }
      }
      const viewVersion = await this.getChannelViewVersion(channel);
      if (socket !== this.socket || socket.readyState !== WebSocket.OPEN) return;
      this.markFetchPending(channel);
      socket.send(
        JSON.stringify({ type: "subscribe", channel, since, viewVersion }),
      );
      this.activeChannels.add(channel);
    }
  }

  /**
   * Forces a fresh snapshot for the table's configured channel.
   *
   * Useful after login/session verification or when user code needs to wait
   * until local IndexedDB has been refreshed from the server.
   *
   * @param tableName Local Dexie table name from the client schema.
   * @param options.reconnect Reopen the websocket before resyncing.
   * @returns Rows returned by the server snapshot.
   */
  public async resyncTable(
    tableName: keyof TSchema & string,
    options?: { reconnect?: boolean },
  ): Promise<any[]> {
    const config = this.tableConfigs[String(tableName)];
    if (!config) {
      throw new Error(`No sync table configured for ${String(tableName)}`);
    }
    return this.resyncChannel(config.channel, options);
  }

  /**
   * Forces a fresh snapshot for a channel and resolves with the server rows.
   *
   * This sends a full subscribe request and waits for the matching `snapshot`
   * message.
   */
  public async resyncChannel(
    channel: string,
    options?: { reconnect?: boolean },
  ): Promise<any[]> {
    if (
      options?.reconnect ||
      !this.socket ||
      this.socket.readyState === WebSocket.CLOSING ||
      this.socket.readyState === WebSocket.CLOSED
    ) {
      this.reconnect();
    }

    await this.waitForSocket();

    const snapshot = new Promise<any[]>((resolve, reject) => {
      const queue = this.pendingSnapshots.get(channel) ?? [];
      queue.push({ resolve, reject });
      this.pendingSnapshots.set(channel, queue);
    });

    await this.subscribeToChannel(channel, { forceFull: true });
    return snapshot;
  }

  /**
   * Waits until the current websocket is open.
   *
   * The promise rejects after 10 seconds so callers do not hang forever when the
   * sync endpoint is unavailable.
   */
  private waitForSocket(): Promise<void> {
    if (this.socket?.readyState === WebSocket.OPEN) {
      return Promise.resolve();
    }

    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        cleanup();
        reject(new Error("Timed out waiting for sync connection"));
      }, 10000);

      let socket: WebSocket | undefined;
      let poll: ReturnType<typeof setInterval> | undefined;

      const cleanup = () => {
        clearTimeout(timeout);
        if (poll) clearInterval(poll);
        socket?.removeEventListener("open", onOpen);
        socket?.removeEventListener("error", onError);
      };
      const onOpen = () => {
        cleanup();
        resolve();
      };
      const onError = () => {
        cleanup();
        reject(new Error("Failed to connect sync websocket"));
      };

      const attach = () => {
        if (socket === this.socket) return;
        socket?.removeEventListener("open", onOpen);
        socket?.removeEventListener("error", onError);
        socket = this.socket;
        if (!socket) return;
        if (socket.readyState === WebSocket.OPEN) {
          cleanup();
          resolve();
          return;
        }
        socket.addEventListener("open", onOpen, { once: true });
        socket.addEventListener("error", onError, { once: true });
      };

      attach();
      poll = setInterval(attach, 25);
    });
  }

  /**
   * Sends mutations queued while the websocket was closed.
   */
  private flushMutationQueue(socket = this.socket) {
    if (!socket || socket !== this.socket || socket.readyState !== WebSocket.OPEN) return;

    while (this.mutationQueue.length > 0) {
      if (socket !== this.socket || socket.readyState !== WebSocket.OPEN) return;
      const mut = this.mutationQueue.shift()!;
      socket.send(
        JSON.stringify({
          type: "mutate",
          id: mut.id,
          channel: mut.channel,
          action: mut.action,
          key: mut.key,
          data: mut.data,
        }),
      );
    }
  }

  /**
   * Applies a server row without triggering another sync mutation.
   *
   * Uses the table's `updatedAtField` for last-write-wins conflict handling when
   * both local and incoming rows have timestamps.
   */
  private async safePutRow(tableName: string, data: any) {
    const table = this.table(tableName);
    if (!data || !data.id) return;

    const existing = await table.get(data.id);
    const existingUpdatedAt = this.getUpdatedAtValue(tableName, existing);
    const incomingUpdatedAt = this.getUpdatedAtValue(tableName, data);
    if (existingUpdatedAt != null && incomingUpdatedAt != null) {
      if (incomingUpdatedAt < existingUpdatedAt) {
        // Ignore older update (Last-Write-Wins)
        return;
      }
      // Same timestamp as optimistic local write — nothing new to apply.
      if (incomingUpdatedAt === existingUpdatedAt) {
        return;
      }
    }
    const originalPut = (table as any)._originalMethods?.put || table.put.bind(table);
    await originalPut(data);
  }

  /**
   * Applies an ack payload only when the server row is newer than local.
   */
  private async applyAckRow(tableName: string, data: any) {
    try {
      await this.safePutRow(tableName, data);
    } catch (err) {
      console.warn("SyncClient: failed to apply ack row", err);
    }
  }

  /**
   * Applies a server delete without triggering another sync mutation.
   *
   * If the server includes a timestamp, older deletes are ignored so a newer
   * local row is not removed.
   */
  private async safeDeleteRow(
    tableName: string,
    key: string,
    incomingTime?: number,
  ) {
    const table = this.table(tableName);
    if (incomingTime != null) {
      const existing = await table.get(key);
      const existingUpdatedAt = this.getUpdatedAtValue(tableName, existing);
      if (existingUpdatedAt != null) {
        if (incomingTime < existingUpdatedAt) {
          // Ignore older delete
          return;
        }
      }
    }
    const originalDelete = (table as any)._originalMethods?.delete || table.delete.bind(table);
    await originalDelete(key);
  }

  /**
   * Applies one server protocol message to local IndexedDB and pending promises.
   *
   * Snapshots hydrate tables, acknowledgements resolve optimistic writes,
   * rejections roll them back, and change messages update local rows from other
   * clients or external server publishers.
   */
  private async handleServerMessage(msg: SyncMessage) {
    switch (msg.type) {
      case "snapshot": {
        const tableName = this.findTableByChannel(msg.channel);
        if (tableName) {
          const table = this.table(tableName);
          if (msg.isDelta) {
            // Delta Sync: put changes using Last-Write-Wins
            for (const row of msg.data) {
              await this.safePutRow(tableName, row);
            }
          } else {
            // Full Snapshot: clear and replace
            await this.transaction("rw", table, async () => {
              await table.clear();
              for (const row of msg.data) {
                await this.safePutRow(tableName, row);
              }
            });
          }
          await this.setChannelViewVersion(msg.channel, msg.viewVersion);
        }
        this.clearFetchPending(msg.channel);
        const pending = this.pendingSnapshots.get(msg.channel);
        if (pending?.length) {
          this.pendingSnapshots.delete(msg.channel);
          for (const waiter of pending) {
            waiter.resolve(msg.data);
          }
        }
        break;
      }
      case "ack": {
        const pending = this.pendingMutations.get(msg.id);
        if (pending) {
          // Resolve immediately so any rare waiters are not blocked on IDB.
          this.pendingMutations.delete(msg.id);
          this.refreshActivity();
          void this.removeOutboxEntry(msg.id);
          pending.resolve(msg.data);

          // Apply server canonical row off the critical path. Skip when the
          // local row already has the same updatedAt to avoid a second
          // liveQuery storm right after the optimistic write.
          if (msg.data) {
            const tableName = this.findTableByChannel(pending.channel);
            const data = msg.data;
            if (tableName) {
              queueMicrotask(() => {
                void this.applyAckRow(tableName, data);
              });
            }
          }
        } else {
          // Ack for a mutation restored only in outbox / already cleaned up.
          void this.removeOutboxEntry(msg.id);
        }
        break;
      }
      case "reject": {
        if (msg.id === "subscribe") {
          for (const pending of this.pendingSnapshots.values()) {
            for (const waiter of pending) {
              waiter.reject(this.errorCodec.deserialize(msg.error));
            }
          }
          this.pendingSnapshots.clear();
          this.clearAllFetches();
          break;
        }

        const pending = this.pendingMutations.get(msg.id);
        if (pending) {
          console.warn(`Mutation ${msg.id} rejected by server`, msg.error);
          await pending.rollback();
          void this.removeOutboxEntry(msg.id);

          pending.reject(this.errorCodec.deserialize(msg.error));
          this.pendingMutations.delete(msg.id);
          this.refreshActivity();
        } else {
          // Reject after reload: rebuild rollback from durable outbox entry.
          const entry = await this.getOutboxEntry(msg.id);
          if (entry) {
            console.warn(`Mutation ${msg.id} rejected by server`, msg.error);
            await this.rollbackOutboxEntry(entry);
            void this.removeOutboxEntry(msg.id);
            this.refreshActivity();
          }
        }
        break;
      }
      case "change": {
        // Prevent sync loops: if we sent this mutation, ignore the echo change
        if (msg.mutationId && this.pendingMutations.has(msg.mutationId)) {
          break;
        }

        const tableName = this.findTableByChannel(msg.channel);
        if (!tableName) break;

        if (msg.action === "create" || msg.action === "update") {
          await this.safePutRow(tableName, msg.data);
        } else if (msg.action === "delete" && msg.key) {
          const incomingTime = this.getUpdatedAtValue(tableName, msg.data);
          await this.safeDeleteRow(tableName, msg.key, incomingTime);
        }
        break;
      }
      case "batch": {
        const tableName = this.findTableByChannel(msg.channel);
        if (!tableName) break;

        const table = this.table(tableName);
        await this.transaction("rw", table, async () => {
          for (const change of msg.changes) {
            if (change.action === "create" || change.action === "update") {
              await this.safePutRow(tableName, change.data);
            } else if (change.action === "delete" && change.key) {
              const incomingTime = this.getUpdatedAtValue(
                tableName,
                change.data,
              );
              await this.safeDeleteRow(tableName, change.key, incomingTime);
            }
          }
        });
        break;
      }
      case "channel-change": {
        this.scheduleChannelResync(msg.channel);
        break;
      }
      case "channel-reset": {
        this.scheduleChannelResync(msg.channel, { forceFull: true });
        break;
      }
    }
  }

  /**
   * Debounces a `channel-change` notification into a fresh subscribe request.
   *
   * Multiple external change notifications in the same burst result in one
   * resync.
   */
  private scheduleChannelResync(
    channel: string,
    options?: { forceFull?: boolean },
  ) {
    const existing = this.changeTimers.get(channel);
    if (existing) clearTimeout(existing);

    const timer = setTimeout(() => {
      this.changeTimers.delete(channel);
      if (
        !this.socket ||
        this.socket.readyState !== WebSocket.OPEN ||
        !this.activeChannels.has(channel)
      ) {
        return;
      }
      void this.subscribeToChannel(channel, { forceFull: options?.forceFull });
    }, 50);

    this.changeTimers.set(channel, timer);
  }

  /**
   * Finds the local table configured for a server channel.
   */
  private findTableByChannel(channel: string): string | undefined {
    for (const [tableName, config] of Object.entries(this.tableConfigs)) {
      if (config.channel === channel) return tableName;
    }
    return undefined;
  }


  private outboxTable(): Table<OutboxEntry, string> {
    return this.table(SYNC_OUTBOX_TABLE) as Table<OutboxEntry, string>;
  }

  private async saveOutboxEntry(entry: OutboxEntry) {
    const table = this.outboxTable();
    const put = (table as any)._originalMethods?.put || table.put.bind(table);
    await put(entry);
  }

  private async removeOutboxEntry(id: string) {
    try {
      const table = this.outboxTable();
      const del = (table as any)._originalMethods?.delete || table.delete.bind(table);
      await del(id);
    } catch {
      // Outbox table may not exist yet during upgrades.
    }
  }

  private async getOutboxEntry(id: string): Promise<OutboxEntry | undefined> {
    try {
      return await this.outboxTable().get(id);
    } catch {
      return undefined;
    }
  }

  private async rollbackOutboxEntry(entry: OutboxEntry) {
    const tableName = this.findTableByChannel(entry.channel);
    if (!tableName) return;
    const table = this.table(tableName);
    const methods = (table as any)._originalMethods ?? {
      put: table.put.bind(table),
      delete: table.delete.bind(table),
    };
    if (entry.action === "create") {
      await methods.delete(entry.key);
    } else if (entry.previous != null) {
      await methods.put(entry.previous);
    }
  }

  /**
   * Loads durable outbox rows into memory after a refresh/reconnect so they
   * can be re-sent. Local optimistic data is already in the app tables.
   */
  private async hydrateOutbox() {
    let entries: OutboxEntry[] = [];
    try {
      entries = await this.outboxTable().orderBy("createdAt").toArray();
    } catch {
      return;
    }

    for (const entry of entries) {
      if (this.pendingMutations.has(entry.id)) continue;

      this.pendingMutations.set(entry.id, {
        id: entry.id,
        channel: entry.channel,
        action: entry.action,
        key: entry.key,
        data: entry.data,
        previous: entry.previous,
        rollback: async () => {
          await this.rollbackOutboxEntry(entry);
        },
        // No UI waiter after reload.
        resolve: () => {},
        reject: () => {},
      });
    }

    this.refreshActivity();
  }

  /** Sends every in-memory pending mutation over the open socket. */
  private flushPendingMutations(socket = this.socket) {
    if (!socket || socket !== this.socket || socket.readyState !== WebSocket.OPEN) {
      return;
    }

    for (const mut of this.pendingMutations.values()) {
      if (socket !== this.socket || socket.readyState !== WebSocket.OPEN) return;
      socket.send(
        JSON.stringify({
          type: "mutate",
          id: mut.id,
          channel: mut.channel,
          action: mut.action,
          key: mut.key,
          data: mut.data,
        }),
      );
    }
  }

  /**
   * Persists a mutation to the durable outbox, tracks it in memory, and sends
   * it when the socket is open. Resolves after the outbox write — not after ack.
   */
  private async dispatchMutation(
    channel: string,
    action: "create" | "update" | "delete",
    key: string,
    data: any,
    rollback: () => Promise<void>,
    previous?: any,
  ): Promise<void> {
    const mutationId = crypto.randomUUID();

    const entry: OutboxEntry = {
      id: mutationId,
      channel,
      action,
      key,
      data,
      previous,
      createdAt: Date.now(),
    };

    await this.saveOutboxEntry(entry);

    this.pendingMutations.set(mutationId, {
      id: mutationId,
      channel,
      action,
      key,
      data,
      previous,
      rollback,
      resolve: () => {},
      reject: () => {},
    });
    this.refreshActivity();

    // Offline: stays in outbox + pendingMutations until connect re-sends.
    if (this.socket && this.socket.readyState === WebSocket.OPEN) {
      this.socket.send(
        JSON.stringify({
          type: "mutate",
          id: mutationId,
          channel,
          action,
          key,
          data,
        }),
      );
    }
  }

  /**
   * Closes the websocket and disables automatic reconnects.
   *
   * Local IndexedDB data is left intact; call table clear methods or auth logout
   * helpers if you also need to remove cached rows.
   */
  public disconnect() {
    this.closedByClient = true;
    this._statusState.value = "disconnected";
    this.clearAllFetches();
    this.stopHeartbeat();
    for (const timer of this.changeTimers.values()) {
      clearTimeout(timer);
    }
    this.changeTimers.clear();
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = undefined;
    }
    if (this.socket) {
      try {
        this.socket.close();
      } catch {}
      this.socket = undefined;
    }
  }
}

/**
 * Dexie database type returned by `new SyncClient(...)`.
 *
 * Table names from `TSchema` are available as typed Dexie tables while still
 * allowing dynamic table access through Dexie's standard API.
 */
export type SyncClient<TSchema extends Record<string, any> = Record<string, any>> = SyncClientClass<TSchema> & {
  [K in keyof TSchema]: Table<TSchema[K]>;
} & {
  [tableName: string]: Table<any>;
};

/**
 * Creates a sync-enabled Dexie client.
 *
 * @example
 * ```ts
 * const db = new SyncClient<{ todos: Todo }>({
 *   name: "app",
 *   url: "/api/sync",
 *   tables: {
 *     todos: { indexes: "id, updatedAt", channel: "todos" }
 *   }
 * });
 * ```
 */
export const SyncClient: new <
  TSchema extends Record<string, any> = Record<string, any>,
>(options: SyncClientOptions<TSchema>) => SyncClient<TSchema> = SyncClientClass as any;

/**
 * Creates a sync client whose options are derived from reactive context.
 *
 * Call `sync.setContext(...)` or `sync.setData(...)` with a value or Svelte
 * getter. When the resolved context changes structurally, the wrapper rebuilds
 * the inner `SyncClient`, which reconnects with the new table/channel config.
 */
export function createSyncClient<
  TSchema extends Record<string, any> = Record<string, any>,
  TContext = unknown,
>(
  factory: (context: TContext) => SyncClientOptions<TSchema>,
  options?: DynamicSyncClientOptions<TContext>,
): DynamicSyncClient<TSchema, TContext> {
  return createDynamicSyncClient(SyncClient, factory, options);
}
