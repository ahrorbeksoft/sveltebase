import type {
  BoundInstantAuth,
  InstantAuthOptions,
  InstantBoundUser,
  InstantQueryClient
} from "./types.js";

class Auth<TDatabase extends InstantQueryClient> implements BoundInstantAuth<TDatabase> {
  #initUser = $state<InstantBoundUser<TDatabase> | undefined>(undefined);
  #user = $state<InstantBoundUser<TDatabase> | undefined>(undefined);
  #initialized = $state(false);
  #unsubscribe: (() => void) | undefined;
  #endpoint: string;
  #fetcher: (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;

  constructor(db: TDatabase, options: InstantAuthOptions = {}) {
    this.#endpoint = options.endpoint ?? "/api/instant/auth";
    this.#fetcher = options.fetcher ?? fetch;

    this.#unsubscribe = db.core.subscribeAuth((response) => {
      this.#user = response.user as InstantBoundUser<TDatabase> | undefined;
    });

    $effect.root(() => {
      $effect(() => {
        if (!this.#initialized) {
          return;
        }

        const currentUser = $state.snapshot(this.#user);
        const initialUser = $state.snapshot(this.#initUser);

        if (JSON.stringify(currentUser) !== JSON.stringify(initialUser)) {
          void this.performSync(this.#user);
        }
      });
    });
  }

  init(user: InstantBoundUser<TDatabase> | undefined): void {
    this.#initUser = user;

    if (!this.#user) {
      this.#user = user;
    }

    this.#initialized = true;
  }

  get user(): InstantBoundUser<TDatabase> | undefined {
    return this.#user;
  }

  get initialized(): boolean {
    return this.#initialized;
  }

  destroy(): void {
    this.#unsubscribe?.();
    this.#unsubscribe = undefined;
  }

  private async performSync(userData: InstantBoundUser<TDatabase> | undefined): Promise<void> {
    try {
      await this.#fetcher(this.#endpoint, {
        method: "POST",
        headers: {
          "Content-Type": "application/json"
        },
        body: JSON.stringify({ user: userData ?? null })
      });

      this.#initUser = userData;
    } catch (error) {
      console.error("Failed to sync Instant auth state to the server:", error);
    }
  }
}

export function createInstantAuth<TDatabase extends InstantQueryClient>(
  db: TDatabase,
  options: InstantAuthOptions = {}
): BoundInstantAuth<TDatabase> {
  return new Auth(db, options);
}
