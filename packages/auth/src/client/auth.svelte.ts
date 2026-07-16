import type { SyncClient } from "@sveltebase/sync/client";
import { liveQuery } from "dexie";
import {
  createAuthErrorCodec,
  type AuthErrorCodec,
  type AuthErrorInput,
  type SerializableErrorConstructor,
} from "../errors.js";
import type { AuthSession } from "../index.js";

/**
 * Value or getter used to keep auth state connected to SvelteKit load data.
 */
export type MaybeGetter<T> = T | (() => T);

/** When / whether to reconnect the sync client after login. */
export type AuthReconnectPolicy = boolean | "if-connected";

/**
 * Client-side auth state options.
 *
 * The cookie is the session source of truth. When a sync client is attached,
 * the configured profile table provides live invalidation and profile refresh.
 */
export interface AuthClientConfig<
  User extends { id: string } = { id: string },
  Claims extends Record<string, unknown> = Record<string, never>,
> {
  /**
   * Optional sync client or dynamic wrapper used for profile verification.
   */
  syncClient?: SyncClient<any> | any;
  verifyTable?: string;
  verifyUser?: (sessionUser: User, syncedUser: any) => boolean;
  /**
   * Base path for auth route handlers.
   * @default "/api/auth"
   */
  routesBase?: string;
  /** Error classes to restore from failed auth route responses. */
  errorClasses?: readonly SerializableErrorConstructor[];
  onInvalidSession?: () => void | Promise<void>;
  onLogout?: () => void | Promise<void>;
  onSession?: (
    session: AuthSession<User, Claims> | null,
  ) => void | Promise<void>;
  refreshWhenChanged?:
    | boolean
    | ((sessionUser: User, syncedUser: any) => boolean);
  /**
   * Default reconnect policy after login / TMA / Google.
   * @default false
   */
  reconnect?: AuthReconnectPolicy;
}

function isBrowser() {
  return typeof window !== "undefined";
}

function resolveConcreteSyncClient(sync: any): any | undefined {
  if (!sync || typeof sync === "function") return undefined;
  if (sync.isDynamicSyncClient === true) {
    return sync.client;
  }
  return sync;
}

async function clearSyncData(sync: any) {
  const concrete = resolveConcreteSyncClient(sync);
  if (!concrete) return;
  try {
    // Prefer Dexie tables collection; never call .table() on a dynamic proxy.
    const tables =
      typeof concrete.tables !== "undefined"
        ? Array.from(concrete.tables as Iterable<any>)
        : [];
    if (tables.length === 0) return;
    await Promise.all(
      tables.map((table: any) =>
        typeof table?.clear === "function" ? table.clear() : Promise.resolve(),
      ),
    );
  } catch (err) {
    console.error("Failed to clear local database tables", err);
  }
}

function disconnectSync(sync: any) {
  try {
    sync?.disconnect?.();
  } catch {
    // already torn down
  }
}

