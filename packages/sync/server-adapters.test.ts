import { describe, expect, it } from 'vitest';
import { handleSyncRequest } from './src/cloudflare/handler.js';
import {
  deserializeConnectionAuth,
  serializeConnectionAuth,
} from './src/server/auth.js';
import { createSyncPublisher } from './src/server/handler.js';

type RecordedRequest = {
  shard: string;
  url: string;
  body: unknown;
  authHeader: string | null;
};
function namespace(requests: RecordedRequest[], status = 204) {
  return {
    idFromName(name: string) {
      return name;
    },
    get(shard: string) {
      return {
        async fetch(input: Request | string, init?: RequestInit) {
          const request =
            input instanceof Request ? input : new Request(input, init);
          let body: unknown;
          try {
            body = await request.clone().json();
          } catch {
            body = undefined;
          }
          requests.push({
            shard,
            url: request.url,
            body,
            authHeader: request.headers.get('x-sveltebase-sync-auth'),
          });
          return new Response(status === 204 ? null : 'failed', { status });
        },
      };
    },
  } as unknown as DurableObjectNamespace;
}

describe('connection auth attachments', () => {
  it('round trips unicode separated identity, claims, topics and expiry', () => {
    const value = {
      subject: 'foydalanuvchi-🙂',
      user: { name: 'Oʻzbek' },
      claims: { role: 'admin' },
      topics: ['a', 'a', 'b'],
      expiresAt: 123,
    };
    expect(deserializeConnectionAuth(serializeConnectionAuth(value))).toEqual({
      ...value,
      topics: ['a', 'b'],
    });
  });

  it.each([null, '', 'not-base64', btoa('{}')])(
    'rejects malformed attachment %s',
    (value) => expect(deserializeConnectionAuth(value)).toBeNull(),
  );
});

describe('runtime-bound publisher', () => {
  it('publishes canonical changes, grouped batches, resets and revocations to explicit shards', async () => {
    const requests: RecordedRequest[] = [];
    const metrics: string[] = [];
    const publisher = createSyncPublisher({
      platform: { env: { SYNC_ENGINE: namespace(requests) } },
      shard: (channel) => channel.split(':')[0]!,
      metrics: (metric) => metrics.push(metric.name),
    });
    await publisher.change({
      channel: 'a:todos',
      change: { kind: 'patch', key: '1', patch: { title: 'x' } },
      cursor: 1,
      revision: 1,
    });
    await publisher.changes([
      {
        channel: 'a:todos',
        change: { kind: 'delete', key: '1' },
        cursor: 2,
        revision: 2,
      },
      {
        channel: 'b:todos',
        change: { kind: 'full', key: '2', row: { id: '2' } },
        cursor: 3,
        revision: 3,
      },
    ]);
    await publisher.resync('a:todos', { reset: true, topics: ['team:a'] });
    await publisher.revokeSubject('u1', 'a:any');
    expect(requests.map(({ shard }) => shard)).toEqual([
      'a',
      'a',
      'b',
      'a',
      'a',
    ]);
    expect(requests.map(({ url }) => new URL(url).pathname)).toEqual([
      '/internal/change',
      '/internal/changes',
      '/internal/changes',
      '/internal/resync',
      '/internal/revoke',
    ]);
    expect(metrics.filter((name) => name === 'publish')).toHaveLength(5);
  });

  it('fails closed for missing targets, bad payloads, missing shard keys and broker failures', async () => {
    expect(() => createSyncPublisher({ platform: { env: {} } })).toThrow(
      'Missing SYNC_ENGINE',
    );
    const publisher = createSyncPublisher({
      platform: { env: { SYNC_ENGINE: namespace([], 500) } },
      shard: () => 'a',
    });
    await expect(
      publisher.change({
        channel: '',
        change: { kind: 'delete', key: '1' },
        cursor: 1,
        revision: 1,
      }),
    ).rejects.toThrow('Invalid publish channel');
    await expect(publisher.changes([])).rejects.toThrow('Publish batch');
    await expect(publisher.revokeSubject('u1')).rejects.toThrow('shard key');
    await expect(publisher.resync('todos')).rejects.toThrow(
      'Sync publish failed',
    );
  });

  it('keeps publishing when a metrics hook throws', async () => {
    const requests: RecordedRequest[] = [];
    const publisher = createSyncPublisher({
      platform: { env: { SYNC_ENGINE: namespace(requests) } },
      metrics: () => {
        throw new Error('metrics unavailable');
      },
    });
    await publisher.change({
      channel: 'todos',
      change: { kind: 'delete', key: '1' },
      cursor: 1,
      revision: 1,
    });
    expect(requests).toHaveLength(1);
  });
});

