import Dexie, { type Table } from 'dexie';
import {
  createErrorCodec,
  type ErrorCodec,
  type SerializableErrorConstructor,
} from '../errors.js';
import {
  parseServerMessage,
  type SyncChange,
  type SyncServerMessage,
} from '../protocol.js';
import { createDynamicSyncClient } from './dynamic-client.svelte.js';
import type {
  DynamicSyncClient,
  DynamicSyncClientOptions,
} from './dynamic-client.svelte.js';
import { ConnectionStatus, SyncActivity } from './status.svelte.js';
import { SyncTransport, type TransportOptions } from './transport.js';
import {
  CONFIRMED_TABLE as CONFIRMED,
  META_TABLE as META,
  OUTBOX_TABLE as OUTBOX,
  applyIntent,
  assertSafeRecord,
  physicalDatabaseName,
  reduceIntent,
  safeMerge,
  validateStorageConfig,
  type ConfirmedEntry,
  type OutboxEntry,
  type SyncAction,
  type TableConfig,
} from './storage.js';

const MAX_BUFFERED_CHANGES_PER_CHANNEL = 256;

export { createLiveQuery } from './live-query.svelte.js';
export { SerializableError } from '../errors.js';
export { SyncTransport, resolveSocketUrl } from './transport.js';
export type {
  ConnectionState,
  SocketLike,
  TransportOptions,
} from './transport.js';
export type {
  SerializableErrorConstructor,
  SyncErrorInput,
  SyncErrorPayload,
} from '../errors.js';
export type {
  DynamicSyncClient,
  DynamicSyncClientOptions,
  DynamicSyncContextInput,
  MaybeGetter,
} from './dynamic-client.svelte.js';
export type { LiveQueryState } from './live-query.svelte.js';

export type { SyncAction, TableConfig } from './storage.js';
export type SyncClientOptions<
  TSchema extends Record<string, unknown> = Record<string, unknown>,
> = {
  name: string;
  /** Stable authenticated subject/tenant namespace. */
  accountId: string;
  url: string | (() => string | Promise<string>);
  tables: { [K in keyof TSchema & string]: TableConfig };
  errorClasses?: readonly SerializableErrorConstructor[];
  autoStart?: boolean;
  requestTimeoutMs?: number;
  transport?: Omit<
    Partial<TransportOptions>,
    'url' | 'onMessage' | 'onStateChange'
  >;
  onError?: (error: unknown) => void;
  onMetric?: (metric: SyncClientMetric) => void;
};
export type SyncClientMetric = {
  name: 'outbox-read' | 'snapshot' | 'mutation-replay';
  count: number;
  channel?: string;
};
export type MutationReceipt<Result = unknown> = {
  id: string;
  sequence: number;
  local: Promise<void>;
  confirmed: Promise<Result | undefined>;
};
export type ReadonlySyncTable<Row> = Pick<
  Table<Row, string>,
  'get' | 'bulkGet' | 'where' | 'filter' | 'toArray' | 'count' | 'orderBy'
>;

type Waiter = {
  channel: string;
  rows: unknown[];
  lastCursor: number;
  resolve: (rows: unknown[]) => void;
  reject: (error: unknown) => void;
  timer: ReturnType<typeof setTimeout>;
};
type PendingReceipt = {
  resolve: (value: unknown) => void;
  reject: (error: unknown) => void;
};
type CanonicalChange = {
  kind: 'full' | 'patch' | 'delete';
  key: string;
  row?: Record<string, unknown>;
  patch?: Record<string, unknown>;
};

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

class SyncClientClass<
  TSchema extends Record<string, unknown> = Record<string, unknown>,
