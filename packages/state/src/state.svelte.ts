import { Cookies, type CookieOptions } from '@sveltebase/utils/cookies';

/** Value or getter used when request data is available lazily. */
export type MaybeGetter<T> = T | (() => T);

/** Minimal synchronous Standard Schema v1 contract. */
export interface StandardSchemaV1<Input = unknown, Output = Input> {
  readonly '~standard': {
    readonly version: 1;
    readonly vendor: string;
    readonly validate:
      | ((value: unknown) => StandardSchemaResult<Output>)
      | ((value: unknown) => Promise<StandardSchemaResult<Output>>);
    readonly types?: { readonly input: Input; readonly output: Output };
  };
}

export type StandardSchemaResult<Output> =
  | { readonly value: Output; readonly issues?: undefined }
  | { readonly issues: ReadonlyArray<{ readonly message: string }> };

/** Extracts a Standard Schema input type. */
export type InferInput<TSchema extends StandardSchemaV1> = NonNullable<
  TSchema['~standard']['types']
>['input'];

/** Extracts a Standard Schema output type. */
export type InferOutput<TSchema extends StandardSchemaV1> = NonNullable<
  TSchema['~standard']['types']
>['output'];

/** Storage boundary used by persistent state. It is deliberately framework-neutral. */
export interface StatePersistence {
  read(key: string): string | null;
  write(key: string, value: string): void;
}

/** A request cookie shape accepted by `PersistentState.init`. */
export interface RequestCookie {
  name: string;
  value: string;
}

/**
 * Explicit configuration for persistent state. An initial value is required;
 * state never assumes that a schema accepts `undefined`.
 */
export interface PersistentStateOptions<TSchema extends StandardSchemaV1> {
  initial: InferInput<TSchema>;
  /** Defaults to browser cookies. Set false for validated in-memory state. */
  persistence?: StatePersistence | false;
  /** Options for the default browser-cookie persistence. */
  cookie?: CookieOptions;
  /** Encodes values for storage. It must return a string. */
  serialize?: (value: InferOutput<TSchema>) => string;
  /** Decodes a string read from storage. */
  deserialize?: (value: string) => unknown;
  /** Receives storage failures without changing the validated in-memory value. */
  onPersistenceError?: (error: Error) => void;
}

function hasBrowser(): boolean {
  return typeof window !== 'undefined' && typeof document !== 'undefined';
}

function isPromiseLike(value: unknown): value is PromiseLike<unknown> {
  return typeof value === 'object' && value !== null && 'then' in value;
}

function parseSchema<TSchema extends StandardSchemaV1>(
  schema: TSchema,
  value: unknown,
): InferOutput<TSchema> {
  const result = schema['~standard'].validate(value);
  if (isPromiseLike(result)) {
    throw new TypeError('PersistentState only supports synchronous schemas.');
  }
  if (result.issues) {
    throw new TypeError(
      result.issues.map((issue) => issue.message).join(', ') ||
        'Validation failed.',
    );
  }
  return result.value as InferOutput<TSchema>;
}

function cloneSnapshot<T>(value: T): T {
  if (typeof structuredClone === 'function') return structuredClone(value);
  try {
    return JSON.parse(JSON.stringify(value)) as T;
  } catch {
    throw new TypeError('State values must be structured-cloneable.');
  }
}

function freezeSnapshot<T>(value: T, seen = new WeakSet<object>()): T {
  if (typeof value !== 'object' || value === null || seen.has(value))
    return value;
  if (!Array.isArray(value)) {
    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) {
      throw new TypeError(
        'State snapshots only support plain objects and arrays.',
      );
    }
  }
  seen.add(value);
  for (const child of Object.values(value)) freezeSnapshot(child, seen);
  return Object.freeze(value);
}

function immutableSnapshot<T>(value: T): T {
  return freezeSnapshot(cloneSnapshot(value));
}

function decodeJson(value: string): unknown {
  return JSON.parse(value);
}

function defaultPersistence(
  options: CookieOptions | undefined,
): StatePersistence | false {
  if (!hasBrowser()) return false;
  return {
    read: (key) => Cookies.get(key),
    write: (key, value) =>
      Cookies.set(key, value, { expires: 365, ...options }),
  };
}

/**
 * Svelte-reactive state that validates every value and exposes immutable
 * snapshots. Nested writes therefore fail instead of silently evading schema
 * validation; use `set` to produce a new value.
 *
 * Persistent instances are browser/request scoped. Create an instance inside
 * request setup during SSR, then call `init` with that request's cookies.
 */
