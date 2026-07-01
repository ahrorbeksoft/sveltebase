import type { SyncClient } from "@sveltebase/sync/client";
import { liveQuery } from "dexie";

/**
 * Value or getter used to keep auth state connected to SvelteKit load data.
 */
export type MaybeGetter<T> = T | (() => T);

/**
 * Client-side auth state options.
 */
export interface AuthClientConfig {
  /**
   * The Svelteflare Sync client instance.
   * If provided, session verification will run automatically over the WebSocket connection.
   */
  syncClient?: SyncClient<any>;
  /**
   * Sync table used to verify the current session after SSR.
   * @default "users"
   */
  verifyTable?: string;
  /**
   * App-specific comparison for deciding if a synced verify row belongs to
   * the current session user.
   */
  verifyUser?: (sessionUser: any, syncedUser: any) => boolean;
  /**
   * Base path for auth route handlers.
   * @default "/api/auth"
   */
  routesBase?: string;
  /**
   * Called when the verification table subscription fails.
   */
  onInvalidSession?: () => void | Promise<void>;
  /**
   * Refresh the HTTP-only session cookie when the synced user row changes.
   */
  refreshWhenChanged?: boolean | ((sessionUser: any, syncedUser: any) => boolean);
}

/**
 * Clears every local sync table after logout or invalid session detection.
 *
 * This prevents user-specific IndexedDB rows from remaining visible after the
 * session cookie has become invalid.
 */
async function clearSyncData(sync: SyncClient<any>) {
  if (sync && typeof sync.tables !== "undefined") {
    try {
      await Promise.all(sync.tables.map((table: any) => table.clear()));
    } catch (err) {
      console.error("Failed to clear local database tables", err);
    }
  }
}

/**
 * Svelte-reactive client auth state.
 *
 * It mirrors the server-provided user, supports login/logout routes, and can
 * verify the session against a synced user table after SSR hydration.
 */
export class AuthClientState<User extends { id: string }> {
  #userGetter = $state<MaybeGetter<User | null>>(null);
  #localOverride = $state<User | null | undefined>(undefined);
  #syncClient?: SyncClient<any>;
  #verifySubscription?: { unsubscribe(): void };
  #verifyTable: string;
  #routesBase: string;
  #onInvalidSession?: () => void | Promise<void>;
  #refreshWhenChanged?: boolean | ((sessionUser: User, syncedUser: User) => boolean);
  #verifyUser: (sessionUser: User, syncedUser: any) => boolean;
  #isVerifying = false;
  #verificationReady = false;

