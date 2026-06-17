import Dexie, { type Table } from "dexie";
import { parseSyncMessage, type SyncMessage } from "../protocol.js";
import { useLiveQuery, type LiveQueryResult } from "./live.svelte.js";

export { useLiveQuery, type LiveQueryResult };

export type TableConfig = {
  indexes: string;
  channel: string;
};

export type SyncClientOptions = {
  name: string;
  url: string;
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

export class SyncClient<
  TSchema extends Record<string, any> = Record<string, any>,
> {
  public db: Dexie;
  private wsUrl: string;
  private socket: WebSocket | undefined;
  private tableConfigs: Record<string, TableConfig>;
  private reconnectTimer: ReturnType<typeof setTimeout> | undefined;
  private pingInterval: ReturnType<typeof setInterval> | undefined;
  private closedByClient = false;
  private activeChannels = new Set<string>();

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
    url: string;
    tables: Record<keyof TSchema & string, TableConfig>;
  }) {
    this.wsUrl = options.url;
    this.tableConfigs = options.tables;

    // Initialize Dexie database
    this.db = new Dexie(options.name);
    const schema: Record<string, string> = {};
    for (const [tableName, config] of Object.entries(options.tables)) {
      schema[tableName] = config.indexes;
    }
    this.db.version(1).stores(schema);

    if (typeof window !== "undefined") {
      this.connect();
    }
  }

  private connect() {
    if (this.closedByClient) return;

    const protocol = window.location.protocol === "https:" ? "wss:" : "ws:";
    const host = window.location.host;
    const fullUrl =
      this.wsUrl.startsWith("ws://") || this.wsUrl.startsWith("wss://")
        ? this.wsUrl
        : `${protocol}//${host}${this.wsUrl}`;

    this.socket = new WebSocket(fullUrl);

    this.socket.addEventListener("open", async () => {
      console.log("SyncClient: WebSocket connected");
      this.activeChannels.clear();
      this.startHeartbeat();

      // Re-subscribe to all tables (delta-sync aware)
      for (const config of Object.values(this.tableConfigs)) {
        await this.subscribeToChannel(config.channel);
      }

      // Re-send all pending unacknowledged mutations
      for (const mut of this.pendingMutations.values()) {
        this.socket?.send(
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

    this.socket.addEventListener("message", async (message) => {
      if (typeof message.data !== "string") return;
      if (message.data === "pong") return;

      const msg = parseSyncMessage(message.data);
      if (!msg) return;

      await this.handleServerMessage(msg);
    });

    this.socket.addEventListener("close", () => {
      this.socket = undefined;
      this.stopHeartbeat();
      if (!this.closedByClient) {
        this.reconnectTimer = setTimeout(() => this.connect(), 2000);
      }
    });

    this.socket.addEventListener("error", (err) => {
      console.error("SyncClient: WebSocket error", err);
    });
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

  private async subscribeToChannel(channel: string) {
    if (this.socket && this.socket.readyState === WebSocket.OPEN) {
      const tableName = this.findTableByChannel(channel);
      let since: string | undefined;
      if (tableName) {
        try {
          const table = this.db.table(tableName);
          const latestRow = await table.orderBy("updatedAt").last();
          if (latestRow && latestRow.updatedAt) {
            since = latestRow.updatedAt;
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
    const table = this.db.table(tableName);
    if (!data || !data.id) return;

    const existing = await table.get(data.id);
    if (existing && existing.updatedAt && data.updatedAt) {
      const existingTime = new Date(existing.updatedAt).getTime();
      const incomingTime = new Date(data.updatedAt).getTime();
      if (incomingTime < existingTime) {
        // Ignore older update (Last-Write-Wins)
        return;
      }
    }
    await table.put(data);
  }

  private async safeDeleteRow(
    tableName: string,
    key: string,
    incomingTimeStr?: string,
  ) {
    const table = this.db.table(tableName);
    if (incomingTimeStr) {
      const existing = await table.get(key);
      if (existing && existing.updatedAt) {
        const existingTime = new Date(existing.updatedAt).getTime();
        const incomingTime = new Date(incomingTimeStr).getTime();
        if (incomingTime < existingTime) {
          // Ignore older delete
          return;
        }
      }
    }
    await table.delete(key);
  }

  private async handleServerMessage(msg: SyncMessage) {
    switch (msg.type) {
      case "snapshot": {
        const tableName = this.findTableByChannel(msg.channel);
        if (tableName) {
          const table = this.db.table(tableName);
          if (msg.isDelta) {
            // Delta Sync: put changes using Last-Write-Wins
            for (const row of msg.data) {
              await this.safePutRow(tableName, row);
            }
          } else {
            // Full Snapshot: clear and replace
            await this.db.transaction("rw", table, async () => {
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
          pending.reject(new Error(msg.error));
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
          const incomingTimeStr = msg.data?.updatedAt;
          await this.safeDeleteRow(tableName, msg.key, incomingTimeStr);
        }
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

  public table<TKey extends keyof TSchema & string>(tableName: TKey) {
    type TRow = TSchema[TKey];
    const dexieTable = this.db.table(tableName) as Table<TRow, string>;
    const config = this.tableConfigs[tableName];
    if (!config) {
      throw new Error(`Table ${tableName} not defined in SyncClient config.`);
    }

    return {
      liveQuery: <TResult = TRow[]>(
        queryFn: (table: Table<TRow, string>) => Promise<TResult> | TResult,
      ) => {
        return useLiveQuery(() => queryFn(dexieTable));
      },

      add: async (row: TRow): Promise<TRow> => {
        const rowData = row as any;
        const id = rowData.id || crypto.randomUUID();
        const fullRow = { ...rowData, id };

        // Rollback function
        const rollback = async () => {
          await dexieTable.delete(id);
        };

        // Apply optimistic update
        await dexieTable.put(fullRow);

        return this.enqueueMutation(
          config.channel,
          "create",
          id,
          fullRow,
          rollback,
        );
      },

      put: async (id: string, changes: Partial<TRow>): Promise<TRow> => {
        const existing = await dexieTable.get(id);
        if (!existing) {
          throw new Error(`Cannot update item ${id}: not found locally.`);
        }

        // Rollback function
        const rollback = async () => {
          await dexieTable.put(existing);
        };

        const updatedRow = { ...(existing as any), ...(changes as any) };

        // Apply optimistic update
        await dexieTable.put(updatedRow);

        return this.enqueueMutation(
          config.channel,
          "update",
          id,
          changes,
          rollback,
        );
      },

      delete: async (id: string): Promise<void> => {
        const existing = await dexieTable.get(id);
        if (!existing) return; // Already deleted

        // Rollback function
        const rollback = async () => {
          await dexieTable.put(existing);
        };

        // Apply optimistic update
        await dexieTable.delete(id);

        return this.enqueueMutation(
          config.channel,
          "delete",
          id,
          undefined,
          rollback,
        );
      },
    };
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
    this.stopHeartbeat();
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = undefined;
    }
    if (this.socket) {
      this.socket.close();
      this.socket = undefined;
    }
  }
}
