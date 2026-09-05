import { SyncClient } from '../../../packages/sync/src/client/index.js';
import { createAuth } from '../../../packages/auth/src/client/index.js';

type Row = { id: string; title: string };
let client: SyncClient<{ rows: Row }> | undefined;
let integratedName: string | undefined;
const integrationErrors: string[] = [];
const auth = createAuth<{ id: string }>({
  sync: {
    stop: () => client?.stop(),
    purgeAccount: async (subject) => {
      if (integratedName && client) await client.purgeAccount(subject);
    },
    start: async (session) => {
      if (integratedName) await harness.open(integratedName, session.subject);
    },
    getConnectivity: () => client?.status ?? 'stopped',
  },
  onIntegrationError: (error) => integrationErrors.push(String(error)),
});
auth.init(null);
const confirmations = new Map<string, Promise<unknown>>();
const harness = {
  async integrated(name: string, id: string) {
    integratedName = name;
    return auth.login({ id });
  },
  connection() {
    return {
      account: client?.accountId,
      status: client?.status,
      database: client?.databaseName,
      errors: integrationErrors,
    };
  },
  async login(id: string) {
    return auth.login({ id });
  },
  async logout() {
    await auth.logout();
  },
  session() {
    return auth.session;
  },
  async open(name: string, accountId: string) {
    client?.dispose();
    client = new SyncClient<{ rows: Row }>({
      name,
      accountId,
      url: '/socket',
      autoStart: false,
      tables: { rows: { indexes: 'id', channel: 'rows' } },
      transport: { minReconnectMs: 50, maxReconnectMs: 100 },
    });
    await client.start();
    await client.resyncTable('rows');
  },
  async connect() {
    await client!.start();
    await client!.resyncTable('rows');
  },
  stop() {
    client!.stop();
  },
  async create(row: Row) {
    const receipt = await client!.create('rows', row);
    confirmations.set(receipt.id, receipt.confirmed);
    receipt.confirmed.catch(() => undefined);
    return receipt.id;
  },
  async update(id: string, title: string) {
    const receipt = await client!.update('rows', id, { title });
    confirmations.set(receipt.id, receipt.confirmed);
    receipt.confirmed.catch(() => undefined);
    return receipt.id;
  },
  async remove(id: string) {
    const receipt = await client!.delete('rows', id);
    confirmations.set(receipt.id, receipt.confirmed);
    receipt.confirmed.catch(() => undefined);
    return receipt.id;
  },
  async confirmed(id: string) {
    try {
      await confirmations.get(id);
      return 'accepted';
    } catch {
      return 'rejected';
    }
  },
  rows() {
    return client!.read('rows').toArray();
  },
  pending() {
    return client!.pendingMutationCount;
  },
};
Object.assign(window, { harness });
export type Harness = typeof harness;
