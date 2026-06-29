import Dexie, { type Table } from "dexie";
import { parseSyncMessage, type SyncMessage } from "../protocol.js";
import { ConnectionStatus } from "./status.svelte.js";

export { createLiveQuery } from "./live-query.svelte.js";
export type { LiveQueryState } from "./live-query.svelte.js";

export type TableConfig = {
  indexes: string;
  channel: string;
  updatedAtField?: string;
};

export type SyncClientOptions = {
  name: string;
  url: string | (() => string | Promise<string>);
  tables: Record<string, TableConfig>;
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

  // Reactive connection status delegated to status.svelte.ts
  private _statusState = new ConnectionStatus();

  // Mutations waiting for ack/reject from server
  private pendingMutations = new Map<string, PendingMutation>();
  // Mutations queued to be sent when connection is established
  private mutationQueue: Array<{
    id: string;
    channel: string;
    action: "create" | "update" | "delete";
    key: string;
    data?: any;
  }> = [];

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
    this.version(1).stores(schema);

    // Decorate tables to intercept native Dexie write operations
    this.decorateTables();

    if (typeof window !== "undefined") {
      this.connect();
    }
  }

  public get status() {
    return this._statusState.value;
  }

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
        await this.subscribeToChannel(config.channel);
      }

      // Re-send all pending unacknowledged mutations
      for (const mut of this.pendingMutations.values()) {
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
      this.flushMutationQueue();
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

  private startHeartbeat() {
    this.stopHeartbeat();
    this.pingInterval = setInterval(() => {
      if (this.socket && this.socket.readyState === WebSocket.OPEN) {
        this.socket.send(JSON.stringify({ type: "ping" }));
      }
    }, 55000); // 55 seconds
  }

  private stopHeartbeat() {
    if (this.pingInterval) {
      clearInterval(this.pingInterval);
      this.pingInterval = undefined;
    }
  }

  private getUpdatedAtField(tableName: string) {
    return this.tableConfigs[tableName]?.updatedAtField ?? "updatedAt";
  }

  private getUpdatedAtValue(tableName: string, row: any): string | undefined {
    const value = row?.[this.getUpdatedAtField(tableName)];
    return value == null ? undefined : String(value);
  }

  private async subscribeToChannel(channel: string) {
    if (this.socket && this.socket.readyState === WebSocket.OPEN) {
      const tableName = this.findTableByChannel(channel);
      let since: string | undefined;
      if (tableName) {
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
      this.socket.send(JSON.stringify({ type: "subscribe", channel, since }));
      this.activeChannels.add(channel);
    }
  }

  private flushMutationQueue() {
    if (!this.socket || this.socket.readyState !== WebSocket.OPEN) return;

    while (this.mutationQueue.length > 0) {
      const mut = this.mutationQueue.shift()!;
      this.socket.send(
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

  private async safePutRow(tableName: string, data: any) {
    const table = this.table(tableName);
    if (!data || !data.id) return;

    const existing = await table.get(data.id);
    const existingUpdatedAt = this.getUpdatedAtValue(tableName, existing);
    const incomingUpdatedAt = this.getUpdatedAtValue(tableName, data);
    if (existingUpdatedAt && incomingUpdatedAt) {
      const existingTime = new Date(existingUpdatedAt).getTime();
      const incomingTime = new Date(incomingUpdatedAt).getTime();
      if (incomingTime < existingTime) {
        // Ignore older update (Last-Write-Wins)
        return;
      }
    }
    const originalPut = (table as any)._originalMethods?.put || table.put.bind(table);
    await originalPut(data);
  }

  private async safeDeleteRow(
    tableName: string,
    key: string,
    incomingTimeStr?: string,
  ) {
    const table = this.table(tableName);
    if (incomingTimeStr) {
      const existing = await table.get(key);
      const existingUpdatedAt = this.getUpdatedAtValue(tableName, existing);
      if (existingUpdatedAt) {
        const existingTime = new Date(existingUpdatedAt).getTime();
        const incomingTime = new Date(incomingTimeStr).getTime();
        if (incomingTime < existingTime) {
          // Ignore older delete
          return;
        }
      }
    }
    const originalDelete = (table as any)._originalMethods?.delete || table.delete.bind(table);
    await originalDelete(key);
  }

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
              await table.bulkPut(msg.data);
            });
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
          const incomingTimeStr = this.getUpdatedAtValue(tableName, msg.data);
          await this.safeDeleteRow(tableName, msg.key, incomingTimeStr);
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
              const incomingTimeStr = this.getUpdatedAtValue(
                tableName,
                change.data,
              );
              await this.safeDeleteRow(tableName, change.key, incomingTimeStr);
            }
          }
        });
        break;
      }
    }
  }

  private findTableByChannel(channel: string): string | undefined {
    for (const [tableName, config] of Object.entries(this.tableConfigs)) {
      if (config.channel === channel) return tableName;
    }
    return undefined;
  }


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

  public disconnect() {
    this.closedByClient = true;
    this._statusState.value = "disconnected";
    this.stopHeartbeat();
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

export type SyncClient<TSchema extends Record<string, any> = Record<string, any>> = SyncClientClass<TSchema> & {
  [K in keyof TSchema]: Table<TSchema[K]>;
} & {
  [tableName: string]: Table<any>;
};

export const SyncClient: new <
  TSchema extends Record<string, any> = Record<string, any>,
>(options: {
  name: string;
  url: string | (() => string | Promise<string>);
  tables: Record<keyof TSchema & string, TableConfig>;
}) => SyncClient<TSchema> = SyncClientClass as any;
