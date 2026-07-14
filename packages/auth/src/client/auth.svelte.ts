import type { SyncClient } from "@sveltebase/sync/client";
import { liveQuery } from "dexie";
import {
  createAuthErrorCodec,
  type AuthErrorCodec,
  type AuthErrorInput,
  type SerializableErrorConstructor,
} from "../errors.js";

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
  /** Error classes to restore from failed auth route responses. */
  errorClasses?: readonly SerializableErrorConstructor[];
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

async function readAuthError(
  response: Response,
  codec: AuthErrorCodec,
) {
  const text = await response.text();

  if (!text) {
    return codec.deserialize({
      code: "HttpError",
      message: `Auth request failed with status ${response.status}`,
    });
  }

  try {
    return codec.deserialize(JSON.parse(text) as AuthErrorInput);
  } catch {
    return codec.deserialize(text);
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
  #syncClientChangeUnsubscribe?: () => void;
  #verifyTable: string;
  #routesBase: string;
  #errorCodec: AuthErrorCodec;
  #onInvalidSession?: () => void | Promise<void>;
  #refreshWhenChanged?: boolean | ((sessionUser: User, syncedUser: User) => boolean);
  #verifyUser: (sessionUser: User, syncedUser: any) => boolean;
  #isVerifying = $state(false);
  #isReady = $state(false);
  #verificationReady = false;
  #initialized = $state(false);
  #lastResolvedUserId: string | null | undefined;
  #ranNoSyncInitVerification = false;
  #noSyncInitVerificationPromise?: Promise<void>;

  /**
   * Creates client auth state.
   *
   * Pass a `SyncClient` when the app should verify the cookie session against a
   * synced user row and clear local data when that row disappears.
   */
  constructor(config?: AuthClientConfig) {
    this.#verifyTable = config?.verifyTable ?? "users";
    this.#routesBase = config?.routesBase ?? "/api/auth";
    this.#errorCodec = createAuthErrorCodec(config?.errorClasses);
    this.#onInvalidSession = config?.onInvalidSession;
    this.#refreshWhenChanged = config?.refreshWhenChanged;
    this.#verifyUser = config?.verifyUser ?? ((sessionUser, syncedUser) => {
      return String(sessionUser.id) === String(syncedUser?.id);
    });
    if (config?.syncClient) {
      this.setClient(config.syncClient);
    }
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
   * True once auth state is initialized and any required startup verification completed.
   */
  get isReady(): boolean {
    return this.#isReady;
  }

  /**
   * True while auth is actively verifying the current session.
   */
  get isVerifying(): boolean {
    return this.#isVerifying;
  }

  /**
   * True when auth is ready and `user` is not `null`.
   */
  get isAuthenticated(): boolean {
    return this.#isReady && this.user !== null;
  }

  /**
   * Initializes the client-side user state.
   * Accepts a static user object or a getter function (e.g. `() => data.user`).
   *
   * Call this once from a root component or layout effect after receiving the
   * server session user from SvelteKit load data.
   */
  init(user: MaybeGetter<User | null>) {
    this.#initialized = true;
    this.#userGetter = user;
    this.#isReady = false;
    this.#localOverride = undefined; // Reset local override on new init

    // Reactive effect to reset local override whenever the server's user getter updates
    $effect(() => {
      // Access the getter reactively so Svelte tracks this dependency
      const serverUser = typeof this.#userGetter === "function"
        ? (this.#userGetter as () => User | null)()
        : this.#userGetter;

      const resolvedUserId = serverUser ? String(serverUser.id) : null;
      if (this.#lastResolvedUserId !== resolvedUserId) {
        this.#lastResolvedUserId = resolvedUserId;
        this.#verificationReady = false;
        this.#ranNoSyncInitVerification = false;
        this.#noSyncInitVerificationPromise = undefined;
        this.#isReady = false;
      }

      // Clear any local override (like query error overrides) whenever the server session changes
      this.#localOverride = undefined;

      void this.ensureReady();
    });

    this.setupSyncVerification();
    void this.ensureReady();
  }

  /**
   * Attaches or replaces the sync client used for session verification.
   *
   * This is useful when a dynamic sync client cannot be created until app data
   * has been initialized.
   */
  setClient(syncClient?: SyncClient<any>): this {
    if (this.#syncClient === syncClient) return this;

    this.#verifySubscription?.unsubscribe();
    this.#verifySubscription = undefined;
    this.#syncClientChangeUnsubscribe?.();
    this.#syncClientChangeUnsubscribe = undefined;
    this.#verificationReady = false;
    this.#syncClient = syncClient;

    const onClientChange = (syncClient as any)?.onClientChange as
      | ((callback: () => void) => () => void)
      | undefined;
    if (onClientChange) {
      this.#syncClientChangeUnsubscribe = onClientChange(() => {
        this.#verifySubscription?.unsubscribe();
        this.#verifySubscription = undefined;
        this.#verificationReady = false;
        this.setupSyncVerification();
        void this.ensureReady();
      });
    }

    if (this.#initialized) {
      this.setupSyncVerification();
      void this.ensureReady();
    }

    return this;
  }

  private setupSyncVerification() {
    if (!this.#syncClient || this.#verifySubscription) return;

    const sync = this.#syncClient;
    if ((sync as any).isDynamicSyncClient === true && !(sync as any).client) {
      return;
    }

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

  private hasUsableSyncClient(syncClient = this.#syncClient): syncClient is SyncClient<any> {
    if (!syncClient) return false;
    return (syncClient as any).isDynamicSyncClient !== true || Boolean((syncClient as any).client);
  }

  private async ensureReady() {
    if (!this.#initialized) return;

    const activeUser = this.user;
    if (!activeUser) {
      this.#isReady = true;
      this.#ranNoSyncInitVerification = true;
      return;
    }

    if (this.hasUsableSyncClient()) {
      this.setupSyncVerification();
      this.#isReady = true;
      return;
    }

    if (this.#ranNoSyncInitVerification || this.#noSyncInitVerificationPromise) {
      return;
    }

    this.#isVerifying = true;
    this.#noSyncInitVerificationPromise = (async () => {
      try {
        await this.refresh();
        this.#ranNoSyncInitVerification = true;
        this.#isReady = true;
      } catch (err) {
        console.warn("Initial auth refresh verification failed.", err);
      } finally {
        this.#isVerifying = false;
        this.#noSyncInitVerificationPromise = undefined;
      }
    })();

    await this.#noSyncInitVerificationPromise;
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
      this.#isReady = true;
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
    this.#isReady = true;
    this.#ranNoSyncInitVerification = true;
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
      throw await readAuthError(response, this.#errorCodec);
    }

    const user = await response.json() as User;
    this.#localOverride = user;
    const verifiedUser = await this.verifySyncedUser(user, { reconnect: true });
    if (!verifiedUser) {
      throw new Error("Invalid session");
    }
    this.#isReady = true;
    this.#ranNoSyncInitVerification = true;
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
      throw await readAuthError(response, this.#errorCodec);
    }

    const user = await response.json() as User;
    this.#localOverride = user;
    const verifiedUser = await this.verifySyncedUser(user, { reconnect: true });
    this.#isReady = true;
    this.#ranNoSyncInitVerification = true;
    return verifiedUser;
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
      this.#isReady = true;
      this.#ranNoSyncInitVerification = true;
      return null;
    }
    if (!response.ok) {
      throw await readAuthError(response, this.#errorCodec);
    }

    const user = await response.json() as User;
    this.#localOverride = user;
    const verifiedUser = await this.verifySyncedUser(user);
    this.#isReady = true;
    this.#ranNoSyncInitVerification = true;
    return verifiedUser;
  }

  /**
   * Clears client state, calls the server logout endpoint to delete cookies, and wipes local IndexedDB caches.
   *
   * Network failures during the logout fetch are ignored because the local app
   * should still leave the authenticated state immediately.
   */
  async logout() {
    this.#localOverride = null;
    this.#isReady = true;
    this.#ranNoSyncInitVerification = true;
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
