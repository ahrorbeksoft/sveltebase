import { SvelteMap } from 'svelte/reactivity';
import type {
  NotificationAdapter,
  NotificationMessage,
} from './notifications.js';
import { notify } from './notifications.js';

/** An optional user-facing result returned by an async action. */
export type AsyncResult =
  | { success: string; error?: never }
  | { error: string; success?: never }
  | null
  | void;

/** @deprecated Use `AsyncResult`. */
export type TryCatchReturn = AsyncResult;

export interface AsyncOptions {
  /** Adapter used for this helper; defaults to the shared notification adapter. */
  notifications?: NotificationAdapter | null;
  /** Turns a thrown value into an exposed Error. */
  toError?: (error: unknown) => Error;
}

const GLOBAL_KEY = '__global__';

function asError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error));
}

/**
 * Wraps an async function with reactive loading counts and a last-started error.
 *
 * Calls using the same key increment its count independently. The latest call
 * started by this helper owns `error`, so an older rejection cannot overwrite a
 * newer call's result. Completed keys are removed from the reactive map.
 */
export function createAsync<
  T extends (...args: never[]) => Promise<AsyncResult> | AsyncResult,
>(operation: T, options: AsyncOptions = {}) {
  const counts = new SvelteMap<string, number>();
  let error = $state<Error | null>(null);
  let lastStarted = 0;

  async function execute(
    key: string,
    args: Parameters<T>,
  ): Promise<Awaited<ReturnType<T>>> {
    const invocation = ++lastStarted;
    counts.set(key, (counts.get(key) ?? 0) + 1);
    error = null;

    try {
      const result = await operation(...args);
      if (result?.success)
        await notify(
          'success',
          { message: result.success },
          options.notifications,
        );
      if (result?.error)
        await notify('error', { message: result.error }, options.notifications);
      return result as Awaited<ReturnType<T>>;
    } catch (reason) {
      const failure = options.toError?.(reason) ?? asError(reason);
      if (invocation === lastStarted) error = failure;
      await notify(
        'error',
        { message: failure.message },
        options.notifications,
      );
      throw failure;
    } finally {
      const remaining = (counts.get(key) ?? 1) - 1;
      if (remaining > 0) counts.set(key, remaining);
      else counts.delete(key);
    }
  }

  return {
    /** True while one or more calls using this key are in progress. */
    isLoading(key = GLOBAL_KEY): boolean {
      return (counts.get(key || GLOBAL_KEY) ?? 0) > 0;
    },
    /** Number of calls in progress for a key. */
    pendingCount(key = GLOBAL_KEY): number {
      return counts.get(key || GLOBAL_KEY) ?? 0;
    },
    /** Error from the latest invocation started by this helper, if it failed. */
    get error(): Error | null {
      return error;
    },
    run(...args: Parameters<T>): Promise<Awaited<ReturnType<T>>> {
      return execute(GLOBAL_KEY, args);
    },
    runWithKey(
      key: string,
      ...args: Parameters<T>
    ): Promise<Awaited<ReturnType<T>>> {
      return execute(key || GLOBAL_KEY, args);
    },
  };
}

export type { NotificationAdapter, NotificationMessage };
