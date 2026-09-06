import { Cookies } from "@sveltebase/utils";

/**
 * Value or getter used when state must read reactive Svelte data lazily.
 */
export type MaybeGetter<T> = T | (() => T);

/**
 * Minimal Standard Schema v1 shape supported by `PersistentState`.
 *
 * Libraries such as Valibot or other Standard Schema-compatible validators can
 * provide this shape. Validation must be synchronous for persistent state.
 */
export interface StandardSchemaV1<Input = unknown, Output = Input> {
  readonly "~standard": {
    readonly version: 1;
    readonly vendor: string;
    readonly validate: (
      value: unknown
    ) =>
      | { readonly value: Output; readonly issues?: undefined }
      | { readonly issues: ReadonlyArray<{ readonly message: string }> }
      | Promise<
          | { readonly value: Output; readonly issues?: undefined }
          | { readonly issues: ReadonlyArray<{ readonly message: string }> }
        >;
    readonly types?: {
      readonly input: Input;
      readonly output: Output;
    };
  };
}

/**
 * Extracts the accepted input type from a Standard Schema.
 */
export type InferInput<TSchema extends StandardSchemaV1> =
  NonNullable<TSchema["~standard"]["types"]>["input"];

/**
 * Extracts the parsed output type from a Standard Schema.
 */
export type InferOutput<TSchema extends StandardSchemaV1> =
  NonNullable<TSchema["~standard"]["types"]>["output"];

/**
 * Svelte-reactive state that persists to a browser cookie.
 *
 * On the server it initializes from `undefined` until `init` is called with
 * the request cookie value. In the browser it hydrates from `document.cookie` and writes
 * every valid state change back to the cookie.
 *
 * @example
 * ```ts
 * const theme = new PersistentState("theme", themeSchema);
 * theme.current = "dark";
 * ```
 */
export class PersistentState<TSchema extends StandardSchemaV1> {
  #value = $state<InferOutput<TSchema>>();

  private storageKey: string;
  private schema: TSchema;

  /**
   * Creates persistent state for one cookie key.
   *
   * The schema validates both hydrated cookie data and values assigned later.
   */
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

  /**
   * Current parsed state value.
   */
  get current() {
    return this.#value as InferOutput<TSchema>;
  }

  /**
   * Replaces the current value after validating it with the schema.
   */
  set current(newValue: InferOutput<TSchema>) {
    this.#value = parseSchema(this.schema, newValue);
  }

  /**
   * Initializes server-side state from its serialized cookie value.
   *
   * Pass `cookies.get(key)` during SSR so the first rendered value matches the
   * browser cookie. Missing or invalid values use the schema default.
   */
  public init(cookieValue?: MaybeGetter<string | null | undefined>) {
    if (hasWindow()) {
      return;
    }

    const rawCookie = unwrap(cookieValue);

    try {
      const parsed = rawCookie != null
        ? parseSchema(this.schema, parseStoredCookieValue(rawCookie))
        : parseSchema(this.schema, undefined);

      if (JSON.stringify(parsed) !== JSON.stringify(this.#value)) {
        this.#value = parsed;
      }
    } catch {
      console.warn(`[PersistentState] Init failed for "${this.storageKey}"`);
      this.#value = parseSchema(this.schema, undefined);
    }
  }

  /**
   * Updates the current value from a callback.
   *
   * Use this when the next value depends on the previous value.
   */
  public set(fn: (value: InferOutput<TSchema>) => InferOutput<TSchema>) {
    this.current = fn(this.#value as InferOutput<TSchema>);
  }

  /**
   * Reads and validates the initial value for a cookie key.
   */
  private static hydrate<TSchema extends StandardSchemaV1>(
    key: string,
    schema: TSchema
  ): InferOutput<TSchema> {
    if (!hasWindow()) {
      return parseSchema(schema, undefined);
    }

    const rawCookie = Cookies.get(key);

    if (rawCookie) {
      try {
        return parseSchema(schema, parseStoredCookieValue(rawCookie));
      } catch {
        console.warn(`[PersistentState] Invalid data for "${key}". Resetting.`);
      }
    }

    return parseSchema(schema, undefined);
  }
}

/**
 * Small Svelte-reactive value holder.
 *
 * Useful when you want class-style state with a `current` getter/setter and an
 * updater callback, without cookie persistence.
 */
export class State<T> {
  #internalState = $state<T>() as T;

  /**
   * Creates state with an initial value.
   */
  constructor(initialValue: T) {
    this.#internalState = initialValue;
  }

  /**
   * Current reactive value.
   */
  get current() {
    return this.#internalState;
  }

  /**
   * Replaces the current reactive value.
   */
  set current(value: T) {
    this.#internalState = value;
  }

  /**
   * Updates the value from its previous value.
   */
  set(fn: (value: T) => T) {
    this.#internalState = fn(this.#internalState);
  }
}

/**
 * Evaluates a getter or returns a static value.
 */
function unwrap<T>(value: MaybeGetter<T>): T {
  return typeof value === "function" ? (value as () => T)() : value;
}

/**
 * Parses a cookie value written as JSON, supporting encoded legacy values.
 */
function parseStoredCookieValue(value: string): unknown {
  try {
    return JSON.parse(value);
  } catch {
    return JSON.parse(decodeURIComponent(value));
  }
}

/**
 * Runs a Standard Schema validator and returns its parsed value.
 *
 * Async validators are rejected because Svelte state initialization must be
 * synchronous.
 */
function parseSchema<TSchema extends StandardSchemaV1>(
  schema: TSchema,
  value: unknown
): InferOutput<TSchema> {
  const result = schema["~standard"].validate(value);

  if (result instanceof Promise) {
    throw new Error("[PersistentState] Async schemas are not supported.");
  }

  if (result.issues) {
    throw new Error(
      result.issues.map((issue) => issue.message).join(", ") || "Validation failed."
    );
  }

  return result.value as InferOutput<TSchema>;
}

/**
 * Returns true when running in a browser environment.
 */
function hasWindow() {
  return typeof window !== "undefined";
}
