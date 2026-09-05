import { serializeSyncError } from '../errors.js';
import {
  parseClientMessage,
  parseServerMessage,
  SYNC_PROTOCOL_VERSION,
  type SyncChange,
  type SyncClientMessage,
  type SyncServerMessage,
  type SyncSubscription,
} from '../protocol.js';
import type { PublishChange } from './handler.js';
import type {
  MutationOutcome,
  SyncConnectionAuth,
  SyncContext,
  SyncHandler,
  SyncMetrics,
  SyncPlatform,
} from './index.js';

export interface ISyncConnection {
  send(data: string): void;
  close(code?: number, reason?: string): void;
  getConnectionAuth(): SyncConnectionAuth | null;
  setConnectionAuth(auth: SyncConnectionAuth | null): void;
  getSubscribedChannels(): Set<string>;
  readonly headers: Headers;
  readonly url: string;
}

type PendingSubscription = { messages: string[] };
const MAX_CONNECTION_QUEUE = 64;
const MAX_BUFFERED_CHANGES = 256;

function validateOutcome(
  message: Extract<SyncClientMessage, { type: 'mutate' }>,
  outcome: MutationOutcome,
) {
  if (
    !Number.isSafeInteger(outcome.cursor) ||
    outcome.cursor < 0 ||
    !Number.isSafeInteger(outcome.revision) ||
    outcome.revision < 0
  )
    throw new Error('Mutation returned an invalid cursor or revision');
  if (
    message.action !== 'delete' &&
    (!outcome.data ||
      typeof outcome.data !== 'object' ||
      (outcome.data as { id?: unknown }).id !== outcome.change.key)
  )
    throw new Error('Create and update mutations must return a canonical row');
  if (
    !parseServerMessage(
      JSON.stringify({
        type: 'change',
        channel: message.channel,
        change: outcome.change,
        cursor: outcome.cursor,
        revision: outcome.revision,
        v: SYNC_PROTOCOL_VERSION,
      }),
    )
  )
    throw new Error('Mutation returned an invalid change');
}

export class SyncBroker {
  private handlers = new Map<string, SyncHandler>();
  private dynamicHandlers: SyncHandler[] = [];
  private connections = new Set<ISyncConnection>();
  private connectionQueues = new WeakMap<ISyncConnection, Promise<void>>();
  private queueDepth = new WeakMap<ISyncConnection, number>();
  private pendingSubscriptions = new WeakMap<
    ISyncConnection,
    Map<string, PendingSubscription>
  >();
  private readonly metrics?: SyncMetrics;

  constructor(handlers: SyncHandler[], metrics?: SyncMetrics) {
    this.metrics = metrics
      ? (metric) => {
          try {
            metrics(metric);
          } catch {
            // Observability must never change sync behavior.
          }
        }
      : undefined;
    this.setHandlers(handlers);
  }

  setHandlers(handlers: SyncHandler[]) {
    const statics = new Map<string, SyncHandler>();
    const dynamic: SyncHandler[] = [];
    for (const handler of handlers) {
      if (typeof handler.config.channel === 'string') {
        if (statics.has(handler.config.channel))
          throw new Error(`Duplicate sync channel: ${handler.config.channel}`);
        statics.set(handler.config.channel, handler);
      } else dynamic.push(handler);
    }
    this.handlers = statics;
    this.dynamicHandlers = dynamic;
  }

  registerConnection(conn: ISyncConnection) {
    this.connections.add(conn);
    this.pendingSubscriptions.set(conn, new Map());
  }
  removeConnection(conn: ISyncConnection) {
    this.connections.delete(conn);
    this.pendingSubscriptions.delete(conn);
  }
  revokeSubject(subject: string) {
    for (const conn of this.connections)
      if (conn.getConnectionAuth()?.subject === subject) {
        try {
          conn.close(4001, 'Authorization revoked');
        } catch {
          // The connection is removed even if the transport is already closed.
        }
        this.removeConnection(conn);
      }
  }
  private active(conn: ISyncConnection) {
    if (!this.connections.has(conn)) return false;
    const expiresAt = conn.getConnectionAuth()?.expiresAt;
    if (expiresAt !== undefined && expiresAt <= Date.now()) {
      try {
        conn.close(4001, 'Authorization expired');
      } catch {
        // The connection is removed even if the transport is already closed.
      }
      this.removeConnection(conn);
      return false;
    }
    return true;
  }

