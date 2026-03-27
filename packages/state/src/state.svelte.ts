import { Cookies } from "@sveltebase/utils";

export type MaybeGetter<T> = T | (() => T);

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

export type InferInput<TSchema extends StandardSchemaV1> =
  NonNullable<TSchema["~standard"]["types"]>["input"];

export type InferOutput<TSchema extends StandardSchemaV1> =
  NonNullable<TSchema["~standard"]["types"]>["output"];

export class PersistentState<TSchema extends StandardSchemaV1> {
  #value = $state<InferOutput<TSchema>>();

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
    return this.#value as InferOutput<TSchema>;
  }

  set current(newValue: InferOutput<TSchema>) {
    this.#value = parseSchema(this.schema, newValue);
  }

  public init(cookies: MaybeGetter<{ name: string; value: string }[]>) {
    if (hasWindow()) {
      return;
    }

    const resolvedCookies = unwrap(cookies);
    const rawCookie = resolvedCookies.find((cookie) => cookie.name === this.storageKey);

    try {
      const parsed = rawCookie
        ? parseSchema(this.schema, parseStoredCookieValue(rawCookie.value))
        : parseSchema(this.schema, undefined);

      if (JSON.stringify(parsed) !== JSON.stringify(this.#value)) {
        this.#value = parsed;
      }
    } catch {
      console.warn(`[PersistentState] Init failed for "${this.storageKey}"`);
    }
  }

  public set(fn: (value: InferOutput<TSchema>) => InferOutput<TSchema>) {
    this.#value = fn(this.#value as InferOutput<TSchema>);
  }

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

function parseStoredCookieValue(value: string): unknown {
  try {
    return JSON.parse(value);
  } catch {
    return JSON.parse(decodeURIComponent(value));
  }
}

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

function hasWindow() {
  return typeof window !== "undefined";
}
