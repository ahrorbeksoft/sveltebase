import type { SyncErrorPayload } from './errors.js';

export const SYNC_PROTOCOL_VERSION = 1 as const;
export const SYNC_PROTOCOL_LIMITS = {
  frameBytes: 256 * 1024,
  channelLength: 256,
  idLength: 128,
  subscriptions: 64,
  snapshotRows: 10_000,
  snapshotEvents: 10_000,
} as const;

type Versioned = { v: typeof SYNC_PROTOCOL_VERSION };
export type SyncChange =
  | { kind: 'full'; key: string; row: unknown }
  | { kind: 'patch'; key: string; patch: Record<string, unknown> }
  | { kind: 'delete'; key: string };
export type SyncSubscription = {
  requestId: string;
  channel: string;
  cursor?: number;
  viewVersion?: string | null;
  forceFull?: boolean;
};
export type SyncClientMessage = Versioned &
  (
    | ({ type: 'subscribe' } & SyncSubscription)
    | {
        type: 'subscribe-batch';
        requestId: string;
        subscriptions: SyncSubscription[];
      }
    | { type: 'unsubscribe'; channel: string }
    | {
        type: 'mutate';
        id: string;
        channel: string;
        action: 'create' | 'update' | 'delete';
        key?: string;
        data?: unknown;
      }
    | { type: 'ping'; nonce?: string }
  );
export type SyncServerMessage = Versioned &
  (
    | { type: 'pong'; nonce?: string }
    | {
        type: 'snapshot';
        requestId: string;
        channel: string;
        mode: 'full' | 'delta';
        rows: unknown[];
        events?: SyncChange[];
        cursor: number;
        hasMore?: boolean;
        viewVersion?: string | null;
      }
    | {
        type: 'ack';
        id: string;
        data?: unknown;
        cursor?: number;
        revision?: number;
        replayed?: boolean;
      }
    | {
        type: 'reject';
        id?: string;
        requestId?: string;
        channel?: string;
        error: SyncErrorPayload;
      }
    | {
        type: 'change';
        channel: string;
        change: SyncChange;
        cursor: number;
        revision: number;
        mutationId?: string;
      }
    | { type: 'channel-change'; channel: string }
    | { type: 'channel-reset'; channel: string }
  );
export type SyncMessage = SyncClientMessage | SyncServerMessage;

const object = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);
const text = (
  value: unknown,
  max: number = SYNC_PROTOCOL_LIMITS.idLength,
): value is string =>
  typeof value === 'string' && value.length > 0 && value.length <= max;
const finiteCursor = (value: unknown): value is number =>
  typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
const version = (value: Record<string, unknown>) =>
  value.v === SYNC_PROTOCOL_VERSION;
const channel = (value: unknown): value is string =>
  text(value, SYNC_PROTOCOL_LIMITS.channelLength);
const only = (value: Record<string, unknown>, keys: readonly string[]) =>
  Object.keys(value).every((key) => keys.includes(key));

function subscription(value: unknown, requestIdRequired: boolean): boolean {
  if (!object(value) || !channel(value.channel)) return false;
  if (requestIdRequired && !text(value.requestId)) return false;
  if (value.cursor !== undefined && !finiteCursor(value.cursor)) return false;
  if (
    value.viewVersion !== undefined &&
    value.viewVersion !== null &&
    !text(value.viewVersion)
  )
    return false;
  return value.forceFull === undefined || typeof value.forceFull === 'boolean';
}

function client(value: unknown): value is SyncClientMessage {
  if (!object(value) || !version(value) || typeof value.type !== 'string')
    return false;
  switch (value.type) {
    case 'ping':
      return (
        only(value, ['v', 'type', 'nonce']) &&
        (value.nonce === undefined || text(value.nonce))
      );
    case 'unsubscribe':
      return only(value, ['v', 'type', 'channel']) && channel(value.channel);
    case 'subscribe':
      return (
        only(value, [
          'v',
          'type',
          'requestId',
          'channel',
          'cursor',
          'viewVersion',
          'forceFull',
        ]) && subscription(value, true)
      );
    case 'subscribe-batch':
      return (
        only(value, ['v', 'type', 'requestId', 'subscriptions']) &&
        text(value.requestId) &&
        Array.isArray(value.subscriptions) &&
        value.subscriptions.length > 0 &&
        value.subscriptions.length <= SYNC_PROTOCOL_LIMITS.subscriptions &&
        value.subscriptions.every(
          (entry) =>
            subscription(entry, true) &&
            object(entry) &&
            only(entry, [
              'requestId',
              'channel',
              'cursor',
              'viewVersion',
              'forceFull',
            ]),
        )
      );
    case 'mutate': {
      if (!text(value.id) || !channel(value.channel)) return false;
      if (!only(value, ['v', 'type', 'id', 'channel', 'action', 'key', 'data']))
        return false;
      if (
        value.action !== 'create' &&
        value.action !== 'update' &&
        value.action !== 'delete'
      )
        return false;
      if (value.action !== 'create' && !text(value.key)) return false;
      if (
        value.action === 'create' &&
        value.key !== undefined &&
        !text(value.key)
      )
        return false;
      if (value.action !== 'delete' && !object(value.data)) return false;
      const data = value.data;
      if (
        value.action === 'create' &&
        (!object(data) ||
          !text(data.id) ||
          (value.key !== undefined && value.key !== data.id))
      )
        return false;
      if (
        value.action === 'update' &&
        (!object(data) || (data.id !== undefined && data.id !== value.key))
      )
        return false;
      if (
        value.action !== 'delete' &&
        (!object(data) ||
          Object.keys(data).some(
            (key) =>
              key === '__proto__' ||
              key === 'constructor' ||
              key === 'prototype',
          ))
      )
        return false;
      return value.action !== 'delete' || value.data === undefined;
    }
    default:
      return false;
  }
}

