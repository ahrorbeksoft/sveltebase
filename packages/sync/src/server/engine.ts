import { DurableObject } from "cloudflare:workers";
import { deserializeConnectionAuth } from "./auth.js";
import { SyncBroker, type ISyncConnection } from "./broker.js";
import { INTERNAL_AUTH_HEADER } from "./handler.js";
import type { SyncHandler, SyncPlatform } from "./index.js";

type SyncEngineEnv = Record<string, unknown>;

/**
 * Cloudflare Durable Object implementation of a broker connection.
 *
 * It keeps websocket transport details plus the auth and identity forwarded by
 * the public worker before the connection reached the Durable Object.
 */
class CloudflareSyncConnection implements ISyncConnection {
  private ws: WebSocket;
  private auth: any = null;
  private identity: string | null = null;
  private subscribedChannels = new Set<string>();
  public readonly headers: Headers;
  public readonly url: string;

  /**
   * Creates a connection wrapper around the accepted server websocket.
   */
  constructor(ws: WebSocket, request: Request) {
    this.ws = ws;
    this.headers = new Headers(request.headers);
    this.url = request.url;
  }

  /** Sends one protocol message to the browser websocket. */
  send(data: string) {
    try {
      this.ws.send(data);
    } catch {
      // Ignore sending to closed sockets
    }
  }

  /** Closes the browser websocket. */
  close(code?: number, reason?: string) {
    try {
      this.ws.close(code, reason);
    } catch {
      // Ignore errors on close
    }
  }

  /** Returns the auth object forwarded by the public worker. */
  getAuth() {
    return this.auth;
  }

  /** Updates the auth object stored on this live connection. */
  setAuth(newAuth: any) {
    this.auth = newAuth;
  }

  /** Returns the identity used by scoped broadcasts. */
  getIdentity() {
    return this.identity;
  }

  /** Updates the identity used by scoped broadcasts. */
  setIdentity(identity: string | null) {
    this.identity = identity;
  }

  /** Returns the mutable set of channels this connection subscribed to. */
  getSubscribedChannels() {
    return this.subscribedChannels;
  }
}

/**
 * Base Durable Object that owns the production sync broker.
 *
 * The exported `SyncEngine` class extends this and supplies the current handler
 * list. Cloudflare calls `fetch`, `webSocketMessage`, `webSocketClose`, and
 * `webSocketError` as Durable Object lifecycle entry points.
 */
export class SyncEngineBase extends DurableObject<SyncEngineEnv> {
  protected broker: SyncBroker;
  private connMap = new Map<WebSocket, CloudflareSyncConnection>();

  /**
   * Creates the broker for this Durable Object instance.
   */
  constructor(
    ctx: DurableObjectState,
    env: SyncEngineEnv,
    handlers: SyncHandler[],
  ) {
    super(ctx, env);
    this.broker = new SyncBroker(handlers);
  }

  /**
   * Handles internal requests forwarded by the public worker.
   *
   * `/websocket` accepts websocket upgrades. `/broadcast`, `/broadcast-batch`,
   * and `/broadcast-change` are internal endpoints used by publish helpers.
   */
  async fetch(request: Request) {
    const url = new URL(request.url);

    if (url.pathname === "/websocket") {
      return this.connectWebSocket(request);
    }

    if (url.pathname === "/broadcast" && request.method === "POST") {
      try {
        const body = (await request.json()) as any;
        const { channel, action, key, data } = body;
        await this.broker.handleExternalChange(
          channel,
          action,
          key,
          data,
          { env: this.env as Record<string, unknown> },
          request,
        );
        return new Response(null, { status: 204 });
      } catch (err: any) {
        return new Response(err.message || "Error processing broadcast", {
          status: 400,
        });
      }
    }

    if (url.pathname === "/broadcast-batch" && request.method === "POST") {
      try {
        const body = (await request.json()) as any;
        const { channel, changes } = body;
        await this.broker.handleExternalBatchChange(
          channel,
          changes,
          { env: this.env as Record<string, unknown> },
          request,
        );
        return new Response(null, { status: 204 });
      } catch (err: any) {
        return new Response(err.message || "Error processing batch broadcast", {
          status: 400,
        });
      }
    }

    if (url.pathname === "/broadcast-change" && request.method === "POST") {
      try {
        const body = (await request.json()) as any;
        const { channel } = body;
        await this.broker.handleExternalChannelChange(String(channel));
        return new Response(null, { status: 204 });
      } catch (err: any) {
        return new Response(err.message || "Error processing change broadcast", {
          status: 400,
        });
      }
    }

    return new Response("Not found", { status: 404 });
  }

  /**
   * Accepts a websocket upgrade and registers it with the broker.
   *
   * Forwarded auth is decoded from the internal header and stored on the
   * connection before subscriptions or mutations can arrive.
   */
  private connectWebSocket(request: Request) {
    if (request.headers.get("Upgrade") !== "websocket") {
      return new Response("Expected Upgrade: websocket", { status: 426 });
    }

    const [client, server] = Object.values(new WebSocketPair());

    this.ctx.acceptWebSocket(server);

    const conn = new CloudflareSyncConnection(server, request);

    const forwardedAuth = deserializeConnectionAuth(
      request.headers.get(INTERNAL_AUTH_HEADER),
    );
    if (forwardedAuth) {
      conn.setAuth(forwardedAuth.auth);
      conn.setIdentity(forwardedAuth.identity);
    }

    this.connMap.set(server, conn);
    this.broker.registerConnection(conn);

    return new Response(null, {
      status: 101,
      webSocket: client,
    });
  }

  /**
   * Durable Object websocket message entry point.
   *
   * Rebuilds a Request and platform object, then delegates protocol handling to
   * the broker.
   */
  async webSocketMessage(ws: WebSocket, message: string | ArrayBuffer) {
    const conn = this.connMap.get(ws);
    if (!conn) return;

    if (typeof message !== "string") return;

    const request = new Request(conn.url, {
      headers: conn.headers,
    });
    const platform: SyncPlatform = {
      env: this.env as Record<string, unknown>,
    };
    await this.broker.handleMessage(
      conn,
      message,
      platform,
      request,
    );
  }

  /**
   * Durable Object websocket close entry point.
   */
  webSocketClose(ws: WebSocket, code: number, reason: string) {
    const conn = this.connMap.get(ws);
    if (conn) {
      this.broker.removeConnection(conn);
      this.connMap.delete(ws);
    }
    try {
      ws.close(code, reason);
    } catch {
      // Ignore
    }
  }

  /**
   * Durable Object websocket error entry point.
   */
  webSocketError(ws: WebSocket) {
    const conn = this.connMap.get(ws);
    if (conn) {
      this.broker.removeConnection(conn);
      this.connMap.delete(ws);
    }
  }
}
