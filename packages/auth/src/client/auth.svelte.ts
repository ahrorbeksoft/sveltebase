import type { SyncClient } from "@sveltebase/sync/client";
import { liveQuery } from "dexie";

export type MaybeGetter<T> = T | (() => T);

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

async function clearSyncData(sync: SyncClient<any>) {
  if (sync && typeof sync.tables !== "undefined") {
    try {
      await Promise.all(sync.tables.map((table: any) => table.clear()));
    } catch (err) {
      console.error("Failed to clear local database tables", err);
    }
  }
}

export class AuthClientState<User extends { id: string }> {
  #userGetter = $state<MaybeGetter<User | null>>(null);
  #localOverride = $state<User | null | undefined>(undefined);
  #syncClient?: SyncClient<any>;
  #verifySubscription?: { unsubscribe(): void };
  #verifyTable: string;
  #routesBase: string;
  #onInvalidSession?: () => void | Promise<void>;
  #refreshWhenChanged?: boolean | ((sessionUser: User, syncedUser: User) => boolean);

  constructor(config?: AuthClientConfig) {
    this.#syncClient = config?.syncClient;
    this.#verifyTable = config?.verifyTable ?? "users";
    this.#routesBase = config?.routesBase ?? "/api/auth";
    this.#onInvalidSession = config?.onInvalidSession;
    this.#refreshWhenChanged = config?.refreshWhenChanged;
  }

  /**
   * Gets the current reactive user object (evaluates getter if provided).
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
   */
  set user(value: User | null) {
    this.#localOverride = value;
  }

  /**
   * Helper check to verify if user is authenticated.
   */
  get isAuthenticated(): boolean {
    return this.user !== null;
  }

  /**
   * Initializes the client-side user state.
   * Accepts a static user object or a getter function (e.g. `() => data.user`).
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
          if (!activeUser || !this.#refreshWhenChanged) return;
          const syncedUser = rows.find((row: User) => String(row.id) === String(activeUser.id));
          if (!syncedUser) return;

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
          this.#localOverride = null;
          const invalid = this.#onInvalidSession?.();
          if (invalid && typeof invalid.then === "function") {
            invalid.catch((hookErr) => {
              console.error("onInvalidSession hook failed", hookErr);
            });
          } else {
            this.logout();
          }
          clearSyncData(sync);
        }
      });
    }
  }

  /**
   * Calls the configured login route and stores the returned app user.
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
    if (this.#syncClient) {
      this.#syncClient.reconnect();
    }
    return user;
  }

  /**
   * Calls the configured Google auth route with a Google credential.
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
    if (this.#syncClient) {
      this.#syncClient.reconnect();
    }
    return user;
  }

  /**
   * Verifies the current cookie server-side and rewrites it with a fresh user object.
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
    return user;
  }

  /**
   * Clears client state, calls the server logout endpoint to delete cookies, and wipes local IndexedDB caches.
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
 */
export function createAuth<User extends { id: string }>(config?: AuthClientConfig): AuthClientState<User> {
  return new AuthClientState<User>(config);
}