function change(value: unknown): value is SyncChange {
  if (!object(value) || !text(value.key)) return false;
  if (value.kind === 'delete') return only(value, ['kind', 'key']);
  if (value.kind === 'patch')
    return (
      only(value, ['kind', 'key', 'patch']) &&
      object(value.patch) &&
      !Object.keys(value.patch).some(
        (key) =>
          key === '__proto__' || key === 'constructor' || key === 'prototype',
      )
    );
  return (
    value.kind === 'full' &&
    only(value, ['kind', 'key', 'row']) &&
    object(value.row) &&
    value.row.id === value.key
  );
}

function server(value: unknown): value is SyncServerMessage {
  if (!object(value) || !version(value) || typeof value.type !== 'string')
    return false;
  switch (value.type) {
    case 'pong':
      return (
        only(value, ['v', 'type', 'nonce']) &&
        (value.nonce === undefined || text(value.nonce))
      );
    case 'snapshot':
      return (
        only(value, [
          'v',
          'type',
          'requestId',
          'channel',
          'mode',
          'rows',
          'events',
          'cursor',
          'hasMore',
          'viewVersion',
        ]) &&
        text(value.requestId) &&
        channel(value.channel) &&
        (value.mode === 'full' || value.mode === 'delta') &&
        Array.isArray(value.rows) &&
        value.rows.length <= SYNC_PROTOCOL_LIMITS.snapshotRows &&
        value.rows.every((row) => object(row) && text(row.id)) &&
        (value.events === undefined ||
          (Array.isArray(value.events) &&
            value.events.length <= SYNC_PROTOCOL_LIMITS.snapshotEvents &&
            value.events.every(change))) &&
        finiteCursor(value.cursor) &&
        (value.hasMore === undefined || typeof value.hasMore === 'boolean') &&
        (value.viewVersion === undefined ||
          value.viewVersion === null ||
          text(value.viewVersion))
      );
    case 'ack':
      return (
        only(value, [
          'v',
          'type',
          'id',
          'data',
          'cursor',
          'revision',
          'replayed',
        ]) &&
        text(value.id) &&
        (value.data === undefined ||
          (object(value.data) && text(value.data.id))) &&
        (value.cursor === undefined || finiteCursor(value.cursor)) &&
        (value.revision === undefined || finiteCursor(value.revision)) &&
        (value.replayed === undefined || typeof value.replayed === 'boolean')
      );
    case 'reject':
      return (
        only(value, ['v', 'type', 'id', 'requestId', 'channel', 'error']) &&
        (value.id === undefined || text(value.id)) &&
        (value.requestId === undefined || text(value.requestId)) &&
        (value.channel === undefined || channel(value.channel)) &&
        object(value.error) &&
        text(value.error.code) &&
        typeof value.error.message === 'string'
      );
    case 'change':
      return (
        only(value, [
          'v',
          'type',
          'channel',
          'change',
          'cursor',
          'revision',
          'mutationId',
        ]) &&
        channel(value.channel) &&
        change(value.change) &&
        finiteCursor(value.cursor) &&
        finiteCursor(value.revision) &&
        (value.mutationId === undefined || text(value.mutationId))
      );
    case 'channel-change':
    case 'channel-reset':
      return only(value, ['v', 'type', 'channel']) && channel(value.channel);
    default:
      return false;
  }
}

function decode(data: string): unknown {
  if (
    new TextEncoder().encode(data).byteLength > SYNC_PROTOCOL_LIMITS.frameBytes
  )
    return null;
  try {
    return JSON.parse(data) as unknown;
  } catch {
    return null;
  }
}

export function parseClientMessage(data: string): SyncClientMessage | null {
  const value = decode(data);
  return client(value) ? value : null;
}
export function parseServerMessage(data: string): SyncServerMessage | null {
  const value = decode(data);
  return server(value) ? value : null;
}
export function parseSyncMessage(data: string): SyncMessage | null {
  const value = decode(data);
  return client(value) || server(value) ? value : null;
}