export class PersistentState<TSchema extends StandardSchemaV1> {
  #value = $state<InferOutput<TSchema>>() as InferOutput<TSchema>;
  #initial: InferOutput<TSchema>;
  #persistence: StatePersistence | false;
  #serialize: (value: InferOutput<TSchema>) => string;
  #deserialize: (value: string) => unknown;
  #onPersistenceError: ((error: Error) => void) | undefined;
  #disposePersistence: (() => void) | null = null;
  #persistenceError = $state<Error | null>(null);

  constructor(
    readonly key: string,
    readonly schema: TSchema,
    options: PersistentStateOptions<TSchema>,
  ) {
    if (!key) throw new TypeError('PersistentState requires a non-empty key.');

    this.#serialize = options.serialize ?? JSON.stringify;
    this.#deserialize = options.deserialize ?? decodeJson;
    this.#onPersistenceError = options.onPersistenceError;
    this.#initial = this.prepare(options.initial);
    this.#persistence =
      options.persistence === undefined
        ? defaultPersistence(options.cookie)
        : options.persistence;
    this.#value = this.hydrate();

    if (this.#persistence) {
      this.#disposePersistence = $effect.root(() => {
        $effect(() => {
          const persistence = this.#persistence;
          if (persistence) this.write(persistence);
        });
      });
    }
  }

  /** Current validated, immutable value. */
  get current(): InferOutput<TSchema> {
    return this.#value;
  }

  /** Most recent storage failure, if persistence could not read or write. */
  get persistenceError(): Error | null {
    return this.#persistenceError;
  }

  /** Validates, snapshots, and persists a replacement value. */
  set current(value: InferInput<TSchema>) {
    this.#value = this.prepare(value);
  }

  /** Validates, snapshots, and persists an updater result. */
  set(updater: (value: InferOutput<TSchema>) => InferInput<TSchema>): void {
    this.#value = this.prepare(updater(this.#value));
  }

  /**
   * Initializes this server instance from one request. Missing or invalid
   * cookies always reset to this instance's explicit initial value.
   */
  init(cookies: MaybeGetter<readonly RequestCookie[]>): void {
    if (hasBrowser()) return;
    const all = typeof cookies === 'function' ? cookies() : cookies;
    const cookie = all.find((candidate) => candidate.name === this.key);
    this.#value = cookie ? this.parseStored(cookie.value) : this.#initial;
  }

  /** Stops browser persistence. State remains usable in memory after disposal. */
  dispose(): void {
    this.#disposePersistence?.();
    this.#disposePersistence = null;
  }

  private hydrate(): InferOutput<TSchema> {
    if (!this.#persistence) return this.#initial;
    let raw: string | null;
    try {
      raw = this.#persistence.read(this.key);
    } catch (reason) {
      this.reportPersistenceError(reason);
      return this.#initial;
    }
    return raw === null || raw === undefined
      ? this.#initial
      : this.parseStored(raw);
  }

  private write(persistence: StatePersistence): void {
    try {
      persistence.write(this.key, this.serializeValue(this.#value));
      this.#persistenceError = null;
    } catch (reason) {
      this.reportPersistenceError(reason);
    }
  }

  private reportPersistenceError(reason: unknown): void {
    const error = reason instanceof Error ? reason : new Error(String(reason));
    this.#persistenceError = error;
    try {
      this.#onPersistenceError?.(error);
    } catch {
      // Persistence reporting cannot change a successful state update.
    }
  }

  private parseStored(raw: string): InferOutput<TSchema> {
    try {
      return this.prepare(this.#deserialize(raw));
    } catch {
      return this.#initial;
    }
  }

  private prepare(value: unknown): InferOutput<TSchema> {
    const parsed = immutableSnapshot(parseSchema(this.schema, value));
    // Reject undefined or serializers that return non-strings before changing
    // state, keeping writes and updater callbacks equally atomic.
    this.serializeValue(parsed);
    return parsed;
  }

  private serializeValue(value: InferOutput<TSchema>): string {
    const serialized = this.#serialize(value);
    if (typeof serialized !== 'string') {
      throw new TypeError('PersistentState values must serialize to a string.');
    }
    return serialized;
  }
}

/** Svelte-reactive immutable in-memory state. */
export class State<T> {
  #value = $state<T>() as T;

  constructor(initial: T) {
    this.#value = immutableSnapshot(initial);
  }

  get current(): T {
    return this.#value;
  }

  set current(value: T) {
    this.#value = immutableSnapshot(value);
  }

  set(updater: (value: T) => T): void {
    this.#value = immutableSnapshot(updater(this.#value));
  }
}
