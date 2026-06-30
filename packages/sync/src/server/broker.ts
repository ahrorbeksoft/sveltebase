import type { SyncHandler, SyncContext, SyncPlatform } from "./index.js";
import { parseSyncMessage } from "../protocol.js";

export interface ISyncConnection {
  send(data: string): void;
  close(code?: number, reason?: string): void;
  getAuth(): any;
  setAuth(auth: any): void;
  getIdentity(): string | null;
  setIdentity(identity: string | null): void;
  getSubscribedChannels(): Set<string>;
  readonly headers: Headers;
  readonly url: string;
}

export class SyncBroker {
  private handlers = new Map<string, SyncHandler>();
  private dynamicHandlers: SyncHandler[] = [];
  private connections: Set<ISyncConnection> = new Set();

  constructor(handlers: SyncHandler[]) {
    this.setHandlers(handlers);
  }

  public setHandlers(handlers: SyncHandler[]) {
    this.handlers.clear();
    this.dynamicHandlers = [];

    for (const h of handlers) {
      if (typeof h.config.channel === "string") {
        this.handlers.set(h.config.channel, h);
      } else {
        this.dynamicHandlers.push(h);
      }
    }
  }

  public registerConnection(conn: ISyncConnection) {
    this.connections.add(conn);
  }

  public removeConnection(conn: ISyncConnection) {
    this.connections.delete(conn);
  }

  private createConnectionContext(
    conn: ISyncConnection,
    platform: SyncPlatform,
    request?: Request,
  ): SyncContext {
    return {
      platform,
      request: request ?? new Request(conn.url, { headers: conn.headers }),
      auth: conn.getAuth(),
      identity: conn.getIdentity(),
    };
  }

  private createExternalContext(
    platform: SyncPlatform,
    request?: Request,
  ): SyncContext {
    return {
      platform,
      request: request ?? new Request("https://sync.internal/broadcast"),
      auth: null,
      identity: null,
    };
  }

  private findHandler(
    channel: string,
    ctx: SyncContext,
  ): SyncHandler | undefined {
    const handler = this.handlers.get(channel);
    if (handler) return handler;

    for (const h of this.dynamicHandlers) {
      try {
        if (h.resolveChannel(ctx) === channel) return h;
      } catch {
        // Ignore handlers that cannot resolve for this connection context.
      }
    }

    const colonIndex = channel.indexOf(":");
    if (colonIndex !== -1) {
      const prefix = channel.substring(0, colonIndex);
      const prefixHandler = this.handlers.get(prefix);
      if (prefixHandler) return prefixHandler;
    }

    return undefined;
  }

  private findExternalHandler(
    channel: string,
    platform: SyncPlatform,
    request?: Request,
  ): SyncHandler | undefined {
    const externalCtx = this.createExternalContext(platform, request);
    const handler = this.findHandler(channel, externalCtx);
    if (handler) return handler;

    for (const conn of this.connections) {
      if (!conn.getSubscribedChannels().has(channel)) continue;

      const connCtx = this.createConnectionContext(conn, platform);
      const connHandler = this.findHandler(channel, connCtx);
      if (connHandler) return connHandler;
    }

    return undefined;
  }

