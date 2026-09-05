import { DurableObject } from 'cloudflare:workers';
import { createSyncEngine } from '../../src/cloudflare/index.js';
import { defineSync } from '../../src/server/index.js';

const handler = defineSync({
  channel: 'todos',
  broadcast: 'scoped',
  broadcastTopics: () => ['team:a'],
  snapshot: async () => ({
    mode: 'full',
    rows: [{ id: 'initial', title: 'Initial' }],
    cursor: 1,
  }),
});

export const SyncEngine = createSyncEngine([handler]);
export class TransactionEngine extends DurableObject {
  constructor(ctx: DurableObjectState, env: unknown) {
    super(ctx, env);
    this.ctx.storage.sql.exec(
      'CREATE TABLE IF NOT EXISTS domain_state (singleton INTEGER PRIMARY KEY, writes INTEGER NOT NULL)',
    );
    this.ctx.storage.sql.exec(
      'INSERT OR IGNORE INTO domain_state (singleton, writes) VALUES (1, 0)',
    );
    this.ctx.storage.sql.exec(
      'CREATE TABLE IF NOT EXISTS outcomes (mutation_key TEXT PRIMARY KEY, domain_writes INTEGER NOT NULL)',
    );
  }
  async fetch(request: Request) {
    const url = new URL(request.url);
    if (url.pathname === '/state')
      return Response.json({
        domainWrites: this.ctx.storage.sql
          .exec<{ writes: number }>(
            'SELECT writes FROM domain_state WHERE singleton = 1',
          )
          .one().writes,
      });
    const input = (await request.json()) as {
      subject: string;
      channel: string;
      mutationId: string;
      fail?: boolean;
    };
    const key = `outcome:${input.subject}:${input.channel}:${input.mutationId}`;
    const metrics = {
      sourceReads: 0,
      sourceWrites: 0,
      brokerReads: 0,
      brokerWrites: 0,
      transactionAttempts: 1,
    };
    try {
      const result = this.ctx.storage.transactionSync(() => {
        metrics.brokerReads++;
        const recorded = this.ctx.storage.sql
          .exec<{ domain_writes: number }>(
            'SELECT domain_writes FROM outcomes WHERE mutation_key = ?',
            key,
          )
          .toArray()[0];
        if (recorded)
          return {
            replayed: true,
            outcome: { domainWrites: recorded.domain_writes },
          };
        metrics.sourceReads++;
        const domainWrites = this.ctx.storage.sql
          .exec<{ writes: number }>(
            'SELECT writes FROM domain_state WHERE singleton = 1',
          )
          .one().writes;
        metrics.sourceWrites++;
        this.ctx.storage.sql.exec(
          'UPDATE domain_state SET writes = ? WHERE singleton = 1',
          domainWrites + 1,
        );
        if (input.fail) throw new Error('crash-before-outcome');
        const outcome = { domainWrites: domainWrites + 1 };
        metrics.brokerWrites++;
        this.ctx.storage.sql.exec(
          'INSERT INTO outcomes (mutation_key, domain_writes) VALUES (?, ?)',
          key,
          outcome.domainWrites,
        );
        return { replayed: false, outcome };
      });
      return Response.json({ ...result, metrics });
    } catch {
      return Response.json(
        { error: 'transaction-rolled-back', metrics },
        { status: 409 },
      );
    }
  }
}
export default {
  fetch() {
    return new Response('ok');
  },
};