  private send(conn: ISyncConnection, message: SyncServerMessage) {
    conn.send(JSON.stringify({ ...message, v: SYNC_PROTOCOL_VERSION }));
  }
  private reject(
    conn: ISyncConnection,
    error: unknown,
    correlation: { id?: string; requestId?: string; channel?: string } = {},
  ) {
    this.send(conn, {
      type: 'reject',
      ...correlation,
      error: serializeSyncError(error),
      v: SYNC_PROTOCOL_VERSION,
    });
  }
  private context(
    conn: ISyncConnection,
    platform: SyncPlatform,
    request: Request,
    cache = new Map<string, unknown>(),
  ): SyncContext {
    const auth = conn.getConnectionAuth();
    return {
      platform,
      request,
      auth,
      subject: auth?.subject ?? null,
      topics: new Set(auth?.topics ?? []),
      cache,
      metrics: this.metrics,
    };
  }
  private externalContext(
    platform: SyncPlatform,
    request = new Request('https://sync.internal/'),
  ): SyncContext {
    return {
      platform,
      request,
      auth: null,
      subject: null,
      topics: new Set(),
      cache: new Map(),
      metrics: this.metrics,
    };
  }
  private findHandler(
    channel: string,
    ctx: SyncContext,
  ): SyncHandler | undefined {
    const exact = this.handlers.get(channel);
    if (exact) return exact;
    for (const handler of this.dynamicHandlers) {
      try {
        if (handler.resolveChannel(ctx) === channel) return handler;
      } catch {
        /* inaccessible context */
      }
    }
    return undefined;
  }
  private findExternalHandler(channel: string) {
    const exact = this.handlers.get(channel);
    if (exact) return exact;
    return this.dynamicHandlers.find((handler) =>
      handler.config.matchChannel?.(channel),
    );
  }

  async handleMessage(
    conn: ISyncConnection,
    raw: string,
    platform: SyncPlatform,
    request: Request,
  ) {
    const depth = (this.queueDepth.get(conn) ?? 0) + 1;
    if (depth > MAX_CONNECTION_QUEUE) {
      conn.close(1009, 'Message queue limit exceeded');
      this.removeConnection(conn);
      return;
    }
    this.queueDepth.set(conn, depth);
    const previous = this.connectionQueues.get(conn) ?? Promise.resolve();
    const run = previous
      .catch(() => undefined)
      .then(() => this.process(conn, raw, platform, request))
      .finally(() =>
        this.queueDepth.set(
          conn,
          Math.max(0, (this.queueDepth.get(conn) ?? 1) - 1),
        ),
      );
    this.connectionQueues.set(conn, run);
    await run;
  }

  private async process(
    conn: ISyncConnection,
    raw: string,
    platform: SyncPlatform,
    request: Request,
  ) {
    const msg = parseClientMessage(raw);
    if (!msg) {
      this.reject(conn, new Error('Invalid sync frame'));
      return;
    }
    if (!this.active(conn)) return;
    const ctx = this.context(conn, platform, request);
    try {
      if (msg.type === 'ping') {
        this.send(conn, {
          type: 'pong',
          ...(msg.nonce ? { nonce: msg.nonce } : {}),
          v: SYNC_PROTOCOL_VERSION,
        });
        return;
      }
      if (msg.type === 'unsubscribe') {
        conn.getSubscribedChannels().delete(msg.channel);
        this.pendingSubscriptions.get(conn)?.delete(msg.channel);
        return;
      }
      if (msg.type === 'subscribe') {
        await this.subscribe(conn, ctx, msg);
        return;
      }
      if (msg.type === 'subscribe-batch') {
        const channels = msg.subscriptions.map((item) => item.channel);
        if (new Set(channels).size !== channels.length)
          throw new Error('Duplicate channel in subscription batch');
        await Promise.all(
          msg.subscriptions.map((sub) =>
            this.subscribe(conn, { ...ctx, cache: ctx.cache }, sub).catch(
              (error) =>
                this.reject(conn, error, {
                  requestId: sub.requestId,
                  channel: sub.channel,
                }),
            ),
          ),
        );
        return;
      }
      await this.mutate(conn, ctx, msg);
    } catch (error) {
      if (msg.type === 'mutate')
        this.reject(conn, error, { id: msg.id, channel: msg.channel });
      else if (msg.type === 'subscribe')
        this.reject(conn, error, {
          requestId: msg.requestId,
          channel: msg.channel,
        });
    }
  }

