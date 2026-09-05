import { DurableObject } from 'cloudflare:workers';
import { parseServerMessage, SYNC_PROTOCOL_VERSION } from '../protocol.js';
import {
  deserializeConnectionAuth,
  type SerializedConnectionAuth,
} from './auth.js';
import { SyncBroker, type ISyncConnection } from './broker.js';
import { INTERNAL_AUTH_HEADER, type PublishChange } from './handler.js';
import type {
  SyncConnectionAuth,
  SyncHandler,
  SyncMetrics,
  SyncPlatform,
} from './index.js';

type SyncEngineEnv = Record<string, unknown>;
type SocketAttachment = {
  version: 1;
  auth: SerializedConnectionAuth | null;
  channels: string[];
  url: string;
};
const object = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);
const finite = (value: unknown): value is number =>
  typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;

class PersistentSet extends Set<string> {
  constructor(
    values: Iterable<string>,
    private readonly changed: () => void,
  ) {
    super();
    for (const value of values) Set.prototype.add.call(this, value);
  }
  override add(value: string) {
    const result = super.add(value);
    this.changed();
    return result;
  }
  override delete(value: string) {
    const result = super.delete(value);
    if (result) this.changed();
    return result;
  }
  override clear() {
    if (this.size) {
      super.clear();
      this.changed();
    }
  }
}

class CloudflareSyncConnection implements ISyncConnection {
  private auth: SyncConnectionAuth | null;
  private channels: PersistentSet;
  readonly headers = new Headers();
  readonly url: string;
  constructor(
    private readonly ws: WebSocket,
    attachment: SocketAttachment,
  ) {
    this.auth = attachment.auth
      ? {
          subject: attachment.auth.subject,
          user: attachment.auth.user,
          claims: attachment.auth.claims,
          topics: attachment.auth.topics,
          expiresAt: attachment.auth.expiresAt,
        }
      : null;
    this.url = attachment.url;
    this.channels = new PersistentSet(attachment.channels, () =>
      this.persist(),
    );
  }
  private persist() {
    const auth = this.auth;
    const attachment: SocketAttachment = {
      version: 1,
      auth: auth
        ? {
            subject: auth.subject,
            user: auth.user,
            claims: auth.claims,
            topics: auth.topics,
            expiresAt: auth.expiresAt,
          }
        : null,
      channels: [...this.channels],
      url: this.url,
    };
    this.ws.serializeAttachment(attachment);
  }
  send(data: string) {
    this.ws.send(data);
  }
  close(code?: number, reason?: string) {
    this.ws.close(code, reason);
  }
  getConnectionAuth() {
    return this.auth;
  }
  setConnectionAuth(auth: SyncConnectionAuth | null) {
    this.auth = auth;
    this.persist();
  }
  getSubscribedChannels() {
    return this.channels;
  }
}

function attachment(value: unknown): SocketAttachment | null {
  if (
    !object(value) ||
    value.version !== 1 ||
    typeof value.url !== 'string' ||
    !Array.isArray(value.channels) ||
    !value.channels.every((item) => typeof item === 'string')
  )
    return null;
  const auth = value.auth === null ? null : value.auth;
  if (
    auth !== null &&
    (!object(auth) ||
      typeof auth.subject !== 'string' ||
      !Array.isArray(auth.topics))
  )
    return null;
  return value as SocketAttachment;
}
function publishEvent(value: unknown): PublishChange | null {
  if (
    !object(value) ||
    typeof value.channel !== 'string' ||
    !object(value.change) ||
    !finite(value.cursor) ||
    !finite(value.revision)
  )
    return null;
  const event = value as unknown as PublishChange;
  return parseServerMessage(
    JSON.stringify({
      type: 'change',
      channel: event.channel,
      change: event.change,
      cursor: event.cursor,
      revision: event.revision,
      v: SYNC_PROTOCOL_VERSION,
    }),
  )
    ? event
    : null;
}

export class SyncEngineBase extends DurableObject<SyncEngineEnv> {
  protected broker: SyncBroker;
  private connections = new Map<WebSocket, CloudflareSyncConnection>();
  constructor(
    ctx: DurableObjectState,
    env: SyncEngineEnv,
    handlers: SyncHandler[],
    metrics?: SyncMetrics,
  ) {
    super(ctx, env);
    this.broker = new SyncBroker(handlers, metrics);
    for (const ws of ctx.getWebSockets()) {
      const saved = attachment(ws.deserializeAttachment());
      if (!saved) {
        try {
          ws.close(1008, 'Invalid socket state');
        } catch {
          /* already closed */
        }
        continue;
      }
      const conn = new CloudflareSyncConnection(ws, saved);
      this.connections.set(ws, conn);
      this.broker.registerConnection(conn);
    }
  }