describe('Cloudflare websocket gateway', () => {
  it('strips spoofed auth, preserves separated auth, resolves topics and selects a shard', async () => {
    const requests: RecordedRequest[] = [];
    const binding = namespace(requests);
    const req = new Request('https://app.test/api/sync');
    req.headers.set('upgrade', 'websocket');
    req.headers.set('origin', 'https://trusted.test');
    req.headers.set(
      'x-sveltebase-sync-auth',
      serializeConnectionAuth({ subject: 'attacker', user: {}, topics: [] }),
    );
    const response = await handleSyncRequest(
      req,
      { SYNC_ENGINE: binding },
      {
        waitUntil() {},
        passThroughOnException() {},
      } as unknown as ExecutionContext,
      {
        handlers: [],
        trustedOrigins: ['https://trusted.test'],
        auth: () => ({
          subject: 'real',
          user: { id: 'real' },
          claims: { role: 'member' },
          expiresAt: Date.now() + 1_000,
        }),
        topics: () => ['team:a'],
        shard: ({ auth }) => auth!.subject,
      },
    );
    expect(response.status).toBe(204);
    expect(requests[0]).toMatchObject({
      shard: 'real',
      url: 'https://app.test/internal/websocket',
    });
    expect(deserializeConnectionAuth(requests[0]!.authHeader)).toMatchObject({
      subject: 'real',
      topics: ['subject:real', 'team:a'],
    });
  });

  it('returns generic authentication failures', async () => {
    const context = {
      waitUntil() {},
      passThroughOnException() {},
    } as unknown as ExecutionContext;
    const make = () => {
      const request = new Request('https://app.test/api/sync');
      request.headers.set('upgrade', 'websocket');
      return request;
    };
    expect(
      (
        await handleSyncRequest(make(), {}, context, {
          handlers: [],
          auth: () => {
            throw new Error('secret');
          },
        })
      ).status,
    ).toBe(401);
    expect(
      (
        await handleSyncRequest(make(), {}, context, {
          handlers: [],
          auth: () => ({ subject: 'u', user: {}, expiresAt: 1 }),
        })
      ).status,
    ).toBe(401);
    expect(
      (
        await handleSyncRequest(make(), {}, context, {
          handlers: [],
          auth: () => ({ subject: 'u', user: {} }),
          topics: () => {
            throw new Error('db');
          },
        })
      ).status,
    ).toBe(401);
  });

  it('keeps forwarding when connection metrics throw', async () => {
    const requests: RecordedRequest[] = [];
    const req = new Request('https://app.test/api/sync');
    req.headers.set('upgrade', 'websocket');
    const response = await handleSyncRequest(
      req,
      { SYNC_ENGINE: namespace(requests) },
      {
        waitUntil() {},
        passThroughOnException() {},
      } as unknown as ExecutionContext,
      {
        handlers: [],
        auth: () => ({ subject: 'u', user: {} }),
        metrics: () => {
          throw new Error('metrics unavailable');
        },
      },
    );
    expect(response.status).toBe(204);
    expect(requests).toHaveLength(1);
  });
});