  private async subscribe(
    conn: ISyncConnection,
    ctx: SyncContext,
    request: SyncSubscription,
  ) {
    const handler = this.findHandler(request.channel, ctx);
    if (!handler) throw new Error('Unknown sync channel');
    const pendingMap = this.pendingSubscriptions.get(conn) ?? new Map();
    this.pendingSubscriptions.set(conn, pendingMap);
    pendingMap.set(request.channel, { messages: [] });
    conn.getSubscribedChannels().delete(request.channel);
    try {
      await handler.config.authorize?.(ctx, 'subscribe');
      if (!this.active(conn)) return;
      this.metrics?.({
        name: 'query',
        count: 1,
        operation: 'subscribe',
        channel: request.channel,
      });
      const result = await handler.config.snapshot(ctx, {
        cursor: request.cursor,
        forceFull: request.forceFull === true,
        limit: handler.config.snapshotLimit ?? 1_000,
        viewVersion: request.viewVersion ?? null,
      });
      if (!this.active(conn)) return;
      if (
        !Number.isSafeInteger(result.cursor) ||
        result.cursor < 0 ||
        !Array.isArray(result.rows) ||
        result.rows.length > (handler.config.snapshotLimit ?? 1_000)
      )
        throw new Error('Invalid snapshot result');
      if (
        result.mode === 'delta' &&
        (request.forceFull || request.cursor === undefined)
      )
        throw new Error('A delta snapshot requires a valid client cursor');
      const resultViewVersion =
        result.viewVersion == null ? null : String(result.viewVersion);
      const requestViewVersion = request.viewVersion ?? null;
      if (result.mode === 'delta' && resultViewVersion !== requestViewVersion)
        throw new Error('A delta snapshot cannot change the view version');
      if (
        request.cursor !== undefined &&
        (result.cursor < request.cursor ||
          (result.hasMore === true && result.cursor <= request.cursor))
      )
        throw new Error('Snapshot cursor did not advance');
      this.metrics?.({
        name: 'rows-read',
        count: result.rows.length,
        operation: 'subscribe',
        channel: request.channel,
      });
      this.metrics?.({
        name: 'snapshot-row',
        count: result.rows.length,
        operation: 'subscribe',
        channel: request.channel,
      });
      const snapshot: SyncServerMessage = {
        type: 'snapshot',
        requestId: request.requestId,
        channel: request.channel,
        mode: result.mode,
        rows: result.rows,
        ...(result.events ? { events: result.events } : {}),
        cursor: result.cursor,
        ...(result.hasMore === undefined ? {} : { hasMore: result.hasMore }),
        ...(result.viewVersion === undefined
          ? {}
          : {
              viewVersion: resultViewVersion,
            }),
        v: SYNC_PROTOCOL_VERSION,
      };
      if (!parseServerMessage(JSON.stringify(snapshot)))
        throw new Error('Snapshot contains invalid rows or events');
      this.send(conn, snapshot);
      conn.getSubscribedChannels().add(request.channel);
      const pending = pendingMap.get(request.channel);
      pendingMap.delete(request.channel);
      for (const message of pending?.messages ?? []) conn.send(message);
    } catch (error) {
      pendingMap.delete(request.channel);
      conn.getSubscribedChannels().delete(request.channel);
      throw error;
    }
  }

  private async mutate(
    conn: ISyncConnection,
    ctx: SyncContext,
    msg: Extract<SyncClientMessage, { type: 'mutate' }>,
  ) {
    const handler = this.findHandler(msg.channel, ctx);
    if (!handler || !handler.config.mutate || !handler.config.idempotency)
      throw new Error('Mutation is not supported');
    if (!ctx.subject)
      throw new Error('Authenticated subject required for mutation');
    await handler.config.authorize?.(ctx, 'mutate');
    if (!this.active(conn)) return;
    let data = msg.data;
    if (msg.action === 'create' && handler.config.validate?.create)
      data = handler.config.validate.create.parse(data);
    if (msg.action === 'update' && handler.config.validate?.update)
      data = handler.config.validate.update.parse(data);
    this.metrics?.({
      name: 'broker-read',
      count: 1,
      operation: 'mutation',
      channel: msg.channel,
    });
    const result = await handler.config.idempotency.execute(
      ctx,
      { subject: ctx.subject, channel: msg.channel, mutationId: msg.id },
      async (transaction) => {
        this.metrics?.({
          name: 'transaction-attempt',
          count: 1,
          operation: 'mutation',
          channel: msg.channel,
        });
        const outcome = await handler.config.mutate!(
          { ...ctx, cache: new Map(), transaction },
          {
            id: msg.id,
            subject: ctx.subject!,
            channel: msg.channel,
            action: msg.action,
            ...(msg.key ? { key: msg.key } : {}),
            ...(data === undefined ? {} : { data }),
          },
        );
        validateOutcome(msg, outcome);
        return outcome;
      },
    );
    const outcome = result.outcome;
    validateOutcome(msg, outcome);
    if (!this.active(conn)) return;
    if (result.replayed)
      this.metrics?.({
        name: 'replay-hit',
        count: 1,
        operation: 'mutation',
        channel: msg.channel,
      });
    else {
      this.metrics?.({
        name: 'write',
        count: 1,
        operation: 'mutation',
        channel: msg.channel,
      });
      this.metrics?.({
        name: 'broker-write',
        count: 1,
        operation: 'mutation',
        channel: msg.channel,
      });
    }
    this.send(conn, {
      type: 'ack',
      id: msg.id,
      ...(outcome.data === undefined ? {} : { data: outcome.data }),
      cursor: outcome.cursor,
      revision: outcome.revision,
      replayed: result.replayed,
      v: SYNC_PROTOCOL_VERSION,
    });
    if (!result.replayed)
      await this.broadcast(
        {
          channel: msg.channel,
          change: outcome.change,
          cursor: outcome.cursor,
          revision: outcome.revision,
          mutationId: msg.id,
        },
        handler,
        ctx,
        outcome.routingRow,
      );
  }

