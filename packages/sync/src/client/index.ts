import Dexie, { type Table } from "dexie";
import { parseSyncMessage, type SyncMessage } from "../protocol.js";
import { createDynamicSyncClient } from "./dynamic-client.svelte.js";
import type {
  DynamicSyncClient,
  DynamicSyncClientOptions,
} from "./dynamic-client.svelte.js";
import { ConnectionStatus } from "./status.svelte.js";

export { createLiveQuery } from "./live-query.svelte.js";
export type { DynamicSyncClient, DynamicSyncClientOptions, MaybeGetter } from "./dynamic-client.svelte.js";
export type { LiveQueryState } from "./live-query.svelte.js";

const SYNC_META_TABLE = "__sync_meta";

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
};

type PendingMutation = {
  id: string;
  channel: string;
  action: "create" | "update" | "delete";
  key: string;
  data?: any;
  rollback: () => Promise<void>;
  resolve: (value: any) => void;
  reject: (reason: any) => void;
};

type PendingSnapshot = {
  resolve: (rows: any[]) => void;
  reject: (reason: any) => void;
};

class SyncClientClass<
  TSchema extends Record<string, any> = Record<string, any>,
> extends Dexie {
  private wsUrl: string | (() => string | Promise<string>);
  private socket: WebSocket | undefined;
  private tableConfigs: Record<string, TableConfig>;
  private reconnectTimer: ReturnType<typeof setTimeout> | undefined;
  private pingInterval: ReturnType<typeof setInterval> | undefined;
  private closedByClient = false;
  private activeChannels = new Set<string>();
  private changeTimers = new Map<string, ReturnType<typeof setTimeout>>();

  // Reactive connection status delegated to status.svelte.ts
  private _statusState = new ConnectionStatus();

  // Mutations waiting for ack/reject from server
  private pendingMutations = new Map<string, PendingMutation>();
  private pendingSnapshots = new Map<string, PendingSnapshot[]>();
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
  constructor(options: {
    name: string;
    url: string | (() => string | Promise<string>);
    tables: Record<keyof TSchema & string, TableConfig>;
  }) {
    super(options.name);
    this.wsUrl = options.url;
    this.tableConfigs = options.tables;

    // Initialize Dexie database
    const schema: Record<string, string> = {};
    for (const [tableName, config] of Object.entries(options.tables)) {
      schema[tableName] = config.indexes;
    }
    schema[SYNC_META_TABLE] = "key";
    this.version(1).stores(schema);

    // Decorate tables to intercept native Dexie write operations
    this.decorateTables();

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
   * Wraps configured Dexie table write methods with sync-aware versions.
   *
   * Local writes are applied optimistically first, then sent to the server. If
   * the server rejects a mutation, the stored rollback function restores the
   * previous local row.
   */
  private decorateTables() {
    for (const [tableName, config] of Object.entries(this.tableConfigs)) {
      const table = this.table(tableName);

      const originalAdd = table.add.bind(table);
      const originalPut = table.put.bind(table);
      const originalUpdate = table.update.bind(table);
      const originalDelete = table.delete.bind(table);

      // Save original methods to bypass sync trigger loops when updating from WebSocket
      (table as any)._originalMethods = {
        add: originalAdd,
        put: originalPut,
        update: originalUpdate,
        delete: originalDelete,
      };

      table.add = (async (row: any) => {
        const id = row.id || crypto.randomUUID();
        const fullRow = { ...row, id };

        const rollback = async () => {
          await originalDelete(id);
        };

        await originalAdd(fullRow);

        return this.enqueueMutation(
          config.channel,
          "create",
          id,
          fullRow,
          rollback,
        );
      }) as any;

      table.put = (async (rowOrId: any, changes?: any) => {
        // Overload 1: put(id, changes) - Partial Update
        if (changes !== undefined) {
          const id = rowOrId;
          const existing = await table.get(id);
          if (!existing) {
            throw new Error(`Cannot update item ${id}: not found locally.`);
          }

          const rollback = async () => {
            await originalPut(existing);
          };

          const updatedRow = { ...existing, ...changes };
          await originalPut(updatedRow);

          const diff: any = {};
          for (const [k, v] of Object.entries(changes)) {
            if (existing[k] !== v) {
              diff[k] = v;
            }
          }

          return this.enqueueMutation(
            config.channel,
            "update",
            id,
            diff,
            rollback,
          );
        }

        // Overload 2: put(row) - Insert/Replace
        const row = rowOrId;
        const id = row.id;
        if (!id) {
          throw new Error("put operation requires an inline 'id' property.");
        }

        const existing = await table.get(id);
        if (!existing) {
          return table.add(row);
        }

        const rollback = async () => {
          await originalPut(existing);
        };

        const updatedRow = { ...existing, ...row };
        await originalPut(updatedRow);

        const diff: any = {};
        for (const [k, v] of Object.entries(row)) {
          if (existing[k] !== v) {
            diff[k] = v;
          }
        }

        return this.enqueueMutation(
          config.channel,
          "update",
          id,
          diff,
          rollback,
        );
      }) as any;

      table.update = (async (id: any, changes: any) => {
        const existing = await table.get(id);
        if (!existing) {
          throw new Error(`Cannot update item ${id}: not found locally.`);
        }

        const rollback = async () => {
          await originalPut(existing);
        };

        await originalUpdate(id, changes);

        return this.enqueueMutation(
          config.channel,
          "update",
          id,
          changes,
          rollback,
          );
      }) as any;

      table.delete = (async (id: any) => {
        const existing = await table.get(id);
        if (!existing) return;

        const rollback = async () => {
          await originalPut(existing);
        };

        await originalDelete(id);

        return this.enqueueMutation(
          config.channel,
          "delete",
          id,
          undefined,
          rollback,
        );
      }) as any;
    }
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

      // Re-send all pending unacknowledged mutations
      for (const mut of this.pendingMutations.values()) {
        if (this.socket !== socket || socket.readyState !== WebSocket.OPEN) return;
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

      // Flush queued mutations
      this.flushMutationQueue(socket);
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
    }
    const originalPut = (table as any)._originalMethods?.put || table.put.bind(table);
    await originalPut(data);
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
          // If server returned canonical data, update local Dexie (respecting LWW)
          if (msg.data) {
            const tableName = this.findTableByChannel(pending.channel);
            if (tableName) {
              await this.safePutRow(tableName, msg.data);
            }
          }
          pending.resolve(msg.data);
          this.pendingMutations.delete(msg.id);
        }
        break;
      }
      case "reject": {
        if (msg.id === "subscribe") {
          for (const pending of this.pendingSnapshots.values()) {
            for (const waiter of pending) {
              waiter.reject(new Error(msg.error));
            }
          }
          this.pendingSnapshots.clear();
          break;
        }

        const pending = this.pendingMutations.get(msg.id);
        if (pending) {
          console.warn(`Mutation ${msg.id} rejected by server: ${msg.error}`);
          await pending.rollback();
          
          const errorObj = new Error(msg.error);
          if ((msg as any).validationErrors) {
            (errorObj as any).validationErrors = (msg as any).validationErrors;
          }
          
          pending.reject(errorObj);
          this.pendingMutations.delete(msg.id);
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


  /**
   * Records and sends an optimistic mutation.
   *
   * The returned promise resolves when the server sends `ack` and rejects after
   * `reject`, at which point `rollback` has already restored the previous local
   * state.
   */
  private enqueueMutation(
    channel: string,
    action: "create" | "update" | "delete",
    key: string,
    data: any,
    rollback: () => Promise<void>,
  ): Promise<any> {
    const mutationId = crypto.randomUUID();

    return new Promise((resolve, reject) => {
      this.pendingMutations.set(mutationId, {
        id: mutationId,
        channel,
        action,
        key,
        data,
        rollback,
        resolve,
        reject,
      });

      const msg = {
        id: mutationId,
        channel,
        action,
        key,
        data,
      };

      if (this.socket && this.socket.readyState === WebSocket.OPEN) {
        this.socket.send(JSON.stringify({ type: "mutate", ...msg }));
      } else {
        this.mutationQueue.push(msg);
      }
    });
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
>(options: {
  name: string;
  url: string | (() => string | Promise<string>);
  tables: Record<keyof TSchema & string, TableConfig>;
}) => SyncClient<TSchema> = SyncClientClass as any;

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
