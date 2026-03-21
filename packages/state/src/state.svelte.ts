import { z } from "zod";
import { Cookies } from "@sveltebase/utils";

export type MaybeGetter<T> = T | (() => T);

export class PersistentState<TSchema extends z.ZodTypeAny> {
  #value = $state<z.output<TSchema>>();
  #initialized = false;

  private storageKey: string;
  private schema: TSchema;

  constructor(key: string, schema: TSchema) {
    this.storageKey = key;
    this.schema = schema;
    this.#value = PersistentState.hydrate(key, schema);

    $effect.root(() => {
      $effect(() => {
        if (!hasWindow()) {
          return;
        }

        Cookies.set(this.storageKey, JSON.stringify(this.#value), {
          sameSite: "Lax",
          expires: 365
        });
      });
    });
  }

  get current() {
    return this.#value as z.output<TSchema>;
  }

  set current(newValue: z.output<TSchema>) {
    this.#value = this.schema.parse(newValue);
  }

  public init(cookies: MaybeGetter<{ name: string; value: string }[]>) {
    if (this.#initialized || hasWindow()) {
      return;
    }

    this.#initialized = true;

    const resolvedCookies = unwrap(cookies);
    const rawCookie = resolvedCookies.find((cookie) => cookie.name === this.storageKey);

    if (!rawCookie) {
      return;
    }

    try {
      const parsed = this.schema.parse(JSON.parse(rawCookie.value));

      if (JSON.stringify(parsed) !== JSON.stringify(this.#value)) {
        this.#value = parsed;
      }
    } catch {
      console.warn(`[PersistentState] Init failed for "${this.storageKey}"`);
    }
  }

  public set(fn: (value: z.output<TSchema>) => z.output<TSchema>) {
    this.#value = fn(this.#value as z.output<TSchema>);
  }

  private static hydrate<TSchema extends z.ZodTypeAny>(key: string, schema: TSchema): z.output<TSchema> {
    if (!hasWindow()) {
      return schema.parse(undefined);
    }

    const rawCookie = Cookies.get(key);

    if (rawCookie) {
      try {
        return schema.parse(JSON.parse(rawCookie));
      } catch {
        console.warn(`[PersistentState] Invalid data for "${key}". Resetting.`);
      }
    }

    return schema.parse(undefined);
  }
}

export class State<T> {
  #internalState = $state<T>() as T;

  constructor(initialValue: T) {
    this.#internalState = initialValue;
  }

  get current() {
    return this.#internalState;
  }

  set current(value: T) {
    this.#internalState = value;
  }

  set(fn: (value: T) => T) {
    this.#internalState = fn(this.#internalState);
  }
}

function unwrap<T>(value: MaybeGetter<T>): T {
  return typeof value === "function" ? (value as () => T)() : value;
}

function hasWindow() {
  return typeof window !== "undefined";
}
