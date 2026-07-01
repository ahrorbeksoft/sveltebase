import type { SyncHandler, SyncContext, SyncPlatform } from "./index.js";
import { parseSyncMessage } from "../protocol.js";

/**
 * Transport-agnostic connection wrapper used by the sync broker.
 *
 * Cloudflare Durable Objects and the Vite dev websocket server both implement
 * this interface so the broker can handle auth, subscriptions, and messages
 * without caring which runtime owns the socket.
 */
export interface ISyncConnection {
  /** Sends one already-serialized protocol message to the connected client. */
  send(data: string): void;
  /** Closes the underlying websocket. */
  close(code?: number, reason?: string): void;
  /** Returns the auth object resolved during websocket connection setup. */
  getAuth(): any;
  /** Updates the auth object for this live connection. */
  setAuth(auth: any): void;
  /** Returns the scoped broadcast identity for this connection. */
  getIdentity(): string | null;
  /** Updates the scoped broadcast identity for this connection. */
  setIdentity(identity: string | null): void;
  /** Returns the mutable set of channel names this client is subscribed to. */
  getSubscribedChannels(): Set<string>;
  /** Original request headers used to rebuild handler context. */
  readonly headers: Headers;
  /** Original request URL used to rebuild handler context. */
  readonly url: string;
}

/**
 * Routes sync protocol messages between connected clients and channel handlers.
 *
 * The broker owns connection bookkeeping, authorization calls, validation, and
 * scoped broadcasting. It is shared by Cloudflare production runtime and local
 * Vite dev runtime.
 */
export class SyncBroker {
  private handlers = new Map<string, SyncHandler>();
  private dynamicHandlers: SyncHandler[] = [];
  private connections: Set<ISyncConnection> = new Set();

  /**
   * Creates a broker with the initial set of channel handlers.
   *
   * @param handlers Handlers returned by `defineSync`.
   */
  constructor(handlers: SyncHandler[]) {
    this.setHandlers(handlers);
  }

  /**
   * Replaces the active handler registry.
   *
   * Called by the dev plugin on module reload so new handler code is used by
   * existing websocket connections.
   */
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

  /**
   * Starts tracking a newly accepted websocket connection.
   */
  public registerConnection(conn: ISyncConnection) {
    this.connections.add(conn);
  }

  /**
   * Stops tracking a websocket connection and prevents future broadcasts to it.
   */
  public removeConnection(conn: ISyncConnection) {
    this.connections.delete(conn);
  }

  /**
   * Builds the handler context for a client-originated subscribe or mutation.
   *
   * Auth is read from the connection because the worker resolved it before the
   * Durable Object received the socket.
   */
  private createConnectionContext(
    conn: ISyncConnection,
    platform: SyncPlatform,
    request?: Request,
  ): SyncContext {
    const authUser = conn.getAuth();
    const identity = conn.getIdentity();

    return {
      platform,
      request: request ?? new Request(conn.url, { headers: conn.headers }),
      auth: authUser
        ? {
            user: authUser,
            identity,
          }
        : null,
      identity,
    };
  }

  /**
   * Builds a handler context for server-originated publish events.
   *
   * External events have no active client auth, but still receive platform and
   * request data for database/env access inside `scope`.
   */
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

  /**
   * Finds the handler responsible for a channel.
   *
   * Matching tries exact static channels first, then dynamic channel resolvers,
   * then a prefix fallback so `todos:123` can use a static `todos` handler.
   */
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

  /**
   * Finds a handler for an external publish event.
   *
   * Dynamic handlers may need a real connection context to resolve their
   * channel, so subscribed connections are checked when the external context
   * alone cannot identify a handler.
   */
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

  /**
   * Handles one parsed client websocket message.
   *
   * `subscribe` runs `authorize`, fetches a snapshot, and records the channel.
   * `mutate` validates data, runs the configured write handler, acknowledges the
   * sender, then broadcasts the change to scoped subscribers.
   */
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

  /**
   * Broadcasts one client mutation after resolving its target audience.
   */
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

  /**
   * Runs a handler `scope` callback and normalizes failures to an empty audience.
   *
   * Returning `[]` on errors is important because leaking data to every
   * subscriber would be worse than dropping one broadcast.
   */
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

  /**
   * Sends a protocol message only to subscribers allowed by `scope`.
   *
   * `allowedUserIds` contains connection identities, not arbitrary user objects.
   */
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

  /**
   * Sends a message to every subscriber on a channel without scope filtering.
   */
  private sendToSubscribers(channel: string, message: string) {
    for (const conn of this.connections) {
      if (!conn.getSubscribedChannels().has(channel)) continue;

      try {
        conn.send(message);
      } catch {
        this.connections.delete(conn);
      }
    }
  }

  /**
   * Notifies subscribers that a channel changed and should be resynced.
   *
   * This is used when external server code knows data changed but does not have
   * row-level change payloads to publish.
   */
  public async handleExternalChannelChange(channel: string) {
    const changeMsg = JSON.stringify({
      type: "channel-change",
      channel,
    });

    this.sendToSubscribers(channel, changeMsg);
  }

  /**
   * Broadcasts one server-originated row change to scoped subscribers.
   *
   * Called by `publishEvent` in production and by the dev broker during Vite
   * development.
   */
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

  /**
   * Broadcasts a batch of server-originated row changes.
   *
   * If the handler has `scope`, each row is scoped independently to avoid
   * leaking one row to users who should only receive another row in the batch.
   */
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
