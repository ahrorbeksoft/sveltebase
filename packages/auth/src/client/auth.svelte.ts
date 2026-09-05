import {
  createAuthErrorCodec,
  type AuthErrorCodec,
  type AuthErrorInput,
  type SerializableErrorConstructor,
} from '../errors.js';
import type { AuthSession } from '../index.js';

export type MaybeGetter<T> = T | (() => T);

/** Optional bridge. Auth never imports a database or transport implementation. */
export interface AuthSyncAdapter<
  User extends { id: string },
  Claims extends Record<string, unknown>,
> {
  start?(session: AuthSession<User, Claims>): void | Promise<void>;
  stop?(): void | Promise<void>;
  purgeAccount?(subject: string): void | Promise<void>;
  getConnectivity?(): string;
  onSessionInvalidated?(callback: () => void): void | (() => void);
}

export interface AuthClientConfig<
  User extends { id: string } = { id: string },
  Claims extends Record<string, unknown> = Record<string, never>,
> {
  routesBase?: string;
  errorClasses?: readonly SerializableErrorConstructor[];
  sync?: AuthSyncAdapter<User, Claims>;
  fetch?: typeof fetch;
  onInvalidSession?: () => void | Promise<void>;
  onLogout?: () => void | Promise<void>;
  onSession?: (
    session: AuthSession<User, Claims> | null,
  ) => void | Promise<void>;
  onIntegrationError?: (error: unknown) => void;
}

const EMPTY_CLAIMS: Record<string, never> = Object.freeze({});

