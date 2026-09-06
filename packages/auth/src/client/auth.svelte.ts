import { untrack } from "svelte";
import {
  createAuthErrorCodec,
  type AuthErrorCodec,
  type AuthErrorInput,
  type SerializableErrorConstructor,
} from "../errors.js";
import type { AuthSession } from "../index.js";

export type MaybeGetter<T> = T | (() => T);

/** Cookie-backed auth, independent of the application's data/cache layer. */
export interface AuthClientConfig<
  User extends { id: string } = { id: string },
  Claims extends Record<string, unknown> = Record<string, never>,
> {
  routesBase?: string;
  /** Refresh the server-provided session on browser initialization. Default: true. */
  refreshOnInit?: boolean;
  errorClasses?: readonly SerializableErrorConstructor[];
  onInvalidSession?: () => void | Promise<void>;
  /** Application-owned cleanup, including private collections and connections. */
  onLogout?: () => void | Promise<void>;
  onSession?: (session: AuthSession<User, Claims> | null) => void | Promise<void>;
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

const EMPTY_CLAIMS: Record<string, never> = Object.freeze({});

export class AuthClientState<
  User extends { id: string },
  Claims extends Record<string, unknown> = Record<string, never>,
> {
  #user = $state<User | null>(null);
  #claims = $state<Claims>(EMPTY_CLAIMS as Claims);
  #isReady = $state(false);
  #pendingVerifications = $state(0);
  #revision = 0;
  #initialization = 0;
  #routesBase: string;
  #config: AuthClientConfig<User, Claims>;
  #errorCodec: AuthErrorCodec;

  constructor(config: AuthClientConfig<User, Claims> = {}) {
    this.#config = config;
    this.#routesBase = (config.routesBase ?? "/api/auth").replace(/\/+$/, "");
    this.#errorCodec = createAuthErrorCodec(config.errorClasses);
  }

  get user(): User | null { return this.#user; }
  set user(value: User | null) { this.#revision++; this.#user = value; }
  get claims(): Claims { return this.#claims; }
  set claims(value: Claims) { this.#revision++; this.#claims = value ?? EMPTY_CLAIMS as Claims; }
  get session(): AuthSession<User, Claims> | null {
    return this.#user ? { user: this.#user, claims: this.#claims } : null;
  }
  get sessionUser(): (User & Claims) | null {
    return this.#user ? { ...this.#user, ...this.#claims } : null;
  }
  get isReady(): boolean { return this.#isReady; }
  get isVerifying(): boolean { return this.#pendingVerifications > 0; }
  get isAuthenticated(): boolean { return this.#isReady && this.#user !== null; }

  /** Call during component initialization; getters follow SvelteKit load data. */
  init(user: MaybeGetter<User | null>, claims?: MaybeGetter<Claims | null | undefined>) {
    const initialization = ++this.#initialization;
    const read = () => ({
      user: typeof user === "function" ? (user as () => User | null)() : user,
      claims: (typeof claims === "function" ? claims() : claims) ?? EMPTY_CLAIMS as Claims,
    });
    let previous = read();
    const apply = (next: typeof previous) => {
      this.#revision++;
      this.#user = next.user;
      this.#claims = next.claims;
      this.#isReady = true;
    };
    apply(previous);
    let first = true;
    $effect(() => {
      const next = read();
      untrack(() => {
        if (initialization !== this.#initialization) return;
        if (next.user !== previous.user || next.claims !== previous.claims) {
          apply(next);
          previous = next;
        }
        if (first) {
          first = false;
          if (this.#user && this.#config.refreshOnInit !== false) {
            this.#isReady = false;
            const revision = this.#revision;
            void this.refresh().catch((error) => {
              console.warn("Initial auth refresh failed.", error);
            }).finally(() => {
              if (revision === this.#revision) this.#isReady = true;
            });
          }
        }
      });
    });
  }

  private parseSessionResponse(data: unknown): AuthSession<User, Claims> {
    const value = data as any;
    const user = value?.user;
    const claims = value?.claims ?? {};
    if (!user || typeof user.id !== "string" || !claims || typeof claims !== "object" || Array.isArray(claims)) {
      throw new Error("Invalid auth session response");
    }
    return { user, claims };
  }

  private async applySession(session: AuthSession<User, Claims> | null) {
    this.#user = session?.user ?? null;
    this.#claims = session?.claims ?? EMPTY_CLAIMS as Claims;
    this.#isReady = true;
    await this.#config.onSession?.(session);
  }

  private async invalidate() {
    const hadUser = this.#user !== null;
    this.#revision++;
    try {
      await this.applySession(null);
    } finally {
      if (hadUser) {
        try { await this.#config.onInvalidSession?.(); }
        finally { await this.#config.onLogout?.(); }
      }
    }
  }

  private async requestSession(action: string, body: unknown, revision: number, invalidateOn401 = false) {
    const response = await fetch(`${this.#routesBase}/${action}`, {
      method: "POST",
      ...(body !== undefined ? {
        body: JSON.stringify(body),
        headers: { "Content-Type": "application/json" },
      } : {}),
    });
    if (revision !== this.#revision) return this.session;
    if (response.status === 401 && invalidateOn401) {
      await this.invalidate();
      return null;
    }
    if (!response.ok) throw await readAuthError(response, this.#errorCodec);
    const session = this.parseSessionResponse(await response.json());
    if (revision !== this.#revision) return this.session;
    await this.applySession(session);
    return session;
  }

  private async authenticate(action: string, body: unknown): Promise<AuthSession<User, Claims>> {
    const revision = ++this.#revision;
    const session = await this.requestSession(action, body, revision);
    if (revision !== this.#revision) throw new Error("Auth request superseded");
    return session!;
  }

  login<Body = unknown>(body: Body): Promise<AuthSession<User, Claims>> {
    return this.authenticate("login", body);
  }
  loginWithGoogle(credential: string): Promise<AuthSession<User, Claims>> {
    return this.authenticate("google", { credential });
  }
  loginWithTma(body: { initData: string } & Record<string, unknown>): Promise<AuthSession<User, Claims>> {
    return this.authenticate("tma", body);
  }
  setClaims(claims: Claims): Promise<AuthSession<User, Claims> | null> {
    return this.requestSession("claims", claims, ++this.#revision, true);
  }
  async refresh(): Promise<AuthSession<User, Claims> | null> {
    const revision = this.#revision;
    this.#pendingVerifications++;
    try {
      return await this.requestSession("refresh", undefined, revision, true);
    } finally {
      this.#pendingVerifications--;
    }
  }

  /** Clears local state immediately; rejects if the server cannot clear its cookie. */
  async logout(): Promise<void> {
    this.#revision++;
    this.#user = null;
    this.#claims = EMPTY_CLAIMS as Claims;
    this.#isReady = true;
    try {
      const response = await fetch(`${this.#routesBase}/logout`, { method: "POST" });
      if (!response.ok) throw await readAuthError(response, this.#errorCodec);
    } finally {
      try { await this.#config.onSession?.(null); }
      finally { await this.#config.onLogout?.(); }
    }
  }
}

export function createAuth<
  User extends { id: string },
  Claims extends Record<string, unknown> = Record<string, never>,
>(config?: AuthClientConfig<User, Claims>): AuthClientState<User, Claims> {
  return new AuthClientState<User, Claims>(config);
}