  public async handleMessage(
    conn: ISyncConnection,
    rawMessage: string,
    platform: SyncPlatform,
    request: Request,
  ) {
    const msg = parseSyncMessage(rawMessage);
    if (!msg) return;

    const ctx = this.createConnectionContext(conn, platform, request);

    try {
      switch (msg.type) {
        case "ping":
          conn.send("pong");
          break;

        case "subscribe": {
          const handler = this.findHandler(msg.channel, ctx);
          if (!handler) {
            conn.send(
              JSON.stringify({
                type: "reject",
                id: "subscribe",
                error: `No handler registered for channel: ${msg.channel}`,
              }),
            );
            return;
          }

          // Channel authorize
          if (handler.config.authorize) {
            await handler.config.authorize(ctx);
          }

          conn.getSubscribedChannels().add(msg.channel);

          // Fetch snapshot with delta support
          const data = await handler.config.fetch(ctx, msg.since);
          conn.send(
            JSON.stringify({
              type: "snapshot",
              channel: msg.channel,
              data,
              isDelta: !!msg.since,
            }),
          );
          break;
        }

        case "unsubscribe":
          conn.getSubscribedChannels().delete(msg.channel);
          break;

        case "mutate": {
          const handler = this.findHandler(msg.channel, ctx);
          if (!handler) {
            conn.send(
              JSON.stringify({
                type: "reject",
                id: msg.id,
                error: `No handler for channel: ${msg.channel}`,
              }),
            );
            return;
          }

          // Authorize mutation
          if (handler.config.authorize) {
            await handler.config.authorize(ctx);
          }

          let result: any;
          if (msg.action === "create") {
            if (handler.config.validate?.create) {
              msg.data = handler.config.validate.create.parse(msg.data);
            }
            if (!handler.config.create) {
              throw new Error(`Forbidden: Create operation not supported on channel ${msg.channel}`);
            }
            result = await handler.config.create(ctx, msg.data);
          } else if (msg.action === "update") {
            if (handler.config.validate?.update) {
              msg.data = handler.config.validate.update.parse(msg.data);
            }
            if (!handler.config.update) {
              throw new Error(`Forbidden: Update operation not supported on channel ${msg.channel}`);
            }
            result = await handler.config.update(ctx, msg.key!, msg.data);
          } else if (msg.action === "delete") {
            if (!handler.config.delete) {
              throw new Error(`Forbidden: Delete operation not supported on channel ${msg.channel}`);
            }
            await handler.config.delete(ctx, msg.key!);
            result = { id: msg.key };
          }

          // Send Ack back to sender
          conn.send(
            JSON.stringify({
              type: "ack",
              id: msg.id,
              data: result,
            }),
          );

          // Broadcast changes to other subscribers
          await this.broadcastChange(
            msg.channel,
            msg.action,
            msg.key || result?.id,
            result,
            msg.id,
            handler,
            ctx,
          );
          break;
        }
      }
    } catch (err: any) {
      console.error(
        `SyncBroker: error handling message type=${msg.type}:`,
        err,
      );
      if (msg.type === "mutate") {
        conn.send(
          JSON.stringify({
            type: "reject",
            id: msg.id,
            error: err.message || "Server error",
          }),
        );
      }
    }
  }

  private async broadcastChange(
    channel: string,
    action: "create" | "update" | "delete",
    key: string | undefined,
    data: any,
    mutationId: string,
    handler: SyncHandler,
    ctx: SyncContext,
  ) {
    const changeMsg = JSON.stringify({
      type: "change",
      channel,
      action,
      key,
      data,
      mutationId,
    });

    const allowedUserIds = await this.resolveScope(
      handler,
      ctx,
      action,
      data,
    );

    this.sendToScopedSubscribers(channel, changeMsg, allowedUserIds);
  }

  private async resolveScope(
    handler: SyncHandler | undefined,
    ctx: SyncContext,
    action: "create" | "update" | "delete",
    data: any,
  ) {
    if (!handler?.config.scope) return "all";

    try {
      return await handler.config.scope(ctx, action, data);
    } catch (e) {
      console.error("SyncBroker: error resolving broadcast scope:", e);
      return [];
    }
  }

  private sendToScopedSubscribers(
    channel: string,
    message: string,
    allowedUserIds: string[] | "all",
  ) {
    for (const conn of this.connections) {
      if (!conn.getSubscribedChannels().has(channel)) continue;

      if (allowedUserIds !== "all") {
        const userId = conn.getIdentity();
        if (!userId || !allowedUserIds.includes(userId)) continue;
      }

      try {
        conn.send(message);
      } catch {
        this.connections.delete(conn);
      }
    }
  }

  public async handleExternalChange(
    channel: string,
    action: "create" | "update" | "delete",
    key: string | undefined,
    data: any,
    platform: SyncPlatform = { env: {} },
    request?: Request,
  ) {
    const changeMsg = JSON.stringify({
      type: "change",
      channel,
      action,
      key,
      data,
    });

    const ctx = this.createExternalContext(platform, request);
    const handler = this.findExternalHandler(channel, platform, request);
    const allowedUserIds = await this.resolveScope(
      handler,
      ctx,
      action,
      data,
    );

    this.sendToScopedSubscribers(channel, changeMsg, allowedUserIds);
  }

  public async handleExternalBatchChange(
    channel: string,
    changes: Array<{ action: "create" | "update" | "delete"; key?: string; data?: any }>,
    platform: SyncPlatform = { env: {} },
    request?: Request,
  ) {
    const ctx = this.createExternalContext(platform, request);
    const handler = this.findExternalHandler(channel, platform, request);

    if (!handler?.config.scope) {
      const batchMsg = JSON.stringify({
        type: "batch",
        channel,
        changes,
      });
      this.sendToScopedSubscribers(channel, batchMsg, "all");
      return;
    }

    // Resolve each change independently. A batch can contain rows with
    // different audiences, and unioning those audiences would leak data.
    for (const change of changes) {
      const changeMsg = JSON.stringify({
        type: "change",
        channel,
        action: change.action,
        key: change.key,
        data: change.data,
      });

      const allowedUserIds = await this.resolveScope(
        handler,
        ctx,
        change.action,
        change.data,
      );

      this.sendToScopedSubscribers(channel, changeMsg, allowedUserIds);
    }
  }
}