  /**
   * Creates client auth state.
   *
   * Pass a `SyncClient` when the app should verify the cookie session against a
   * synced user row and clear local data when that row disappears.
   */
  constructor(config?: AuthClientConfig) {
    this.#syncClient = config?.syncClient;
    this.#verifyTable = config?.verifyTable ?? "users";
    this.#routesBase = config?.routesBase ?? "/api/auth";
    this.#onInvalidSession = config?.onInvalidSession;
    this.#refreshWhenChanged = config?.refreshWhenChanged;
    this.#verifyUser = config?.verifyUser ?? ((sessionUser, syncedUser) => {
      return String(sessionUser.id) === String(syncedUser?.id);
    });
  }

  /**
   * Gets the current reactive user object.
   *
   * If `init` received a getter, the getter is evaluated so Svelte can track the
   * same data value that came from the server load function.
   */
  get user(): User | null {
    if (this.#localOverride !== undefined) {
      return this.#localOverride;
    }
    const val = this.#userGetter;
    return typeof val === "function" ? (val as () => User | null)() : val;
  }

  /**
   * Overrides the current reactive user object.
   *
   * Login, refresh, logout, and invalid-session handling use this to reflect
   * client-side changes before the next server load.
   */
  set user(value: User | null) {
    this.#localOverride = value;
  }

  /**
   * True when `user` is not `null`.
   */
  get isAuthenticated(): boolean {
    return this.user !== null;
  }

  /**
   * Initializes the client-side user state.
   * Accepts a static user object or a getter function (e.g. `() => data.user`).
   *
   * Call this once from a root component or layout effect after receiving the
   * server session user from SvelteKit load data.
   */
  init(user: MaybeGetter<User | null>) {
    this.#userGetter = user;
    this.#localOverride = undefined; // Reset local override on new init

    // Reactive effect to reset local override whenever the server's user getter updates
    $effect(() => {
      // Access the getter reactively so Svelte tracks this dependency
      const serverUser = typeof this.#userGetter === "function"
        ? (this.#userGetter as () => User | null)()
        : this.#userGetter;

      // Clear any local override (like query error overrides) whenever the server session changes
      this.#localOverride = undefined;
    });

    // Set up the verification table subscription if syncClient is provided and not already initialized.
    if (this.#syncClient && !this.#verifySubscription) {
      const sync = this.#syncClient;
      const observable = liveQuery(() => sync.table(this.#verifyTable).toArray());
      this.#verifySubscription = observable.subscribe({
        next: (rows) => {
          const activeUser = this.user;
          if (!activeUser || this.#isVerifying || !this.#verificationReady) return;
          const syncedUser = rows.find((row: User) => this.#verifyUser(activeUser, row));
          if (!syncedUser) {
            this.handleInvalidSession();
            return;
          }

          if (!this.#refreshWhenChanged) return;

          const shouldRefresh =
            this.#refreshWhenChanged === true
              ? JSON.stringify(activeUser) !== JSON.stringify(syncedUser)
              : this.#refreshWhenChanged(activeUser, syncedUser);
          if (shouldRefresh) {
            this.refresh().catch((err) => {
              console.warn("Failed to refresh auth session after sync change.", err);
            });
          }
        },
        error: (err) => {
          console.warn("WebSocket session verification failed: logging out.", err);
          this.handleInvalidSession();
          clearSyncData(sync);
        }
      });
    }
  }

  /**
   * Resyncs the verification table and confirms the session user still exists.
   *
   * This is called after login, Google login, and refresh. If the synced user
   * cannot be found, the client treats the cookie as invalid and clears local
   * sync data.
   */
  private async verifySyncedUser(
    user: User | null,
    options?: { reconnect?: boolean },
  ): Promise<User | null> {
    if (!user || !this.#syncClient) return user;
    const resyncTable = (this.#syncClient as any).resyncTable as
      | ((tableName: string, options?: { reconnect?: boolean }) => Promise<any[]>)
      | undefined;
    if (!resyncTable) return user;

    this.#isVerifying = true;
    try {
      const rows = await resyncTable.call(
        this.#syncClient,
        this.#verifyTable,
        options,
      );
      const syncedUser = rows.find((row) => this.#verifyUser(user, row));
      if (!syncedUser) {
        await this.handleInvalidSession();
        return null;
      }
      this.#verificationReady = true;
      return syncedUser as User;
    } finally {
      this.#isVerifying = false;
    }
  }

  /**
   * Marks the session invalid, runs the optional hook, and clears sync caches.
   */
  private async handleInvalidSession() {
    this.#localOverride = null;
    const invalid = this.#onInvalidSession?.();
    if (invalid && typeof invalid.then === "function") {
      await invalid.catch((hookErr) => {
        console.error("onInvalidSession hook failed", hookErr);
      });
    }
    this.#verificationReady = false;
    if (this.#syncClient) {
      await clearSyncData(this.#syncClient);
    }
  }

  /**
   * Calls the configured login route and stores the returned app user.
   *
   * After a successful response, the sync client is reconnected and the verify
   * table is resynced so stale local data cannot keep an invalid session alive.
   *
   * @param body JSON body sent to `${routesBase}/login`.
   */
  async login<Body = unknown>(body: Body): Promise<User> {
    const response = await fetch(`${this.#routesBase}/login`, {
      method: "POST",
      body: JSON.stringify(body),
      headers: { "Content-Type": "application/json" },
    });
    if (!response.ok) {
      throw new Error(await response.text());
    }

    const user = await response.json() as User;
    this.#localOverride = user;
    const verifiedUser = await this.verifySyncedUser(user, { reconnect: true });
    if (!verifiedUser) {
      throw new Error("Invalid session");
    }
    return verifiedUser;
  }

  /**
   * Calls the configured Google auth route with a Google credential.
   *
   * The credential is the ID token returned by Google Identity Services.
   */
  async loginWithGoogle(credential: string): Promise<User | null> {
    const response = await fetch(`${this.#routesBase}/google`, {
      method: "POST",
      body: JSON.stringify({ credential }),
      headers: { "Content-Type": "application/json" },
    });
    if (!response.ok) {
      throw new Error(await response.text());
    }

    if (response.status === 204) {
      await this.refresh();
      return this.user;
    }

    const user = await response.json() as User;
    this.#localOverride = user;
    return await this.verifySyncedUser(user, { reconnect: true });
  }

  /**
   * Verifies the current cookie server-side and rewrites it with a fresh user object.
   *
   * Called manually by apps and automatically when `refreshWhenChanged` decides
   * the synced user row no longer matches the cookie snapshot.
   */
  async refresh(): Promise<User | null> {
    const response = await fetch(`${this.#routesBase}/refresh`, { method: "POST" });
    if (response.status === 401) {
      this.#localOverride = null;
      await this.#onInvalidSession?.();
      return null;
    }
    if (!response.ok) {
      throw new Error(await response.text());
    }

    if (response.status === 204) {
      return this.user;
    }

    const user = await response.json() as User;
    this.#localOverride = user;
    return await this.verifySyncedUser(user);
  }

  /**
   * Clears client state, calls the server logout endpoint to delete cookies, and wipes local IndexedDB caches.
   *
   * Network failures during the logout fetch are ignored because the local app
   * should still leave the authenticated state immediately.
   */
  async logout() {
    this.#localOverride = null;
    try {
      await fetch(`${this.#routesBase}/logout`, { method: "POST" });
    } catch {
      // Ignore network failure on logout fetch
    }
    if (this.#syncClient) {
      clearSyncData(this.#syncClient);
    }
  }
}

/**
 * Creates client-side reactive auth state.
 *
 * @example
 * ```ts
 * export const auth = createAuth<User>({ syncClient: db });
 * auth.init(() => data.user);
 * ```
 */
export function createAuth<User extends { id: string }>(config?: AuthClientConfig): AuthClientState<User> {
  return new AuthClientState<User>(config);
}
