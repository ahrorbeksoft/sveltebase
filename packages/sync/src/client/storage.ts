import type { Table } from 'dexie';

export const META_TABLE = '__sync_meta';
export const OUTBOX_TABLE = '__sync_outbox';
export const CONFIRMED_TABLE = '__sync_confirmed';
const RESERVED = new Set([META_TABLE, OUTBOX_TABLE, CONFIRMED_TABLE]);
const UNSAFE_KEYS = new Set(['__proto__', 'constructor', 'prototype']);

export type SyncAction = 'create' | 'update' | 'delete';
export type TableConfig = { indexes: string; channel: string };
export type OutboxEntry = {
  pk: string;
  account: string;
  id: string;
  sequence: number;
  channel: string;
  table: string;
  action: SyncAction;
  key: string;
  data?: Record<string, unknown>;
};
export type ConfirmedEntry = {
  pk: string;
  account: string;
  channel: string;
  table: string;
  key: string;
  row?: Record<string, unknown>;
  deleted: boolean;
  revision: number;
};

export function physicalDatabaseName(name: string, account: string) {
  return `${name}::sync-v3::${encodeURIComponent(account)}`;
}

export function validateStorageConfig(
  name: string,
  accountId: string,
  tables: Record<string, TableConfig>,
) {
  if (!name || !accountId)
    throw new Error('Sync client name and accountId are required');
  const channels = new Set<string>();
  for (const [tableName, config] of Object.entries(tables)) {
    if (RESERVED.has(tableName))
      throw new Error(`Reserved sync table name: ${tableName}`);
    if (!config.channel || channels.has(config.channel))
      throw new Error(`Duplicate or empty sync channel: ${config.channel}`);
    channels.add(config.channel);
    const declaredPrimary = config.indexes.split(',', 1)[0].trim();
    const primary = declaredPrimary.replace(/^&/, '');
    if (declaredPrimary.startsWith('++') || primary !== 'id') {
      throw new Error(
        `${tableName} must use a non-generated string id as its primary key`,
      );
    }
  }
}

export function assertSafeRecord(
  value: unknown,
): asserts value is Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new Error('Patch must be an object');
  for (const key of Object.keys(value))
    if (UNSAFE_KEYS.has(key)) throw new Error(`Unsafe patch key: ${key}`);
}

export function safeMerge(
  row: Record<string, unknown> | undefined,
  patch: Record<string, unknown> | undefined,
) {
  assertSafeRecord(patch);
  return { ...(row ?? {}), ...patch };
}

export function reduceIntent(
  row: Record<string, unknown> | undefined,
  intent: OutboxEntry,
) {
  if (intent.action === 'delete') return undefined;
  if (intent.action === 'create') return intent.data;
  if (!row) return undefined;
  return safeMerge(row, { ...(intent.data ?? {}), id: intent.key });
}

export async function applyIntent(table: Table, intent: OutboxEntry) {
  if (intent.action === 'delete') {
    await table.delete(intent.key);
    return;
  }
  if (intent.action === 'create') {
    await table.add(intent.data);
    return;
  }
  const previous = (await table.get(intent.key)) as
    Record<string, unknown> | undefined;
  if (!previous)
    throw new Error(`Cannot update missing local row ${intent.key}`);
  await table.put(
    safeMerge(previous, { ...(intent.data ?? {}), id: intent.key }),
  );
}