  async fetch(request: Request) {
    const url = new URL(request.url);
    if (url.pathname === '/internal/websocket')
      return this.connectWebSocket(request);
    if (
      request.method !== 'POST' ||
      request.headers.get('content-type')?.split(';', 1)[0]?.trim() !==
        'application/json'
    )
      return new Response('Not found', { status: 404 });
    try {
      const body: unknown = await request.json();
      const runtime: SyncPlatform = {
        env: this.env as Record<string, unknown>,
      };
      if (url.pathname === '/internal/change') {
        const event = publishEvent(body);
        if (!event) return new Response('Invalid event', { status: 400 });
        await this.broker.handleExternalChange(event, runtime, request);
        return new Response(null, { status: 204 });
      }
      if (url.pathname === '/internal/changes') {
        if (
          !object(body) ||
          !Array.isArray(body.events) ||
          body.events.length < 1 ||
          body.events.length > 1_000
        )
          return new Response('Invalid events', { status: 400 });
        const events = body.events.map(publishEvent);
        if (events.some((event) => !event))
          return new Response('Invalid events', { status: 400 });
        await this.broker.handleExternalChanges(
          events as PublishChange[],
          runtime,
          request,
        );
        return new Response(null, { status: 204 });
      }
      if (url.pathname === '/internal/resync') {
        if (
          !object(body) ||
          typeof body.channel !== 'string' ||
          !body.channel ||
          body.channel.length > 256 ||
          typeof body.reset !== 'boolean' ||
          !(
            body.topics === 'all' ||
            (Array.isArray(body.topics) &&
              body.topics.length <= 256 &&
              body.topics.every(
                (topic) =>
                  typeof topic === 'string' &&
                  topic.length > 0 &&
                  topic.length <= 256,
              ))
          )
        )
          return new Response('Invalid resync', { status: 400 });
        await this.broker.handleExternalChannelChange(
          body.channel,
          body.reset,
          body.topics as string[] | 'all',
        );
        return new Response(null, { status: 204 });
      }
      if (url.pathname === '/internal/revoke') {
        if (
          !object(body) ||
          typeof body.subject !== 'string' ||
          !body.subject ||
          body.subject.length > 256
        )
          return new Response('Invalid subject', { status: 400 });
        this.broker.revokeSubject(body.subject);
        return new Response(null, { status: 204 });
      }
    } catch {
      return new Response('Invalid request', { status: 400 });
    }
    return new Response('Not found', { status: 404 });
  }

  private connectWebSocket(request: Request) {
    if (request.headers.get('upgrade')?.toLowerCase() !== 'websocket')
      return new Response('Expected Upgrade: websocket', { status: 426 });
    const authValue = request.headers.get(INTERNAL_AUTH_HEADER);
    const auth = deserializeConnectionAuth(authValue);
    const [client, server] = Object.values(new WebSocketPair());
    const saved: SocketAttachment = {
      version: 1,
      auth,
      channels: [],
      url: request.url,
    };
    server.serializeAttachment(saved);
    this.ctx.acceptWebSocket(server);
    const conn = new CloudflareSyncConnection(server, saved);
    this.connections.set(server, conn);
    this.broker.registerConnection(conn);
    return new Response(null, { status: 101, webSocket: client });
  }

  async webSocketMessage(ws: WebSocket, message: string | ArrayBuffer) {
    const conn = this.connections.get(ws);
    if (!conn || typeof message !== 'string') return;
    await this.broker.handleMessage(
      conn,
      message,
      { env: this.env as Record<string, unknown> },
      new Request(conn.url),
    );
  }
  webSocketClose(ws: WebSocket, code: number, reason: string) {
    this.remove(ws);
    try {
      ws.close(code, reason);
    } catch {
      /* closed */
    }
  }
  webSocketError(ws: WebSocket) {
    this.remove(ws);
  }
  private remove(ws: WebSocket) {
    const conn = this.connections.get(ws);
    if (conn) this.broker.removeConnection(conn);
    this.connections.delete(ws);
  }
}
