import type { SyncClient } from "@sveltebase/sync/client";

export type MaybeGetter<T> = T | (() => T);

export interface AuthClientConfig {
  /**
   * The Svelteflare Sync client instance.
   * If provided, session verification will run automatically over the WebSocket connection.
   */
  syncClient?: SyncClient<any>;
}

async function clearSyncData(sync: SyncClient<any>) {
  if (sync.db && typeof sync.db.tables !== "undefined") {
    try {
      await Promise.all(sync.db.tables.map((table: any) => table.clear()));
    } catch (err) {
      console.error("Failed to clear local database tables", err);
    }
  }
}

export class AuthClientState<User extends { id: any }> {
  #userGetter = $state<MaybeGetter<User | null>>(null);
  #localOverride = $state<User | null | undefined>(undefined);
  #syncClient?: SyncClient<any>;
  #usersQuery = $state<any>(null);

  constructor(config?: AuthClientConfig) {
    this.#syncClient = config?.syncClient;
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

    // Set up the internal sync channel subscription if syncClient is provided and not already initialized.
    // Calling this here is safe because init() is executed during layout component initialization.
    if (this.#syncClient && !this.#usersQuery) {
      const sync = this.#syncClient;
      
      // Create a live query monitoring the "users" channel
      this.#usersQuery = sync.table("users").liveQuery((t) => t.toArray());

      // Svelte 5 reactive effect to auto-logout on authentication failure
      $effect(() => {
        // Read the user reactively so Svelte tracks this effect dependency
        const activeUser = this.user;
        const query = this.#usersQuery;

        if (query && query.status === "error") {
          console.warn("WebSocket session verification failed: logging out.");
          this.#localOverride = null;
          fetch("/api/auth/logout", { method: "POST" }).catch(() => {
            // Ignore fetch errors if offline or route not mounted
          });
          clearSyncData(sync);
        }
      });
    }
  }

  /**
   * Updates the user profile reactively, syncs it over the WebSocket, and updates the server cookie.
   */
  async update(changes: Partial<User>) {
    const activeUser = this.user;
    if (!activeUser) return;

    const updatedUser = { ...activeUser, ...changes };
    this.#localOverride = updatedUser;

    // 1. Update over Sync WebSocket
    if (this.#syncClient) {
      try {
        await this.#syncClient.table("users").put(activeUser.id, changes);
      } catch (err) {
        console.error("Failed to update user profile over Sync WebSocket:", err);
      }
    }

    // 2. Update the server cookie
    try {
      await fetch("/api/auth/update", {
        method: "POST",
        body: JSON.stringify(changes),
        headers: { "Content-Type": "application/json" }
      });
    } catch (err) {
      console.error("Failed to update server session cookie:", err);
    }
  }

  /**
   * Clears client state, calls the server logout endpoint to delete cookies, and wipes local IndexedDB caches.
   */
  async logout() {
    this.#localOverride = null;
    try {
      await fetch("/api/auth/logout", { method: "POST" });
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
export function createAuth<User extends { id: any }>(config?: AuthClientConfig): AuthClientState<User> {
  return new AuthClientState<User>(config);
}
