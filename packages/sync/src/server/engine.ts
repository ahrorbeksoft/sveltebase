import { DurableObject } from "cloudflare:workers";
import { SyncBroker, type ISyncConnection } from "./broker.js";

class CloudflareSyncConnection implements ISyncConnection {
  private ws: WebSocket;
  private auth: any = null;
  private subscribedChannels = new Set<string>();
  public readonly headers: Headers;
  public readonly url: string;

  constructor(ws: WebSocket, request: Request) {
    this.ws = ws;
    this.headers = new Headers(request.headers);
    this.url = request.url;
  }

  send(data: string) {
    try {
      this.ws.send(data);
    } catch {
      // Ignore sending to closed sockets
    }
  }

  close(code?: number, reason?: string) {
    try {
      this.ws.close(code, reason);
    } catch {
      // Ignore errors on close
    }
  }

  getAuth() {
    return this.auth;
  }

  setAuth(newAuth: any) {
    this.auth = newAuth;
  }

  getSubscribedChannels() {
    return this.subscribedChannels;
  }
}

export class SyncEngineBase extends DurableObject<Env> {
  protected broker: SyncBroker;
  private connMap = new Map<WebSocket, CloudflareSyncConnection>();

  constructor(ctx: DurableObjectState, env: Env, handlers: any[]) {
    super(ctx, env);
    this.broker = new SyncBroker(handlers);
  }

  async fetch(request: Request) {
    const url = new URL(request.url);

    if (url.pathname === "/websocket") {
      return this.connectWebSocket(request);
    }

    if (url.pathname === "/broadcast" && request.method === "POST") {
      try {
        const body = (await request.json()) as any;
        const { channel, action, key, data } = body;
        await this.broker.handleExternalChange(channel, action, key, data);
        return new Response(null, { status: 204 });
      } catch (err: any) {
        return new Response(err.message || "Error processing broadcast", {
          status: 400,
        });
      }
    }

    return new Response("Not found", { status: 404 });
  }

  private connectWebSocket(request: Request) {
    if (request.headers.get("Upgrade") !== "websocket") {
      return new Response("Expected Upgrade: websocket", { status: 426 });
    }

    const [client, server] = Object.values(new WebSocketPair());

    this.ctx.acceptWebSocket(server);

    const conn = new CloudflareSyncConnection(server, request);

    const url = new URL(request.url);
    const userId =
      url.searchParams.get("userId") || request.headers.get("x-user-id");
    if (userId) {
      conn.setAuth({ userId });
    }

    this.connMap.set(server, conn);
    this.broker.registerConnection(conn);

    return new Response(null, {
      status: 101,
      webSocket: client,
    });
  }

  async webSocketMessage(ws: WebSocket, message: string | ArrayBuffer) {
    const conn = this.connMap.get(ws);
    if (!conn) return;

    if (typeof message !== "string") return;

    const request = new Request(conn.url, {
      headers: conn.headers,
    });
    await this.broker.handleMessage(
      conn,
      message,
      this.env as any,
      request,
    );
  }

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

  webSocketError(ws: WebSocket) {
    const conn = this.connMap.get(ws);
    if (conn) {
      this.broker.removeConnection(conn);
      this.connMap.delete(ws);
    }
  }
}
