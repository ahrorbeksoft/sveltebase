import { describe, expect, it } from 'vitest';
import { SyncClient, type SyncAction } from '../src/client/index.js';
import type { SocketLike } from '../src/client/transport.js';

type Row = { id: string; value: number; version: number };
type Intent = {
  id: string;
  sequence: number;
  action: SyncAction;
  key: string;
  data?: Partial<Row>;
  accepted?: boolean;
  canonical?: Row;
};
type SocketEvent = { data?: unknown };

class ModelSocket implements SocketLike {
  readyState = 0;
  readonly sent: Array<Record<string, unknown>> = [];
  readonly #listeners = new Map<string, Set<(event: SocketEvent) => void>>();

  constructor(
    private readonly rows: Row[],
    private readonly cursor: number,
  ) {
    queueMicrotask(() => this.#open());
  }

  addEventListener(type: string, listener: (event: SocketEvent) => void) {
    const listeners = this.#listeners.get(type) ?? new Set();
    listeners.add(listener);
    this.#listeners.set(type, listeners);
  }

  removeEventListener(type: string, listener: (event: SocketEvent) => void) {
    this.#listeners.get(type)?.delete(listener);
  }

  send(data: string) {
    const message = JSON.parse(data) as Record<string, unknown>;
    this.sent.push(message);
    if (message.type === 'subscribe') {
      queueMicrotask(() =>
        this.reply({
          type: 'snapshot',
          requestId: message.requestId,
          channel: message.channel,
          mode: 'full',
          rows: this.rows,
          cursor: this.cursor,
          viewVersion: 'model-v1',
        }),
      );
    }
  }

  close() {
    if (this.readyState === 3) return;
    this.readyState = 3;
    this.#emit('close', {});
  }

  reply(message: Record<string, unknown>) {
    this.#emit('message', { data: JSON.stringify({ v: 1, ...message }) });
  }

  #open() {
    if (this.readyState !== 0) return;
    this.readyState = 1;
    this.#emit('open', {});
  }

  #emit(type: string, event: SocketEvent) {
    for (const listener of this.#listeners.get(type) ?? []) listener(event);
  }
}

function mulberry32(seed: number) {
  return () => {
    let value = (seed += 0x6d2b79f5);
    value = Math.imul(value ^ (value >>> 15), value | 1);
    value ^= value + Math.imul(value ^ (value >>> 7), value | 61);
    return ((value ^ (value >>> 14)) >>> 0) / 4_294_967_296;
  };
}

function shuffle<T>(values: T[], random: () => number) {
  const result = [...values];
  for (let index = result.length - 1; index > 0; index--) {
    const other = Math.floor(random() * (index + 1));
    [result[index], result[other]] = [result[other], result[index]];
  }
  return result;
}

async function waitUntil(
  predicate: () => boolean | Promise<boolean>,
  turns = 2_000,
) {
  for (let turn = 0; turn < turns; turn++) {
    if (await predicate()) return;
    await new Promise<void>((resolve) => setImmediate(resolve));
  }
  throw new Error('Deterministic operation did not settle');
}

function sorted(rows: Iterable<Row>) {
  return [...rows].sort((left, right) => left.id.localeCompare(right.id));
}

function applyModel(
  rows: Map<string, Row>,
  intent: Pick<Intent, 'action' | 'key' | 'data'>,
) {
  if (intent.action === 'delete') {
    rows.delete(intent.key);
  } else if (intent.action === 'create') {
    rows.set(intent.key, intent.data as Row);
  } else {
    const previous = rows.get(intent.key);
    if (previous)
      rows.set(intent.key, { ...previous, ...intent.data, id: intent.key });
  }
}

