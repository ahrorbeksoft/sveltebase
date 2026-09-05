import type {
  AuthClientConfig,
  AuthSyncAdapter,
} from '../../packages/auth/src/client/auth.svelte.js';
import type { AuthSession } from '../../packages/auth/src/core/session.js';
import type { SyncClient } from '../../packages/sync/src/client/sync-client.svelte.js';

type User = {
  id: string;
  email: string;
};

type Claims = {
  activeRoleId: string;
};

type Todo = {
  id: string;
  title: string;
  completed: boolean;
};

type Schema = {
  todos: Todo;
};

/**
 * Compile-only public-contract checks. This function is never invoked.
 * It protects generic table mutation types and auth's identity/claim split.
 */
export function assertPublicTypeContracts(
  client: SyncClient<Schema>,
  session: AuthSession<User, Claims>,
): void {
  void client.create('todos', {
    id: 'todo-1',
    title: 'Write regression tests',
    completed: false,
  });
  void client.update('todos', 'todo-1', { completed: true });

  // @ts-expect-error Unknown table names cannot be mutated.
  void client.create('users', { id: 'user-1' });
  // @ts-expect-error A create must satisfy the complete row contract.
  void client.create('todos', { id: 'todo-1', title: 'Missing completion' });
  // @ts-expect-error Patch values must use the table field type.
  void client.update('todos', 'todo-1', { completed: 'yes' });
  // @ts-expect-error Update table names are constrained independently too.
  void client.update('accounts', 'account-1', {});

  const subject: string = session.subject;
  const email: string = session.user.email;
  const activeRoleId: string = session.claims.activeRoleId;
  void subject;
  void email;
  void activeRoleId;

  // @ts-expect-error Claims must not be used as the authenticated profile.
  const profile: User = session.claims;
  // @ts-expect-error Profile fields do not become authorization claims.
  const roleFromProfile: string = session.user.activeRoleId;
  void profile;
  void roleFromProfile;

  const adapter: AuthSyncAdapter<User, Claims> = {
    start(next) {
      const nextSubject: string = next.subject;
      const nextEmail: string = next.user.email;
      const nextRole: string = next.claims.activeRoleId;
      void nextSubject;
      void nextEmail;
      void nextRole;
    },
  };
  const withOptionalSync: AuthClientConfig<User, Claims> = { sync: adapter };
  const withoutSync: AuthClientConfig<User, Claims> = {};
  void withOptionalSync;
  void withoutSync;

  const invalidAdapter: AuthSyncAdapter<User, Claims> = {
    // @ts-expect-error Sync startup receives a session, never a flattened user.
    start: (next: User) => next.email,
  };
  void invalidAdapter;
}