> {
  readonly accountId: string;
  readonly databaseName: string;
  #db: Dexie;
  #tables: Record<string, TableConfig>;
  #transport: SyncTransport;
  #errors: ErrorCodec;
  #onError: (error: unknown) => void;
  #requestTimeoutMs: number;
  #onMetric: (metric: SyncClientMetric) => void;
  #status = new ConnectionStatus('stopped');
  #activity = new SyncActivity();
  #waiters = new Map<string, Waiter>();
  #receipts = new Map<string, PendingReceipt>();
  #buffered = new Map<
    string,
    Array<Extract<SyncServerMessage, { type: 'change' }>>
  >();
  #messageQueue: Promise<void> = Promise.resolve();
  #subscriptions = new Map<string, Promise<unknown[]>>();
  #sentIds = new Set<string>();
  #sendFlight?: Promise<void>;
  #writes = new Set<Promise<unknown>>();
  #lifecycleGeneration = 0;
  #started = false;
  #disposed = false;

  constructor(options: SyncClientOptions<TSchema>) {
    validateStorageConfig(
      options.name,
      options.accountId,
      options.tables as Record<string, TableConfig>,
    );
    this.accountId = options.accountId;
    this.databaseName = physicalDatabaseName(options.name, options.accountId);
    this.#tables = options.tables as unknown as Record<string, TableConfig>;
    this.#errors = createErrorCodec(options.errorClasses);
    this.#onError = options.onError ?? (() => {});
    this.#requestTimeoutMs = options.requestTimeoutMs ?? 15_000;
    this.#onMetric = options.onMetric ?? (() => {});
    this.#db = new Dexie(this.databaseName);
    const stores: Record<string, string> = {};
    for (const [name, config] of Object.entries(this.#tables))
      stores[name] = config.indexes;
    stores[META] = '&pk';
    stores[OUTBOX] = '&pk, account, [account+sequence], [account+channel], id';
    stores[CONFIRMED] =
      '&pk, account, [account+channel], [account+channel+key]';
    this.#db.version(1).stores(stores);
    this.#transport = new SyncTransport({
      ...options.transport,
      url: options.url,
      onMessage: (data) => this.#enqueueMessage(data),
      onStateChange: (state, error) => {
        this.#status.value = state;
        if (error) this.#onError(error);
        if (state === 'connected') void this.#onConnected();
      },
    });
    if (options.autoStart !== false && typeof window !== 'undefined')
      void this.start().catch(this.#onError);
  }

  get status() {
    return this.#status.value;
  }
  get isSyncing() {
    return this.#activity.isSyncing;
  }
  get pendingMutationCount() {
    return this.#activity.pendingMutations;
  }
  get pendingFetchCount() {
    return this.#activity.pendingFetches;
  }

  /** Dexie read/query surface. Direct writes here remain local-only. */
  read<K extends keyof TSchema & string>(
    name: K,
  ): ReadonlySyncTable<TSchema[K]> {
    this.#assertTable(name);
    return this.#db.table(name) as ReadonlySyncTable<TSchema[K]>;
  }

  async start(): Promise<void> {
    if (this.#disposed) throw new Error('Sync client is disposed');
    this.#started = true;
    await this.#db.open();
    const count = await this.#db
      .table(OUTBOX)
      .where('account')
      .equals(this.accountId)
      .count();
    this.#refreshActivity(count);
    await this.#transport.start();
  }
  stop(): void {
    ++this.#lifecycleGeneration;
    this.#started = false;
    this.#transport.stop();
    this.#sentIds.clear();
    this.#rejectWaiters(new Error('Sync client stopped'));
  }
  disconnect(): void {
    this.stop();
  }
  async reconnect(): Promise<void> {
    if (this.#disposed) throw new Error('Sync client is disposed');
    this.#started = true;
    await this.#transport.reconnect();
  }
  async whenConnected(options?: {
    timeoutMs?: number;
    reconnectIfDisconnected?: boolean;
  }) {
    if (this.#transport.connected) return;
    const connection =
      options?.reconnectIfDisconnected === false
        ? this.#transport.start()
        : this.#started
          ? this.#transport.start()
          : this.start();
    const timeout = deferred<never>();
    const timer = setTimeout(
      () => timeout.reject(new Error('Timed out waiting for sync connection')),
      options?.timeoutMs ?? 15_000,
    );
    try {
      await Promise.race([connection, timeout.promise]);
    } finally {
      clearTimeout(timer);
    }
  }
  async whenIdle(options?: { timeoutMs?: number }) {
    const deadline = Date.now() + (options?.timeoutMs ?? 15_000);
    while (this.isSyncing) {
      if (Date.now() >= deadline)
        throw new Error('Timed out waiting for sync idle');
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
  }

  async create<K extends keyof TSchema & string>(
    tableName: K,
    row: TSchema[K],
  ): Promise<MutationReceipt<TSchema[K]>> {
    this.#assertTable(tableName);
    const value = row as Record<string, unknown>;
    assertSafeRecord(value);
    const key = value.id;
    if (typeof key !== 'string' || !key)
      throw new Error(`${tableName}.id must be a non-empty string`);
    return this.#mutate(tableName, 'create', key, value) as Promise<
      MutationReceipt<TSchema[K]>
    >;
  }
  async update<K extends keyof TSchema & string>(
    tableName: K,
    key: string,
    patch: Partial<TSchema[K]>,
  ): Promise<MutationReceipt<TSchema[K]>> {
    if (!key) throw new Error('Mutation key must be a non-empty string');
    assertSafeRecord(patch);
    if (
      (patch as Record<string, unknown>).id !== undefined &&
      (patch as Record<string, unknown>).id !== key
    )
      throw new Error('Update patch cannot change id');
    return this.#mutate(
      tableName,
      'update',
      key,
      patch as Record<string, unknown>,
    ) as Promise<MutationReceipt<TSchema[K]>>;
  }
  async delete<K extends keyof TSchema & string>(
    tableName: K,
    key: string,
  ): Promise<MutationReceipt<void>> {
    if (!key) throw new Error('Mutation key must be a non-empty string');
    return this.#mutate(tableName, 'delete', key) as Promise<
      MutationReceipt<void>
    >;
  }

  async resyncTable<K extends keyof TSchema & string>(tableName: K) {
    return this.resyncChannel(this.#assertTable(tableName).channel);
  }
  async resyncChannel(channel: string): Promise<unknown[]> {
    if (!this.#findTable(channel))
      throw new Error(`No sync table configured for channel ${channel}`);
    await this.whenConnected();
    return this.#subscribe(channel, true);
  }
  async resyncTables(
    names: Array<keyof TSchema & string>,
    options?: { reconnect?: boolean; wait?: boolean },
  ) {
    if (options?.reconnect) await this.reconnect();
    else await this.whenConnected();
    const result: Record<string, unknown[]> = {};
    await Promise.all(
      names.map(async (name) => {
        result[name] = await this.resyncTable(name);
      }),
    );
    if (options?.wait !== false) await this.whenIdle();
    return result;
  }
  async purge(): Promise<void> {
    this.#disposed = true;
    this.stop();
    await Promise.allSettled([...this.#writes, this.#messageQueue]);
    await this.#db.delete();
  }
  async purgeAccount(accountId: string): Promise<void> {
    if (accountId !== this.accountId)
      throw new Error('This client can only purge its own account namespace');
    await this.purge();
  }
  dispose(): void {
    if (this.#disposed) return;
    this.#disposed = true;
    this.stop();
    this.#db.close();
    for (const receipt of this.#receipts.values())
      receipt.reject(new Error('Sync client disposed'));
    this.#receipts.clear();
    this.#refreshActivity(0);
  }

  async #mutate(
    tableName: string,
    action: SyncAction,
    key: string,
    data?: Record<string, unknown>,
  ): Promise<MutationReceipt> {
    if (this.#disposed) throw new Error('Sync client is disposed');
    const generation = this.#lifecycleGeneration;
    const config = this.#assertTable(tableName);
    await this.#db.open();
    if (this.#disposed || generation !== this.#lifecycleGeneration)
      throw new Error('Sync client stopped before local commit');
    const id = crypto.randomUUID();
    const confirmation = deferred<unknown>();
    confirmation.promise.catch(() => {});
    let sequence = 0;
    const app = this.#db.table(tableName),
      outbox = this.#db.table(OUTBOX),
      meta = this.#db.table(META);
    const write = this.#db.transaction('rw', app, outbox, meta, async () => {
      const seqKey = `sequence:${this.accountId}`;
      const current = (await meta.get(seqKey)) as
        { value?: unknown } | undefined;
      sequence = (typeof current?.value === 'number' ? current.value : 0) + 1;
      await meta.put({ pk: seqKey, value: sequence });
      const entry: OutboxEntry = {
        pk: this.#outboxKey(id),
        account: this.accountId,
        id,
        sequence,
        channel: config.channel,
        table: tableName,
        action,
        key,
        data,
      };
      await outbox.add(entry);
      await applyIntent(app, entry);
    });
    this.#writes.add(write);
    try {
      await write;
    } finally {
      this.#writes.delete(write);
    }
    this.#receipts.set(id, {
      resolve: confirmation.resolve,
      reject: confirmation.reject,
    });
    this.#refreshActivity(this.#activity.pendingMutations + 1);
    this.#sendOutbox().catch(this.#onError);
    return {
      id,
      sequence,
      local: Promise.resolve(),
      confirmed: confirmation.promise,
    };
  }

  async #onConnected() {
    if (!this.#started || this.#disposed) return;
    const generation = this.#lifecycleGeneration;
    this.#sentIds.clear();
    try {
      await this.#db.open();
      await Promise.all(
        Object.values(this.#tables).map(({ channel }) =>
          this.#subscribe(channel, false),
        ),
      );
      if (generation !== this.#lifecycleGeneration || !this.#started) return;
      await this.#sendOutbox();
    } catch (error) {
      this.#onError(error);
    }
  }
  async #subscribe(channel: string, forceFull: boolean): Promise<unknown[]> {
    const coalesceKey = `${channel}:${forceFull ? 'full' : 'delta'}`;
    const existing = this.#subscriptions.get(coalesceKey);
    if (existing) return existing;
    const running = this.#subscribeOnce(channel, forceFull);
    this.#subscriptions.set(coalesceKey, running);
    try {
      return await running;
    } finally {
      this.#subscriptions.delete(coalesceKey);
    }
  }
  async #subscribeOnce(
    channel: string,
    forceFull: boolean,
  ): Promise<unknown[]> {
    if (!this.#findTable(channel))
      throw new Error(`No sync table configured for channel ${channel}`);
    const requestId = crypto.randomUUID();
    const cursor = (await this.#db
      .table(META)
      .get(`cursor:${this.accountId}:${channel}`)) as
      { value?: unknown } | undefined;
    const view = (await this.#db
      .table(META)
      .get(`view:${this.accountId}:${channel}`)) as
      { value?: unknown } | undefined;
    const request = deferred<unknown[]>();
    const timer = setTimeout(() => {
      const waiter = this.#waiters.get(requestId);
      if (!waiter) return;
      this.#waiters.delete(requestId);
      waiter.reject(new Error(`Timed out waiting for snapshot ${requestId}`));
      this.#refreshActivity();
    }, this.#requestTimeoutMs);
    this.#waiters.set(requestId, {
      channel,
      rows: [],
      lastCursor:
        !forceFull && typeof cursor?.value === 'number' ? cursor.value : -1,
      resolve: request.resolve,
      reject: request.reject,
      timer,
    });
    this.#refreshActivity();
    try {
      this.#transport.send({
        v: 1,
        type: 'subscribe',
        requestId,
        channel,
        ...(forceFull ? { forceFull: true } : {}),
        ...(!forceFull && typeof cursor?.value === 'number'
          ? { cursor: cursor.value }
          : {}),
        ...(view?.value != null ? { viewVersion: String(view.value) } : {}),
      });
    } catch (error) {
      clearTimeout(timer);
      this.#waiters.delete(requestId);
      this.#refreshActivity();
      request.reject(error);
    }
    return request.promise;
  }
  async #sendOutbox() {
    if (this.#sendFlight) return this.#sendFlight;
    const run = this.#sendOutboxOnce();
    this.#sendFlight = run;
    try {
      await run;
    } finally {
      if (this.#sendFlight === run) this.#sendFlight = undefined;
    }
  }
  async #sendOutboxOnce() {
    if (!this.#transport.connected) return;
    const entries = await this.#outboxEntries();
    for (const entry of entries) {
      if (!this.#transport.connected) return;
      if (this.#sentIds.has(entry.id)) continue;
      this.#transport.send({
        v: 1,
        type: 'mutate',
        id: entry.id,
        channel: entry.channel,
        action: entry.action,
        key: entry.key,
        data: entry.data,
      });
      this.#sentIds.add(entry.id);
    }
    this.#refreshActivity(entries.length);
  }
  #enqueueMessage(data: string) {
    const generation = this.#lifecycleGeneration;
    this.#messageQueue = this.#messageQueue
      .then(async () => {
        if (
          generation !== this.#lifecycleGeneration ||
          !this.#started ||
          this.#disposed
        )
          return;
        const message = parseServerMessage(data);
        if (message) await this.#handleMessage(message);
      })
      .catch(this.#onError);
    return this.#messageQueue;
  }
  async #handleMessage(message: SyncServerMessage) {
    if (message.type === 'snapshot') {
      const waiter = this.#waiters.get(message.requestId);
      if (!waiter || waiter.channel !== message.channel) return;
      if (message.hasMore && message.cursor <= waiter.lastCursor) {
        this.#rejectSnapshotWaiter(
          message.requestId,
          new Error('Paginated snapshot cursor did not advance'),
        );
        return;
      }
      let resetVisibilityEpoch: boolean;
      try {
        const changes: CanonicalChange[] =
          message.mode === 'full'
            ? message.rows.map((row) => {
                assertSafeRecord(row);
                return {
                  kind: 'full',
                  key: this.#rowKey(message.channel, row),
                  row,
                };
              })
            : [
                ...message.rows.map((row) => {
                  assertSafeRecord(row);
                  return {
                    kind: 'full' as const,
                    key: this.#rowKey(message.channel, row),
                    row,
                  };
                }),
                ...(message.events ?? []).map(normalizeChange),
              ];
        resetVisibilityEpoch = Boolean(
          await this.#applyCanonical(
            message.channel,
            changes,
            message.cursor,
            message.viewVersion,
            message.mode === 'full',
          ),
        );
      } catch (error) {
        this.#rejectSnapshotWaiter(message.requestId, error);
        return;
      }
      if (resetVisibilityEpoch) this.#buffered.delete(message.channel);
      waiter.rows.push(...message.rows);
      if (message.hasMore) {
        waiter.lastCursor = message.cursor;
        this.#transport.send({
          v: 1,
          type: 'subscribe',
          requestId: message.requestId,
          channel: message.channel,
          cursor: message.cursor,
          ...(message.viewVersion != null
            ? { viewVersion: message.viewVersion }
            : {}),
        });
        return;
      }
      for (const buffered of this.#buffered.get(message.channel) ?? [])
        if (buffered.cursor > message.cursor)
          await this.#applyChangeMessage(buffered);
      this.#buffered.delete(message.channel);
      clearTimeout(waiter.timer);
      this.#waiters.delete(message.requestId);
      this.#refreshActivity();
      waiter.resolve(waiter.rows);
      return;
    }
    if (message.type === 'change') {
      if (
        [...this.#waiters.values()].some(
          (waiter) => waiter.channel === message.channel,
        )
      ) {
        const queue = this.#buffered.get(message.channel) ?? [];
        if (queue.length >= MAX_BUFFERED_CHANGES_PER_CHANNEL) {
          const error = new Error(
            `Buffered sync change limit exceeded for ${message.channel}`,
          );
          this.#onError(error);
          this.stop();
          return;
        }
        queue.push(message);
        this.#buffered.set(message.channel, queue);
      } else await this.#applyChangeMessage(message);
      return;
    }
    if (message.type === 'ack') {
      await this.#settleMutation(message);
      return;
    }
    if (message.type === 'reject') {
      if (message.requestId) {
        const waiter = this.#waiters.get(message.requestId);
        if (waiter) {
          clearTimeout(waiter.timer);
          this.#waiters.delete(message.requestId);
          waiter.reject(this.#errors.deserialize(message.error));
          this.#refreshActivity();
        }
      } else if (message.id) await this.#settleMutation(message);
      return;
    }
    if (message.type === 'channel-reset')
      void this.#subscribe(message.channel, true).catch(this.#onError);
    if (message.type === 'channel-change')
      void this.#subscribe(message.channel, false).catch(this.#onError);
  }
  async #applyChangeMessage(
    message: Extract<SyncServerMessage, { type: 'change' }>,
  ) {
    await this.#applyCanonical(
      message.channel,
      [normalizeChange(message.change)],
      message.cursor,
      undefined,
      false,
      message.revision,
    );
  }

  #rejectSnapshotWaiter(requestId: string, error: unknown) {
    const waiter = this.#waiters.get(requestId);
    if (!waiter) return;
    clearTimeout(waiter.timer);
    this.#waiters.delete(requestId);
    this.#buffered.delete(waiter.channel);
    this.#refreshActivity();
    waiter.reject(error);
  }

  async #settleMutation(
    message: Extract<SyncServerMessage, { type: 'ack' | 'reject' }>,
  ) {
    if (!message.id) return;
    const rejected = message.type === 'reject';
    const entry = (await this.#db
      .table(OUTBOX)
      .get(this.#outboxKey(message.id))) as OutboxEntry | undefined;
    if (!entry) return;
    const table = this.#db.table(entry.table),
      confirmed = this.#db.table(CONFIRMED),
      outbox = this.#db.table(OUTBOX),
      meta = this.#db.table(META);
    await this.#db.transaction(
      'rw',
      table,
      confirmed,
      outbox,
      meta,
      async () => {
        if (!rejected) {
          const previous = (await confirmed.get(
            this.#confirmedKey(entry.channel, entry.key),
          )) as ConfirmedEntry | undefined;
          const cursorRow = (await meta.get(
            `cursor:${this.accountId}:${entry.channel}`,
          )) as { value?: unknown } | undefined;
          const currentCursor =
            typeof cursorRow?.value === 'number' ? cursorRow.value : -1;
          const ackIsCurrent =
            (message.cursor === undefined || message.cursor > currentCursor) &&
            (message.revision === undefined ||
              message.revision >= (previous?.revision ?? -1));
          if (ackIsCurrent) {
            const hasCanonicalRow = isRecord(message.data);
            const row = hasCanonicalRow
              ? message.data
              : reduceIntent(
                  previous?.deleted ? undefined : previous?.row,
                  entry,
                );
            await confirmed.put({
              pk: this.#confirmedKey(entry.channel, entry.key),
              account: this.accountId,
              channel: entry.channel,
              table: entry.table,
              key: entry.key,
              row,
              deleted: entry.action === 'delete',
              revision: hasCanonicalRow
                ? finite(message.revision, previous?.revision ?? 0)
                : (previous?.revision ?? 0),
            });
          }
        }
        await outbox.delete(entry.pk);
        await this.#materializeKey(entry.table, entry.channel, entry.key);
      },
    );
    const receipt = this.#receipts.get(message.id);
    this.#receipts.delete(message.id);
    if (message.type === 'reject')
      receipt?.reject(this.#errors.deserialize(message.error));
    else receipt?.resolve(message.data);
    this.#refreshActivity(Math.max(0, this.#activity.pendingMutations - 1));
  }

  async #applyCanonical(
    channel: string,
    changes: CanonicalChange[],
    cursor: number,
    viewVersion?: unknown,
    full = false,
    revision?: number,
  ) {
    const tableName = this.#findTable(channel);
    if (!tableName) return;
    const table = this.#db.table(tableName),
      confirmed = this.#db.table(CONFIRMED),
      meta = this.#db.table(META),
      outbox = this.#db.table(OUTBOX);
    return this.#db.transaction(
      'rw',
      table,
      confirmed,
      meta,
      outbox,
      async () => {
        const cursorRow = (await meta.get(
          `cursor:${this.accountId}:${channel}`,
        )) as { value?: unknown } | undefined;
        const viewRow = (await meta.get(
          `view:${this.accountId}:${channel}`,
        )) as { value?: unknown } | undefined;
        const viewChanged =
          viewVersion !== undefined && viewVersion !== viewRow?.value;
        if (
          !full &&
          viewChanged &&
          (viewRow !== undefined || cursorRow !== undefined)
        )
          throw new Error('Delta snapshot cannot change visibility version');
        if (
          typeof cursorRow?.value === 'number' &&
          cursor < cursorRow.value &&
          !(full && viewChanged)
        )
          return false;
        // Transaction-local indexes do not participate in Svelte rendering.
        // eslint-disable-next-line svelte/prefer-svelte-reactivity
        const affected = new Set<string>();
        if (full) {
          ((await table.toCollection().primaryKeys()) as string[]).forEach(
            (key) => affected.add(key),
          );
          const old = (await confirmed
            .where('[account+channel]')
            .equals([this.accountId, channel])
            .toArray()) as ConfirmedEntry[];
          old.forEach((row) => affected.add(row.key));
          await confirmed
            .where('[account+channel]')
            .equals([this.accountId, channel])
            .delete();
        }
        const pending = (await outbox
          .where('[account+channel]')
          .equals([this.accountId, channel])
          .sortBy('sequence')) as OutboxEntry[];
        this.#onMetric({ name: 'outbox-read', count: 1, channel });
        if (pending.length)
          this.#onMetric({
            name: 'mutation-replay',
            count: pending.length,
            channel,
          });
        // Transaction-local lookup; making this reactive adds observer overhead.
        // eslint-disable-next-line svelte/prefer-svelte-reactivity
        const pendingByKey = new Map<string, OutboxEntry[]>();
        for (const entry of pending) {
          const values = pendingByKey.get(entry.key) ?? [];
          values.push(entry);
          pendingByKey.set(entry.key, values);
        }
        for (const change of changes) {
          if (!change?.key) continue;
          affected.add(change.key);
          const pk = this.#confirmedKey(channel, change.key);
          const prior = (await confirmed.get(pk)) as ConfirmedEntry | undefined;
          if (revision !== undefined && prior && revision <= prior.revision)
            continue;
          if (change.kind === 'delete')
            await confirmed.put({
              pk,
              account: this.accountId,
              channel,
              table: tableName,
              key: change.key,
              deleted: true,
              revision: finite(revision, prior?.revision ?? 0),
            });
          else {
            if (
              change.kind === 'patch' &&
              change.patch?.id !== undefined &&
              change.patch.id !== change.key
            )
              throw new Error('Canonical patch cannot change id');
            const row =
              change.kind === 'patch'
                ? safeMerge(prior?.row, {
                    ...(change.patch ?? {}),
                    id: change.key,
                  })
                : change.row;
            await confirmed.put({
              pk,
              account: this.accountId,
              channel,
              table: tableName,
              key: change.key,
              row,
              deleted: false,
              revision: finite(revision, prior?.revision ?? 0),
            });
          }
        }
        await meta.put({
          pk: `cursor:${this.accountId}:${channel}`,
          value: cursor,
        });
        if (viewVersion !== undefined)
          await meta.put({
            pk: `view:${this.accountId}:${channel}`,
            value: viewVersion,
          });
        if (full) pending.forEach((entry) => affected.add(entry.key));
        this.#onMetric({ name: 'snapshot', count: changes.length, channel });
        for (const key of affected)
          await this.#materializeKey(
            tableName,
            channel,
            key,
            pendingByKey.get(key) ?? [],
          );
        return full && viewChanged;
      },
    );
  }
  async #materializeKey(
    tableName: string,
    channel: string,
    key: string,
    knownIntents?: OutboxEntry[],
  ) {
    const base = (await this.#db
      .table(CONFIRMED)
      .get(this.#confirmedKey(channel, key))) as ConfirmedEntry | undefined;
    let row = base?.deleted ? undefined : base?.row;
    const intents =
      knownIntents ??
      (await this.#outboxEntries()).filter(
        (intent) => intent.channel === channel && intent.key === key,
      );
    for (const intent of intents) row = reduceIntent(row, intent);
    const table = this.#db.table(tableName);
    if (row) await table.put(row);
    else await table.delete(key);
  }
  #outboxEntries() {
    this.#onMetric({ name: 'outbox-read', count: 1 });
    return this.#db
      .table(OUTBOX)
      .where('account')
      .equals(this.accountId)
      .sortBy('sequence') as Promise<OutboxEntry[]>;
  }
  #rowKey(channel: string, row: Record<string, unknown>) {
    assertSafeRecord(row);
    const value = row.id;
    if (typeof value !== 'string' || !value)
      throw new Error(`Server row for ${channel} has no string id`);
    return value;
  }
  #findTable(channel: string) {
    return Object.keys(this.#tables).find(
      (name) => this.#tables[name].channel === channel,
    );
  }
  #assertTable(name: string) {
    const config = this.#tables[name];
    if (!config) throw new Error(`No sync table configured for ${name}`);
    return config;
  }
  #outboxKey(id: string) {
    return `${this.accountId}\0${id}`;
  }
  #confirmedKey(channel: string, key: string) {
    return `${this.accountId}\0${channel}\0${key}`;
  }
  #rejectWaiters(error: unknown) {
    for (const waiter of this.#waiters.values()) {
      clearTimeout(waiter.timer);
      waiter.reject(error);
    }
    this.#waiters.clear();
    this.#buffered.clear();
    this.#refreshActivity();
  }
  #refreshActivity(knownOutbox = this.#activity.pendingMutations) {
    this.#activity.setCounts(knownOutbox, this.#waiters.size);
  }
}

function normalizeChange(change: SyncChange): CanonicalChange {
  if (change?.kind === 'full') {
    assertSafeRecord(change.row);
    return { kind: 'full', key: change.key, row: change.row };
  }
  if (change?.kind === 'patch') {
    assertSafeRecord(change.patch);
    return { kind: 'patch', key: change.key, patch: change.patch };
  }
  if (change?.kind === 'delete') return { kind: 'delete', key: change.key };
  throw new Error('Unknown canonical change kind');
}
function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}
function finite(value: unknown, fallback: number) {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
}

export type SyncClient<
  TSchema extends Record<string, unknown> = Record<string, unknown>,
> = SyncClientClass<TSchema>;
export const SyncClient: new <
  TSchema extends Record<string, unknown> = Record<string, unknown>,
>(
  options: SyncClientOptions<TSchema>,
) => SyncClient<TSchema> = SyncClientClass;
export function createSyncClient<
  TSchema extends Record<string, unknown> = Record<string, unknown>,
  TContext = unknown,
>(
  factory: (context: TContext) => SyncClientOptions<TSchema>,
  options?: DynamicSyncClientOptions<TContext>,
): DynamicSyncClient<TSchema, TContext> {
  return createDynamicSyncClient(SyncClient, factory, options);
}