describe('SyncClient seeded storage model', () => {
  it('converges across offline intent, reload, reordered outcomes, and a second reload', async () => {
    const random = mulberry32(0x5e17ba5e);
    const databaseName = `sync-model-${crypto.randomUUID()}`;
    const baseRows = Array.from({ length: 8 }, (_, index): Row => ({
      id: `row-${index}`,
      value: index,
      version: 0,
    }));
    const options = {
      name: databaseName,
      accountId: 'model-subject',
      url: 'ws://model.test',
      autoStart: false as const,
      tables: { rows: { indexes: 'id, version', channel: 'rows' } },
    };

    const seedClient = new SyncClient<{ rows: Row }>({
      ...options,
      transport: { socketFactory: () => new ModelSocket(baseRows, 1) },
    });
    await seedClient.start();
    await seedClient.resyncChannel('rows');
    seedClient.stop();

    const visible = new Map(baseRows.map((row) => [row.id, row]));
    const intents: Intent[] = [];
    for (let operation = 0; operation < 100; operation++) {
      const present = [...visible.keys()];
      const absent = Array.from(
        { length: 32 },
        (_, index) => `row-${index}`,
      ).filter((id) => !visible.has(id));
      const choice = random();
      if (present.length === 0 || (choice < 0.34 && absent.length > 0)) {
        const key = absent[Math.floor(random() * absent.length)];
        const data: Row = {
          id: key,
          value: Math.floor(random() * 10_000),
          version: operation + 1,
        };
        const receipt = await seedClient.create('rows', data);
        const intent: Intent = {
          id: receipt.id,
          sequence: receipt.sequence,
          action: 'create',
          key,
          data,
        };
        intents.push(intent);
        applyModel(visible, intent);
      } else {
        const key = present[Math.floor(random() * present.length)];
        if (choice < 0.78) {
          const data = {
            value: Math.floor(random() * 10_000),
            version: operation + 1,
          };
          const receipt = await seedClient.update('rows', key, data);
          const intent: Intent = {
            id: receipt.id,
            sequence: receipt.sequence,
            action: 'update',
            key,
            data,
          };
          intents.push(intent);
          applyModel(visible, intent);
        } else {
          const receipt = await seedClient.delete('rows', key);
          const intent: Intent = {
            id: receipt.id,
            sequence: receipt.sequence,
            action: 'delete',
            key,
          };
          intents.push(intent);
          applyModel(visible, intent);
        }
      }
    }
    expect(intents).toHaveLength(100);
    expect(new Set(intents.map((intent) => intent.action))).toEqual(
      new Set(['create', 'update', 'delete']),
    );
    expect(await seedClient.read('rows').toArray()).toEqual(
      sorted(visible.values()),
    );
    seedClient.dispose();

    const firstReload = new SyncClient<{ rows: Row }>({ ...options });
    expect(await firstReload.read('rows').toArray()).toEqual(
      sorted(visible.values()),
    );
    firstReload.dispose();

    const server = new Map(baseRows.map((row) => [row.id, row]));
    for (const intent of intents) {
      const valid =
        intent.action === 'create'
          ? !server.has(intent.key)
          : server.has(intent.key);
      intent.accepted = valid && random() >= 0.27;
      if (!intent.accepted) continue;
      applyModel(server, intent);
      intent.canonical = server.get(intent.key);
    }
    expect(intents.filter((intent) => intent.accepted).length).toBeGreaterThan(
      20,
    );
    expect(intents.filter((intent) => !intent.accepted).length).toBeGreaterThan(
      20,
    );
    const finalRows = sorted(server.values());
    const outcomeOrder = shuffle(intents, random);

    let firstSocket!: ModelSocket;
    const draining = new SyncClient<{ rows: Row }>({
      ...options,
      transport: {
        socketFactory: () => (firstSocket = new ModelSocket(baseRows, 1)),
      },
    });
    await draining.start();
    await draining.resyncChannel('rows');
    await waitUntil(
      () =>
        firstSocket.sent.filter((message) => message.type === 'mutate')
          .length === 100,
    );

    const halfway = outcomeOrder.slice(0, 50);
    for (const intent of halfway) {
      firstSocket.reply(
        intent.accepted
          ? {
              type: 'ack',
              id: intent.id,
              data: intent.canonical,
              cursor: intent.sequence + 1,
              revision: intent.sequence + 1,
            }
          : {
              type: 'reject',
              id: intent.id,
              error: { code: 'model_reject', message: 'seeded rejection' },
            },
      );
    }
    await waitUntil(() => draining.pendingMutationCount === 50);
    draining.dispose();

    let replaySocket!: ModelSocket;
    const replay = new SyncClient<{ rows: Row }>({
      ...options,
      transport: {
        socketFactory: () =>
          (replaySocket = new ModelSocket(finalRows, 10_000)),
      },
    });
    await replay.start();
    await replay.resyncChannel('rows');
    await waitUntil(
      () =>
        replaySocket.sent.filter((message) => message.type === 'mutate')
          .length === 50,
    );

    for (const intent of outcomeOrder.slice(50)) {
      replaySocket.reply(
        intent.accepted
          ? {
              type: 'ack',
              id: intent.id,
              data: intent.canonical,
              cursor: 10_000,
              revision: intent.sequence + 1,
            }
          : {
              type: 'reject',
              id: intent.id,
              error: { code: 'model_reject', message: 'seeded rejection' },
            },
      );
    }
    await waitUntil(() => replay.pendingMutationCount === 0);
    expect(await replay.read('rows').toArray()).toEqual(finalRows);
    await replay.purge();
  });
});