  private async topics(
    handler: SyncHandler | undefined,
    ctx: SyncContext,
    change: SyncChange,
    routingRow?: unknown,
  ): Promise<Iterable<string> | 'all'> {
    if (!handler || handler.config.broadcast === 'none') return [];
    if (handler.config.broadcast === 'public') return 'all';
    if (!handler.config.broadcastTopics) return [];
    try {
      return await handler.config.broadcastTopics(ctx, change, routingRow);
    } catch {
      return [];
    }
  }
  private deliver(
    channel: string,
    encoded: string,
    allowed: Iterable<string> | 'all',
  ) {
    const allowedSet = allowed === 'all' ? null : new Set(allowed);
    for (const conn of this.connections) {
      if (!this.active(conn)) continue;
      if (
        allowedSet &&
        !conn.getConnectionAuth()?.topics.some((topic) => allowedSet.has(topic))
      )
        continue;
      const pending = this.pendingSubscriptions.get(conn)?.get(channel);
      try {
        if (pending) {
          if (pending.messages.length >= MAX_BUFFERED_CHANGES) {
            conn.close(1009, 'Subscription buffer limit exceeded');
            this.removeConnection(conn);
          } else pending.messages.push(encoded);
        } else if (conn.getSubscribedChannels().has(channel))
          conn.send(encoded);
      } catch {
        this.removeConnection(conn);
      }
    }
  }
  private async broadcast(
    event: PublishChange & { mutationId?: string },
    handler: SyncHandler | undefined,
    ctx: SyncContext,
    routingRow?: unknown,
  ) {
    const allowed = await this.topics(handler, ctx, event.change, routingRow);
    const message: SyncServerMessage = {
      type: 'change',
      channel: event.channel,
      change: event.change,
      cursor: event.cursor,
      revision: event.revision,
      ...(event.mutationId ? { mutationId: event.mutationId } : {}),
      v: SYNC_PROTOCOL_VERSION,
    };
    this.deliver(event.channel, JSON.stringify(message), allowed);
  }

  async handleExternalChange(
    event: PublishChange,
    platform: SyncPlatform = { env: {} },
    request?: Request,
  ) {
    const handler = this.findExternalHandler(event.channel);
    await this.broadcast(
      event,
      handler,
      this.externalContext(platform, request),
      event.routingRow,
    );
  }
  async handleExternalChanges(
    events: PublishChange[],
    platform: SyncPlatform = { env: {} },
    request?: Request,
  ) {
    const context = this.externalContext(platform, request);
    for (const event of events) {
      const handler = this.findExternalHandler(event.channel);
      await this.broadcast(event, handler, context, event.routingRow);
    }
  }
  async handleExternalChannelChange(
    channel: string,
    reset = false,
    topics: Iterable<string> | 'all' = 'all',
  ) {
    const message = JSON.stringify({
      type: reset ? 'channel-reset' : 'channel-change',
      channel,
      v: SYNC_PROTOCOL_VERSION,
    });
    this.deliver(channel, message, topics);
    this.metrics?.({
      name: 'reset',
      count: 1,
      operation: 'publish',
      channel,
      reason: reset ? 'visibility' : 'change',
    });
  }
}