async function readAuthError(response: Response, codec: AuthErrorCodec) {
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

function resolveReconnect(
  policy: AuthReconnectPolicy | undefined,
  syncClient: any,
): boolean {
  const resolved = policy ?? false;
  if (resolved === true) return true;
  if (resolved === false) return false;
  // "if-connected"
  const concrete = resolveConcreteSyncClient(syncClient);
  if (!concrete) return false;
  return concrete.status === "connected" || concrete.status === "connecting";
}

const EMPTY_CLAIMS: Record<string, never> = Object.freeze({});

/**
 * Svelte-reactive client auth with cookie profile, session claims, and optional
 * live verification against a synced profile table.
 */
export class AuthClientState<
  User extends { id: string },
  Claims extends Record<string, unknown> = Record<string, never>,
> {
  #userGetter = $state<MaybeGetter<User | null>>(null);
  #claimsGetter = $state<MaybeGetter<Claims | null>>(null);
  #localUser = $state<User | null | undefined>(undefined);
  #localClaims = $state<Claims | null | undefined>(undefined);
  #syncClient?: any;
  #syncClientGetter?: () => any;
  #syncClientGetterCleanup?: () => void;
  #verifySubscription?: { unsubscribe(): void };
  #syncClientChangeUnsubscribe?: () => void;
  #verifyTable: string;
  #verifyUser: (sessionUser: User, syncedUser: any) => boolean;
  #refreshWhenChanged?:
    | boolean
    | ((sessionUser: User, syncedUser: any) => boolean);
  #verificationReady = false;
  #syncVerificationPromise?: Promise<AuthSession<User, Claims> | null>;
  #routesBase: string;
  #errorCodec: AuthErrorCodec;
  #onInvalidSession?: () => void | Promise<void>;
  #onLogout?: () => void | Promise<void>;
  #onSession?: (
    session: AuthSession<User, Claims> | null,
  ) => void | Promise<void>;
  #defaultReconnect: AuthReconnectPolicy;
  #isVerifying = $state(false);
  #isReady = $state(false);
  #initialized = $state(false);
  #lastResolvedUserId: string | null | undefined;
  #ranNoSyncInitVerification = false;
  #noSyncInitVerificationPromise?: Promise<void>;

  constructor(config?: AuthClientConfig<User, Claims>) {
    this.#routesBase = config?.routesBase ?? "/api/auth";
    this.#errorCodec = createAuthErrorCodec(config?.errorClasses);
    this.#onInvalidSession = config?.onInvalidSession;
    this.#onLogout = config?.onLogout;
    this.#onSession = config?.onSession;
    this.#defaultReconnect = config?.reconnect ?? false;
    this.#verifyTable = config?.verifyTable ?? "users";
    this.#verifyUser =
      config?.verifyUser ??
      ((sessionUser, syncedUser) =>
        String(sessionUser.id) === String(syncedUser?.id));
    this.#refreshWhenChanged = config?.refreshWhenChanged;
    if (config?.syncClient) {
      this.setClient(config.syncClient);
    }
  }

  get user(): User | null {
    if (this.#localUser !== undefined) {
      return this.#localUser;
    }
    const val = this.#userGetter;
    return typeof val === "function" ? (val as () => User | null)() : val;
  }

  set user(value: User | null) {
    this.#localUser = value;
  }

  get claims(): Claims {
    try {
      if (this.#localClaims !== undefined) {
        return (this.#localClaims ?? (EMPTY_CLAIMS as Claims)) as Claims;
      }
      const val = this.#claimsGetter;
      const resolved =
        typeof val === "function"
          ? (val as () => Claims | null | undefined)()
          : val;
      if (resolved && typeof resolved === "object") {
        return resolved as Claims;
      }
      return EMPTY_CLAIMS as Claims;
    } catch {
      return EMPTY_CLAIMS as Claims;
    }
  }

  set claims(value: Claims) {
    this.#localClaims =
      value && typeof value === "object" ? value : (EMPTY_CLAIMS as Claims);
  }

  get session(): AuthSession<User, Claims> | null {
    const user = this.user;
    if (!user) return null;
    return { user, claims: this.claims };
  }

  get sessionUser(): (User & Claims) | null {
    const user = this.user;
    if (!user) return null;
    return { ...user, ...this.claims };
  }

  get isReady(): boolean {
    return this.#isReady;
  }

  get isVerifying(): boolean {
    return this.#isVerifying;
  }

  get isAuthenticated(): boolean {
    return this.#isReady && this.user !== null;
  }

  init(
    user: MaybeGetter<User | null>,
    claims?: MaybeGetter<Claims | null | undefined>,
  ) {
    this.#initialized = true;
    this.#userGetter = user;
    this.#claimsGetter = (claims ?? null) as MaybeGetter<Claims | null>;
    this.#isReady = false;
    this.#localUser = undefined;
    this.#localClaims = undefined;

    $effect(() => {
      const serverUser =
        typeof this.#userGetter === "function"
          ? (this.#userGetter as () => User | null)()
          : this.#userGetter;

      const resolvedUserId = serverUser ? String(serverUser.id) : null;
      if (this.#lastResolvedUserId !== resolvedUserId) {
        this.#lastResolvedUserId = resolvedUserId;
        this.#ranNoSyncInitVerification = false;
        this.#noSyncInitVerificationPromise = undefined;
        this.#isReady = false;
        this.#localUser = undefined;
        this.#localClaims = undefined;
        this.#verificationReady = false;
        this.#syncVerificationPromise = undefined;
      }

      void this.ensureReady();
    });

    void this.ensureReady();
  }

  /**
   * Attach or replace the sync client used for live session verification.
   */
  setClient(syncClient?: any | (() => any)): this {
    if (typeof syncClient === "function" && !syncClient.isDynamicSyncClient) {
      this.#syncClientGetterCleanup?.();
      this.#syncClientGetter = syncClient as () => any;
      try {
        this.#syncClientGetterCleanup = $effect.root(() => {
          $effect(() => {
            const next = (this.#syncClientGetter as () => any)();
            this.#bindSyncClient(next ?? undefined);
          });
        });
      } catch {
        this.#bindSyncClient((syncClient as () => any)() ?? undefined);
      }
      return this;
    }

    this.#syncClientGetterCleanup?.();
    this.#syncClientGetterCleanup = undefined;
    this.#syncClientGetter = undefined;
    this.#bindSyncClient(syncClient);
    return this;
  }

  #bindSyncClient(syncClient?: any) {
    if (this.#syncClient === syncClient) return;

    this.#verifySubscription?.unsubscribe();
    this.#verifySubscription = undefined;
    this.#syncClientChangeUnsubscribe?.();
    this.#syncClientChangeUnsubscribe = undefined;
    this.#syncClient = syncClient;
    this.#verificationReady = false;
    this.#syncVerificationPromise = undefined;

    const onClientChange = syncClient?.onClientChange as
      | ((callback: () => void) => () => void)
      | undefined;
    if (onClientChange) {
      this.#syncClientChangeUnsubscribe = onClientChange(() => {
        this.#verifySubscription?.unsubscribe();
        this.#verifySubscription = undefined;
        this.#verificationReady = false;
        this.#syncVerificationPromise = undefined;
        this.setupSyncVerification();
        void this.ensureReady();
      });
    }

    if (this.#initialized) {
      this.setupSyncVerification();
      void this.ensureReady();
    }
  }

  private setupSyncVerification() {
    if (!isBrowser() || this.#verifySubscription) return;
    const concrete = resolveConcreteSyncClient(this.#syncClient);
    if (!concrete) return;

    const observable = liveQuery(() =>
      concrete.table(this.#verifyTable).toArray(),
    );
    this.#verifySubscription = observable.subscribe({
      next: (rows: any[]) => {
        const activeUser = this.user;
        if (!activeUser || this.#isVerifying || !this.#verificationReady)
          return;

        const syncedUser = rows.find((row) =>
          this.#verifyUser(activeUser, row),
        );
        if (!syncedUser) {
          void this.handleInvalidSession();
          return;
        }

        if (!this.#refreshWhenChanged) return;
        const shouldRefresh =
          this.#refreshWhenChanged === true
            ? JSON.stringify(activeUser) !== JSON.stringify(syncedUser)
            : this.#refreshWhenChanged(activeUser, syncedUser);
        if (shouldRefresh) {
          void this.refresh().catch((error) => {
            console.warn(
              "Failed to refresh auth session after sync change.",
              error,
            );
          });
        }
      },
      error: (error) => {
        console.warn("WebSocket session verification failed.", error);
        void this.handleInvalidSession();
      },
    });
  }

  private applySession(
    session: AuthSession<User, Claims> | null,
    options?: { notify?: boolean },
  ) {
    if (!session) {
      this.#localUser = null;
      this.#localClaims = EMPTY_CLAIMS as Claims;
    } else {
      this.#localUser = session.user;
      this.#localClaims = session.claims ?? (EMPTY_CLAIMS as Claims);
    }
    if (options?.notify !== false) {
      void this.#onSession?.(session);
    }
  }

  private parseSessionResponse(data: any): AuthSession<User, Claims> {
    if (data && typeof data === "object" && "user" in data) {
      return {
        user: data.user as User,
        claims: (data.claims ?? {}) as Claims,
      };
    }
    return {
      user: data as User,
      claims: {} as Claims,
    };
  }

  private hasUsableSyncClient(syncClient = this.#syncClient): boolean {
    return Boolean(resolveConcreteSyncClient(syncClient));
  }

  private async verifySyncedSession(
    session: AuthSession<User, Claims> | null,
    options?: { reconnect?: boolean },
  ): Promise<AuthSession<User, Claims> | null> {
    if (!session) return null;

    const concrete = resolveConcreteSyncClient(this.#syncClient);
    if (!concrete?.resyncTable) return session;

    this.setupSyncVerification();
    this.#isVerifying = true;
    try {
      const rows = await concrete.resyncTable(this.#verifyTable, options);
      const syncedUser = rows.find((row: any) =>
        this.#verifyUser(session.user, row),
      );
      if (!syncedUser) {
        await this.handleInvalidSession();
        return null;
      }

      const verified = {
        user: syncedUser as User,
        claims: session.claims,
      };
      this.applySession(verified);
      this.#verificationReady = true;
      this.#isReady = true;
      return verified;
    } catch (error) {
      await this.handleInvalidSession();
      throw error;
    } finally {
      this.#isVerifying = false;
    }
  }

  /** Resyncs the configured profile table and verifies the active session. */
  async verifySync(options?: {
    reconnect?: boolean;
  }): Promise<AuthSession<User, Claims> | null> {
    const session = this.session;
    if (!session || !this.hasUsableSyncClient()) return session;
    if (this.#syncVerificationPromise) return this.#syncVerificationPromise;

    this.#syncVerificationPromise = this.verifySyncedSession(session, options);
    try {
      return await this.#syncVerificationPromise;
    } finally {
      this.#syncVerificationPromise = undefined;
    }
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
      if (!this.#verificationReady) {
        try {
          await this.verifySync();
        } catch (error) {
          console.warn("Initial sync session verification failed.", error);
        }
      }
      this.#isReady = true;
      this.#ranNoSyncInitVerification = true;
      return;
    }

    // A dynamic wrapper may not have context yet. Its onClientChange callback
    // starts verification as soon as the concrete client is created.
    if (this.#syncClient) {
      this.#isReady = true;
      return;
    }

    if (!isBrowser()) {
      this.#isReady = true;
      return;
    }

    // No sync attached (owner/admin): optional one-shot HTTP refresh.
    if (
      this.#ranNoSyncInitVerification ||
      this.#noSyncInitVerificationPromise
    ) {
      return;
    }

    this.#isVerifying = true;
    this.#noSyncInitVerificationPromise = (async () => {
      try {
        await this.refresh();
      } catch (err) {
        console.warn("Initial auth refresh verification failed.", err);
      } finally {
        this.#ranNoSyncInitVerification = true;
        this.#isReady = true;
        this.#isVerifying = false;
        this.#noSyncInitVerificationPromise = undefined;
      }
    })();

    await this.#noSyncInitVerificationPromise;
  }

  private async handleInvalidSession() {
    if (!this.user && !this.#verificationReady) return;
    this.applySession(null, { notify: false });
    this.#verificationReady = false;
    this.#verifySubscription?.unsubscribe();
    this.#verifySubscription = undefined;
    const invalid = this.#onInvalidSession?.();
    if (invalid && typeof invalid.then === "function") {
      await invalid.catch((hookErr) => {
        console.error("onInvalidSession hook failed", hookErr);
      });
    }
    await this.#onLogout?.();
    this.#isReady = true;
    this.#ranNoSyncInitVerification = true;
    if (this.#syncClient) {
      await clearSyncData(this.#syncClient);
      disconnectSync(this.#syncClient);
    }
  }

  private afterAuthSuccess(
    session: AuthSession<User, Claims>,
    options?: { reconnect?: AuthReconnectPolicy },
  ): Promise<AuthSession<User, Claims>> {
    this.applySession(session);
    this.#isReady = true;
    this.#ranNoSyncInitVerification = true;

    const shouldReconnect = resolveReconnect(
      options?.reconnect ?? this.#defaultReconnect,
      this.#syncClient,
    );
    return (async () => {
      const verified = await this.verifySyncedSession(session, {
        reconnect: shouldReconnect,
      });
      if (!verified) throw new Error("Invalid session");
      return verified;
    })();
  }

  async login<Body = unknown>(
    body: Body,
    options?: { reconnect?: AuthReconnectPolicy },
  ): Promise<AuthSession<User, Claims>> {
    const response = await fetch(`${this.#routesBase}/login`, {
      method: "POST",
      body: JSON.stringify(body),
      headers: { "Content-Type": "application/json" },
    });
    if (!response.ok) {
      throw await readAuthError(response, this.#errorCodec);
    }

    const session = this.parseSessionResponse(await response.json());
    return await this.afterAuthSuccess(session, options);
  }

  async loginWithGoogle(
    credential: string,
    options?: { reconnect?: AuthReconnectPolicy },
  ): Promise<AuthSession<User, Claims> | null> {
    const response = await fetch(`${this.#routesBase}/google`, {
      method: "POST",
      body: JSON.stringify({ credential }),
      headers: { "Content-Type": "application/json" },
    });
    if (!response.ok) {
      throw await readAuthError(response, this.#errorCodec);
    }

    const session = this.parseSessionResponse(await response.json());
    return await this.afterAuthSuccess(session, options);
  }

  async loginWithTma(
    body: { initData: string } & Record<string, unknown>,
    options?: { reconnect?: AuthReconnectPolicy },
  ): Promise<AuthSession<User, Claims>> {
    const response = await fetch(`${this.#routesBase}/tma`, {
      method: "POST",
      body: JSON.stringify(body),
      headers: { "Content-Type": "application/json" },
    });
    if (!response.ok) {
      throw await readAuthError(response, this.#errorCodec);
    }

    const session = this.parseSessionResponse(await response.json());
    return await this.afterAuthSuccess(session, options);
  }

  async setClaims(
    claims: Claims,
    options?: { reconnect?: AuthReconnectPolicy },
  ): Promise<AuthSession<User, Claims> | null> {
    const response = await fetch(`${this.#routesBase}/claims`, {
      method: "POST",
      body: JSON.stringify(claims),
      headers: { "Content-Type": "application/json" },
    });
    if (response.status === 401) {
      await this.handleInvalidSession();
      return null;
    }
    if (!response.ok) {
      throw await readAuthError(response, this.#errorCodec);
    }

    const session = this.parseSessionResponse(await response.json());
    this.applySession(session);

    const shouldReconnect = resolveReconnect(
      options?.reconnect ?? true,
      this.#syncClient,
    );
    if (shouldReconnect) {
      try {
        resolveConcreteSyncClient(this.#syncClient)?.reconnect?.({
          force: true,
        });
      } catch {
        // ignore
      }
    }

    this.#isReady = true;
    return session;
  }

  async refresh(): Promise<AuthSession<User, Claims> | null> {
    const response = await fetch(`${this.#routesBase}/refresh`, {
      method: "POST",
    });
    if (response.status === 401) {
      await this.handleInvalidSession();
      return null;
    }
    if (!response.ok) {
      throw await readAuthError(response, this.#errorCodec);
    }

    const session = this.parseSessionResponse(await response.json());
    this.applySession(session);
    const verified = await this.verifySyncedSession(session);
    this.#isReady = true;
    this.#ranNoSyncInitVerification = true;
    return verified;
  }

  async logout() {
    this.applySession(null, { notify: false });
    this.#verificationReady = false;
    this.#verifySubscription?.unsubscribe();
    this.#verifySubscription = undefined;
    this.#isReady = true;
    this.#ranNoSyncInitVerification = true;
    try {
      await fetch(`${this.#routesBase}/logout`, { method: "POST" });
    } catch {
      // ignore network failure
    }
    if (this.#syncClient) {
      await clearSyncData(this.#syncClient);
      disconnectSync(this.#syncClient);
    }
    await this.#onLogout?.();
  }
}

export function createAuth<
  User extends { id: string },
  Claims extends Record<string, unknown> = Record<string, never>,
>(config?: AuthClientConfig<User, Claims>): AuthClientState<User, Claims> {
  return new AuthClientState<User, Claims>(config);
}
