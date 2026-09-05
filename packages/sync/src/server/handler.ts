import {
  parseServerMessage,
  SYNC_PROTOCOL_VERSION,
  type SyncChange,
} from '../protocol.js';
import type { SyncMetric, SyncMetrics, SyncPlatform } from './contracts.js';

export const INTERNAL_AUTH_HEADER = 'x-sveltebase-sync-auth';
export type { SyncAuthResult } from './contracts.js';
export type PublishChange = {
  channel: string;
  change: SyncChange;
  cursor: number;
  revision: number;
  routingRow?: unknown;
};
export type PublisherOptions = {
  platform: SyncPlatform;
  syncEngineBinding?: string;
  shard?: string | ((channel: string) => string);
  metrics?: SyncMetrics;
};
export type SyncPublisher = {
  change(event: PublishChange): Promise<void>;
  changes(events: PublishChange[]): Promise<void>;
  resync(
    channel: string,
    options?: { reset?: boolean; topics?: string[] | 'all' },
  ): Promise<void>;
  revokeSubject(subject: string, shardKey?: string): Promise<void>;
};

type SyncEngineNamespace = {
  idFromName(name: string): unknown;
  get(id: unknown): {
    fetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response>;
  };
};

function report(metrics: SyncMetrics | undefined, metric: SyncMetric) {
  try {
    metrics?.(metric);
  } catch {
    // Observability must never change publishing behavior.
  }
}

function validEvent(event: PublishChange) {
  if (!event.channel || event.channel.length > 256)
    throw new Error('Invalid publish channel');
  if (
    !Number.isSafeInteger(event.cursor) ||
    event.cursor < 0 ||
    !Number.isSafeInteger(event.revision) ||
    event.revision < 0
  )
    throw new Error('Invalid publish cursor or revision');
  if (!event.change.key || event.change.key.length > 128)
    throw new Error('Invalid publish key');
  if (
    !parseServerMessage(
      JSON.stringify({
        type: 'change',
        channel: event.channel,
        change: event.change,
        cursor: event.cursor,
        revision: event.revision,
        v: SYNC_PROTOCOL_VERSION,
      }),
    )
  )
    throw new Error('Invalid publish change');
}

export function createSyncPublisher(options: PublisherOptions): SyncPublisher {
  const binding = options.syncEngineBinding ?? 'SYNC_ENGINE';
  const namespace = options.platform.env[binding] as
    SyncEngineNamespace | undefined;
  if (!namespace) throw new Error(`Missing ${binding} Durable Object binding`);
  const shard = (channel: string) =>
    typeof options.shard === 'function'
      ? options.shard(channel)
      : (options.shard ?? 'global');
  const send = async (path: string, channel: string, body: unknown) => {
    const shardName = shard(channel);
    if (!shardName || shardName.length > 128)
      throw new Error('Invalid sync shard');
    report(options.metrics, {
      name: 'publish',
      count: 1,
      operation: 'publish',
      channel,
    });
    report(options.metrics, {
      name: 'broker-write',
      count: 1,
      operation: 'publish',
      channel,
    });
    const response = await namespace
      .get(namespace.idFromName(shardName))
      .fetch(`https://sync.internal${path}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
      });
    if (!response.ok)
      throw new Error(`Sync publish failed (${response.status})`);
  };
  return {
    async change(event) {
      validEvent(event);
      await send('/internal/change', event.channel, event);
    },
    async changes(events) {
      if (!Array.isArray(events) || events.length < 1 || events.length > 1_000)
        throw new Error('Publish batch must contain 1 to 1000 events');
      for (const event of events) validEvent(event);
      const groups = new Map<string, PublishChange[]>();
      for (const event of events) {
        const key = shard(event.channel);
        const group = groups.get(key);
        if (group) group.push(event);
        else groups.set(key, [event]);
      }
      for (const group of groups.values())
        await send('/internal/changes', group[0]!.channel, { events: group });
    },
    async resync(channel, reset = {}) {
      if (!channel || channel.length > 256)
        throw new Error('Invalid publish channel');
      if (
        reset.topics !== undefined &&
        reset.topics !== 'all' &&
        (!Array.isArray(reset.topics) ||
          reset.topics.length > 256 ||
          reset.topics.some((topic) => !topic || topic.length > 256))
      )
        throw new Error('Invalid publish topics');
      await send('/internal/resync', channel, {
        channel,
        reset: reset.reset === true,
        topics: reset.topics ?? 'all',
      });
    },
    async revokeSubject(subject, shardKey = '') {
      if (!subject || subject.length > 256)
        throw new Error('Invalid sync subject');
      if (typeof options.shard === 'function' && !shardKey)
        throw new Error(
          'A shard key is required to revoke a subject with functional sharding',
        );
      await send('/internal/revoke', shardKey, { subject });
    },
  };
}