async function readAuthError(response: Response, codec: AuthErrorCodec) {
  const text = await response.text();
  if (!text)
    return codec.deserialize({
      code: 'HttpError',
      message: `Auth request failed (${response.status})`,
    });
  try {
    return codec.deserialize(JSON.parse(text) as AuthErrorInput);
  } catch {
    return codec.deserialize(text);
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

export class AuthClientState<
  User extends { id: string },
  Claims extends Record<string, unknown> = Record<string, never>,
> {
  #initialUser: MaybeGetter<User | null> = null;
  #initialClaims: MaybeGetter<Claims | null | undefined> = null;
  #localUser = $state<User | null | undefined>(undefined);
  #localClaims = $state<Claims | undefined>(undefined);
  #ready = $state(false);
  #refreshing = $state(false);
  #generation = 0;
  #syncTransition: Promise<void> = Promise.resolve();
  #refreshPromise?: Promise<AuthSession<User, Claims> | null>;
  #disposed = false;
  #routesBase: string;
  #codec: AuthErrorCodec;
  #sync?: AuthSyncAdapter<User, Claims>;
  #fetch: typeof fetch;
  #unsubscribeInvalidation?: () => void;
  #activeRequest?: AbortController;
  #onInvalidSession?: () => void | Promise<void>;
  #onLogout?: () => void | Promise<void>;
  #onSession?: (
    session: AuthSession<User, Claims> | null,
  ) => void | Promise<void>;
  #onIntegrationError?: (error: unknown) => void;

  constructor(config: AuthClientConfig<User, Claims> = {}) {
    this.#routesBase = config.routesBase ?? '/api/auth';
    this.#codec = createAuthErrorCodec(config.errorClasses);
    this.#sync = config.sync;
    this.#fetch = config.fetch ?? globalThis.fetch;
    this.#onInvalidSession = config.onInvalidSession;
    this.#onLogout = config.onLogout;
    this.#onSession = config.onSession;
    this.#onIntegrationError = config.onIntegrationError;
    const unsubscribe = this.#sync?.onSessionInvalidated?.(
      () => void this.invalidate(),
    );
    if (typeof unsubscribe === 'function')
      this.#unsubscribeInvalidation = unsubscribe;
  }

  get user(): User | null {
    if (this.#localUser !== undefined) return this.#localUser;
    const source = this.#initialUser;
    return typeof source === 'function' ? source() : source;
  }

  get claims(): Claims {
    if (this.#localClaims !== undefined) return this.#localClaims;
    const source = this.#initialClaims;
    const value = typeof source === 'function' ? source() : source;
    return value ?? (EMPTY_CLAIMS as Claims);
  }

  get session(): AuthSession<User, Claims> | null {
    const user = this.user;
    return user ? { subject: user.id, user, claims: this.claims } : null;
  }

  get isReady() {
    return this.#ready;
  }
  get isAuthenticated() {
    return this.#ready && this.user !== null;
  }
  get isRefreshing() {
    return this.#refreshing;
  }
  get connectivity() {
    return this.#sync?.getConnectivity?.() ?? 'unavailable';
  }

  /** Initializes from request/component-owned SSR data without I/O. */
  init(
    user: MaybeGetter<User | null>,
    claims?: MaybeGetter<Claims | null | undefined>,
  ): void {
    if (this.#disposed) throw new Error('Auth client is disposed');
    this.#initialUser = user;
    this.#initialClaims = claims ?? null;
    this.#localUser = undefined;
    this.#localClaims = undefined;
    this.#ready = true;
    const session = this.session;
    const generation = ++this.#generation;
    if (session && typeof window !== 'undefined')
      this.#transitionSync(generation, null, session);
  }

  #parseSession(value: unknown): AuthSession<User, Claims> {
    if (
      !isRecord(value) ||
      typeof value.subject !== 'string' ||
      !isRecord(value.user) ||
      typeof value.user.id !== 'string' ||
      value.user.id !== value.subject ||
      !isRecord(value.claims)
    ) {
      throw new Error('Invalid auth session response');
    }
    return {
      subject: value.subject,
      user: value.user as User,
      claims: value.claims as Claims,
    };
  }

  #apply(session: AuthSession<User, Claims> | null): void {
    this.#localUser = session?.user ?? null;
    this.#localClaims = session?.claims ?? (EMPTY_CLAIMS as Claims);
    this.#ready = true;
    void this.#onSession?.(session);
  }

  #transitionSync(
    generation: number,
    previous: AuthSession<User, Claims> | null,
    next: AuthSession<User, Claims> | null,
    purge = false,
  ): void {
    this.#syncTransition = this.#syncTransition
      .then(async () => {
        if (this.#disposed || generation !== this.#generation) return;
        await this.#sync?.stop?.();
        if (this.#disposed || generation !== this.#generation) return;
        if (purge && previous)
          await this.#sync?.purgeAccount?.(previous.subject);
        if (this.#disposed || generation !== this.#generation) return;
        if (next) await this.#sync?.start?.(next);
      })
      .catch((error) => this.#onIntegrationError?.(error));
  }

  #beginRequest(): { generation: number; controller: AbortController } {
    this.#activeRequest?.abort();
    const controller = new AbortController();
    this.#activeRequest = controller;
    return { generation: ++this.#generation, controller };
  }

  #finishRequest(controller: AbortController): void {
    if (this.#activeRequest === controller) this.#activeRequest = undefined;
  }

  async #post(
    path: string,
    body?: unknown,
    signal?: AbortSignal,
  ): Promise<Response> {
    const fetcher = this.#fetch;
    return fetcher(`${this.#routesBase}/${path}`, {
      method: 'POST',
      signal,
      ...(body !== undefined
        ? {
            body: JSON.stringify(body),
            headers: { 'Content-Type': 'application/json' },
          }
        : {}),
    });
  }

  async #login(
    path: string,
    body: unknown,
  ): Promise<AuthSession<User, Claims>> {
    const { generation, controller } = this.#beginRequest();
    const previous = this.session;
    try {
      const response = await this.#post(path, body, controller.signal);
      if (!response.ok) throw await readAuthError(response, this.#codec);
      const session = this.#parseSession(await response.json());
      if (this.#disposed || generation !== this.#generation)
        throw new Error('Authentication request was superseded');
      this.#apply(session);
      this.#transitionSync(
        generation,
        previous,
        session,
        previous?.subject !== session.subject,
      );
      return session;
    } finally {
      this.#finishRequest(controller);
    }
  }

  login<Body = unknown>(body: Body) {
    return this.#login('login', body);
  }
  loginWithGoogle(credential: string) {
    return this.#login('google', { credential });
  }
  loginWithTma(body: { initData: string } & Record<string, unknown>) {
    return this.#login('tma', body);
  }

  async setClaims(claims: Claims): Promise<AuthSession<User, Claims> | null> {
    const { generation, controller } = this.#beginRequest();
    const previous = this.session;
    try {
      const response = await this.#post('claims', claims, controller.signal);
      if (response.status === 401) {
        if (generation === this.#generation) await this.invalidate();
        return null;
      }
      if (!response.ok) throw await readAuthError(response, this.#codec);
      const session = this.#parseSession(await response.json());
      if (this.#disposed || generation !== this.#generation)
        return this.session;
      this.#apply(session);
      this.#transitionSync(generation, previous, session);
      return session;
    } finally {
      this.#finishRequest(controller);
    }
  }

  refresh(): Promise<AuthSession<User, Claims> | null> {
    if (this.#refreshPromise) return this.#refreshPromise;
    this.#refreshing = true;
    const operation = this.#doRefresh();
    this.#refreshPromise = operation;
    void operation
      .finally(() => {
        if (this.#refreshPromise === operation) {
          this.#refreshPromise = undefined;
          this.#refreshing = false;
        }
      })
      .catch(() => undefined);
    return operation;
  }

  async #doRefresh(): Promise<AuthSession<User, Claims> | null> {
    const { generation, controller } = this.#beginRequest();
    try {
      const response = await this.#post(
        'refresh',
        undefined,
        controller.signal,
      );
      if (response.status === 401) {
        if (generation === this.#generation) await this.invalidate();
        return null;
      }
      if (!response.ok) throw await readAuthError(response, this.#codec);
      const session = this.#parseSession(await response.json());
      if (this.#disposed || generation !== this.#generation)
        return this.session;
      const previous = this.session;
      this.#apply(session);
      this.#transitionSync(
        generation,
        previous,
        session,
        previous?.subject !== session.subject,
      );
      return session;
    } finally {
      this.#finishRequest(controller);
    }
  }

  async invalidate(): Promise<void> {
    this.#activeRequest?.abort();
    this.#activeRequest = undefined;
    ++this.#generation;
    const previous = this.session;
    try {
      await this.#sync?.stop?.();
    } catch (error) {
      this.#onIntegrationError?.(error);
    }
    this.#apply(null);
    await this.#onInvalidSession?.();
    if (previous) await this.#sync?.purgeAccount?.(previous.subject);
    await this.#onLogout?.();
  }

  /** Server logout failure is surfaced and the prior local session is restored. */
  async logout(options: { purge?: boolean } = {}): Promise<void> {
    const { generation, controller } = this.#beginRequest();
    const previous = this.session;
    await this.#sync?.stop?.();
    let response: Response;
    try {
      response = await this.#post('logout', undefined, controller.signal);
    } catch (error) {
      if (generation === this.#generation && previous)
        void Promise.resolve(this.#sync?.start?.(previous)).catch((cause) =>
          this.#onIntegrationError?.(cause),
        );
      this.#finishRequest(controller);
      throw error;
    }
    if (!response.ok) {
      if (generation === this.#generation && previous)
        void Promise.resolve(this.#sync?.start?.(previous)).catch((cause) =>
          this.#onIntegrationError?.(cause),
        );
      this.#finishRequest(controller);
      throw await readAuthError(response, this.#codec);
    }
    if (this.#disposed || generation !== this.#generation) {
      this.#finishRequest(controller);
      return;
    }
    if (options.purge && previous)
      await this.#sync?.purgeAccount?.(previous.subject);
    this.#apply(null);
    await this.#onLogout?.();
    this.#finishRequest(controller);
  }

  /** Explicit offline/local logout. The cookie remains until the server can be reached. */
  async logoutLocal(options: { purge?: boolean } = {}): Promise<void> {
    this.#activeRequest?.abort();
    this.#activeRequest = undefined;
    ++this.#generation;
    const previous = this.session;
    await this.#sync?.stop?.();
    if (options.purge && previous)
      await this.#sync?.purgeAccount?.(previous.subject);
    this.#apply(null);
    await this.#onLogout?.();
  }

  dispose(): void {
    if (this.#disposed) return;
    this.#disposed = true;
    this.#activeRequest?.abort();
    this.#activeRequest = undefined;
    ++this.#generation;
    this.#unsubscribeInvalidation?.();
    this.#unsubscribeInvalidation = undefined;
    void Promise.resolve(this.#sync?.stop?.()).catch((error) =>
      this.#onIntegrationError?.(error),
    );
  }
}

export function createAuth<
  User extends { id: string },
  Claims extends Record<string, unknown> = Record<string, never>,
>(config?: AuthClientConfig<User, Claims>) {
  return new AuthClientState<User, Claims>(config);
}
