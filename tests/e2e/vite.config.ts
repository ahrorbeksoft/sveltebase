import { defineConfig, type Plugin } from 'vite';
import { svelte } from '@sveltejs/vite-plugin-svelte';
import { WebSocketServer } from 'ws';
import {
  SyncBroker,
  type ISyncConnection,
} from '../../packages/sync/src/server/broker.js';
import {
  defineSync,
  type SyncConnectionAuth,
  type MutationOutcome,
} from '../../packages/sync/src/server/index.js';
import { SerializableError } from '../../packages/sync/src/errors.js';
import { createServerAuth } from '../../packages/auth/src/server/index.js';
import { createAuthRoutes } from '../../packages/auth/src/sveltekit/index.js';
import { getSessionFromRequest } from '../../packages/auth/src/index.js';
import type { RequestEvent } from '@sveltejs/kit';

type Row = { id: string; title: string };
type Store = {
  rows: Map<string, Row>;
  revision: number;
  log: MutationOutcome<Row>[];
};
function fixture(): Plugin {
  const stores = new Map<string, Store>();
  const outcomes = new Map<string, unknown>();
  let writes = 0;
  let chain = Promise.resolve();
  const getStore = (subject: string) => {
    let store = stores.get(subject);
    if (!store) {
      store = { rows: new Map(), revision: 0, log: [] };
      stores.set(subject, store);
    }
    return store;
  };
  const handler = defineSync<Row>({
    channel: 'rows',
    broadcast: 'scoped',
    broadcastTopics: (ctx) => [ctx.subject!],
    snapshot: async (ctx, request) => {
      const state = getStore(ctx.subject!);
      if (
        !request.forceFull &&
        request.cursor !== undefined &&
        request.cursor <= state.revision
      )
        return {
          mode: 'delta',
          rows: [],
          events: state.log
            .filter((event) => event.cursor > request.cursor!)
            .slice(0, request.limit)
            .map((event) => event.change),
          cursor: state.revision,
        };
      return {
        mode: 'full',
        rows: [...state.rows.values()],
        cursor: state.revision,
      };
    },
    idempotency: {
      async execute(ctx, key, perform) {
        const previous = chain;
        let release!: () => void;
        chain = new Promise<void>((resolve) => {
          release = resolve;
        });
        await previous;
        try {
          const id = JSON.stringify(key);
          if (outcomes.has(id))
            return {
              replayed: true,
              outcome: outcomes.get(id) as Awaited<ReturnType<typeof perform>>,
            };
          const draft = structuredClone(getStore(ctx.subject!));
          const outcome = await perform(draft);
          stores.set(ctx.subject!, draft);
          outcomes.set(id, outcome);
          writes++;
          return { replayed: false, outcome };
        } finally {
          release();
        }
      },
    },
    mutate: async (ctx, mutation) => {
      const state = ctx.transaction as Store;
      const data = mutation.data as Row | undefined;
      if (data?.title === 'forbidden')
        throw new SerializableError('Edit rejected', 'Forbidden');
      const key = mutation.key ?? data?.id;
      if (!key) throw new SerializableError('Missing key');
      const revision = ++state.revision;
      let outcome: MutationOutcome<Row>;
      if (mutation.action === 'delete') {
        state.rows.delete(key);
        outcome = {
          change: { kind: 'delete', key },
          cursor: revision,
          revision,
        };
      } else {
        const row =
          mutation.action === 'create'
            ? data!
            : { ...state.rows.get(key)!, ...data, id: key };
        state.rows.set(key, row);
        outcome = {
          data: row,
          change: { kind: 'full', key, row },
          cursor: revision,
          revision,
        };
      }
      state.log.push(outcome);
      return outcome;
    },
  });
  const broker = new SyncBroker([handler]);
  const secret = 'fixture-secret-only-never-deploy-this-test-server';
  const auth = createServerAuth<{ id: string }>({
    secret,
    cookieOptions: { secure: false },
  });
  const routes = createAuthRoutes({
    auth,
    login: (body: unknown) => {
      if (
        !body ||
        typeof body !== 'object' ||
        !('id' in body) ||
        typeof body.id !== 'string' ||
        !body.id
      )
        throw new Error('Invalid fixture user');
      return { id: body.id };
    },
    getUser: (subject) => ({ id: subject }),
  });
  return {
    name: 'sveltebase-integration-fixture',
    configureServer(server) {
      const sockets = new WebSocketServer({ noServer: true });
      server.httpServer!.on('upgrade', async (req, socket, head) => {
        if (req.url !== '/socket') return;
        const url = `http://${req.headers.host}${req.url}`;
        const request = new Request(url, {
          headers: new Headers(req.headers as Record<string, string>),
        });
        const session = await getSessionFromRequest<{ id: string }>(
          request,
          secret,
        );
        if (!session || req.headers.origin !== new URL(url).origin) {
          socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n');
          socket.destroy();
          return;
        }
        sockets.handleUpgrade(req, socket, head, (ws) => {
          let connectionAuth: SyncConnectionAuth | null = {
            ...session,
            topics: [session.subject],
            expiresAt: Date.now() + 60_000,
          };
          const channels = new Set<string>();
          const connection: ISyncConnection = {
            send: (data) => ws.send(data),
            close: (code, reason) => ws.close(code, reason),
            headers: request.headers,
            url,
            getConnectionAuth: () => connectionAuth,
            setConnectionAuth: (next) => {
              connectionAuth = next;
            },
            getSubscribedChannels: () => channels,
          };
          broker.registerConnection(connection);
          ws.on('message', (raw) => {
            void broker.handleMessage(
              connection,
              raw.toString(),
              { env: {} },
              request,
            );
          });
          ws.on('close', () => broker.removeConnection(connection));
        });
      });
      server.httpServer!.on('close', () => sockets.close());
      server.middlewares.use(async (req, res, next) => {
        if (req.url === '/') {
          req.url = '/tests/e2e/fixture/index.html';
          next();
          return;
        }
        if (req.url === '/metrics') {
          res.setHeader('Content-Type', 'application/json');
          res.end(JSON.stringify({ writes }));
          return;
        }
        if (!req.url?.startsWith('/api/auth/')) {
          next();
          return;
        }
        const chunks: Buffer[] = [];
        for await (const chunk of req) chunks.push(Buffer.from(chunk));
        const url = new URL(req.url, `http://${req.headers.host}`);
        const request = new Request(url, {
          method: req.method,
          headers: new Headers(req.headers as Record<string, string>),
          ...(chunks.length ? { body: Buffer.concat(chunks) } : {}),
        });
        const parsed = new Map(
          (req.headers.cookie ?? '').split(';').map((part) => {
            const at = part.indexOf('=');
            return [
              part.slice(0, at).trim(),
              decodeURIComponent(part.slice(at + 1)),
            ];
          }),
        );
        const cookies = {
          get: (name: string) => parsed.get(name),
          set: (
            name: string,
            value: string,
            options: { path?: string; maxAge?: number },
          ) => {
            res.setHeader(
              'Set-Cookie',
              `${name}=${encodeURIComponent(value)}; Path=${options.path ?? '/'}; HttpOnly; SameSite=Lax${options.maxAge === undefined ? '' : `; Max-Age=${options.maxAge}`}`,
            );
          },
          delete: (name: string, options: { path?: string }) => {
            res.setHeader(
              'Set-Cookie',
              `${name}=; Path=${options.path ?? '/'}; Max-Age=0`,
            );
          },
        };
        const response = await routes.POST({
          request,
          url,
          cookies,
          params: { auth: url.pathname.split('/').at(-1) },
        } as unknown as RequestEvent);
        res.statusCode = response.status;
        response.headers.forEach((value, key) => res.setHeader(key, value));
        res.end(await response.text());
      });
    },
  };
}
export default defineConfig({
  plugins: [svelte({ configFile: false }), fixture()],
  server: { host: '127.0.0.1', port: 4174, strictPort: true },
});
