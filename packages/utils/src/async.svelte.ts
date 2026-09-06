import { BROWSER, DEV } from "esm-env";
import { SvelteMap } from "svelte/reactivity";

/**
 * Return shape consumed by `createAsync` and `tryCatch`.
 *
 * Returning `{ success }` shows a success toast. Returning `{ error }` shows an
 * error toast. `null` and `void` complete silently.
 */
export type TryCatchReturn =
  | { success: string; error?: never }
  | { error: string; success?: never }
  | null
  | void;

const GLOBAL_KEY = "__global__";

type ToastModule = typeof import("svelte-sonner");
let toastModulePromise: Promise<ToastModule | null> | null = null;

/**
 * Lazily imports `svelte-sonner` in the browser.
 */
async function getToastModule(): Promise<ToastModule | null> {
  if (!BROWSER) {
    return null;
  }

  if (!toastModulePromise) {
    toastModulePromise = import("svelte-sonner")
      .then((module) => ({ toast: module.toast }) as ToastModule)
      .catch((error) => {
        if (DEV) {
          console.error("[createAsync] Failed to load svelte-sonner:", error);
        }

        return null;
      });
  }

  return toastModulePromise;
}

/**
 * Shows a success toast for async action results.
 */
async function toastSuccess(message: string) {
  const toastModule = await getToastModule();
  toastModule?.toast.success(message);
}

/**
 * Shows an error toast for async action results.
 */
async function toastError(message: string, description?: string) {
  const toastModule = await getToastModule();
  toastModule?.toast.error(message, description ? { description } : undefined);
}

/**
 * Wraps an async function with reactive loading and error state.
 *
 * Use `run` for one global loading flag, or `runWithKey` when one wrapped
 * function has multiple independent buttons/actions.
 *
 * @example
 * ```ts
 * const save = createAsync(async (id: string) => {
 *   await api.save(id);
 *   return { success: "Saved" };
 * });
 *
 * await save.runWithKey(id, id);
 * ```
 */
export function createAsync<T extends (...args: any[]) => Promise<TryCatchReturn> | Promise<void>>(
  asyncFn: T
) {
  const loadingStates = new SvelteMap<string, number>();
  let error = $state<Error | null>(null);

  /**
   * Runs the wrapped function and tracks loading under one key.
   */
  async function execute(id: string, args: Parameters<T>) {
    try {
      loadingStates.set(id, (loadingStates.get(id) ?? 0) + 1);
      error = null;

      const response = await asyncFn(...args);

      if (response?.success) {
        await toastSuccess(response.success);
      } else if (response?.error) {
        await toastError(response.error);
      }

      return response;
    } catch (err) {
      const e = err instanceof Error ? err : new Error(String(err));
      error = e;

      if (DEV) {
        await toastError(e.name, e.message);
        console.error("[Dev Error]:", e);
      } else {
        await toastError("Something went wrong");
      }

      throw e;
    } finally {
      const remaining = (loadingStates.get(id) ?? 1) - 1;
      if (remaining > 0) loadingStates.set(id, remaining);
      else loadingStates.delete(id);
    }
  }

  /**
   * Executes using the global loading key.
   */
  async function run(...args: Parameters<T>) {
    return execute(GLOBAL_KEY, args);
  }

  /**
   * Executes using an explicit loading key.
   */
  async function runWithKey(key: string, ...args: Parameters<T>) {
    return execute(key || GLOBAL_KEY, args);
  }

  return {
    /**
     * Checks loading state.
     *
     * Pass a key for specific actions, or call without args for global actions.
     */
    isLoading(key?: string) {
      return (loadingStates.get(key || GLOBAL_KEY) ?? 0) > 0;
    },
    get error() {
      return error;
    },
    run,
    runWithKey
  };
}
