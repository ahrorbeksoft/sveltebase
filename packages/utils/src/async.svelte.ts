import { BROWSER, DEV } from "esm-env";
import { SvelteMap } from "svelte/reactivity";

export type TryCatchReturn =
  | { success: string; error?: never }
  | { error: string; success?: never }
  | null
  | void;

const GLOBAL_KEY = "__global__";

type ToastModule = typeof import("svelte-sonner");
let toastModulePromise: Promise<ToastModule | null> | null = null;

async function getToastModule(): Promise<ToastModule | null> {
  if (!BROWSER) {
    return null;
  }

  if (!toastModulePromise) {
    toastModulePromise = import("svelte-sonner")
      .then((module) => module)
      .catch((error) => {
        if (DEV) {
          console.error("[createAsync] Failed to load svelte-sonner:", error);
        }

        return null;
      });
  }

  return toastModulePromise;
}

async function toastSuccess(message: string) {
  const toastModule = await getToastModule();
  toastModule?.toast.success(message);
}

async function toastError(message: string, description?: string) {
  const toastModule = await getToastModule();
  toastModule?.toast.error(message, description ? { description } : undefined);
}

export function createAsync<T extends (...args: any[]) => Promise<TryCatchReturn> | Promise<void>>(
  asyncFn: T
) {
  const loadingStates = $state(new SvelteMap<string, boolean>());
  let error = $state<Error | null>(null);

  async function execute(id: string, args: Parameters<T>) {
    try {
      loadingStates.set(id, true);
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
      loadingStates.set(id, false);
    }
  }

  /**
   * Execute using the global loading key.
   */
  async function run(...args: Parameters<T>) {
    return execute(GLOBAL_KEY, args);
  }

  /**
   * Execute using an explicit loading key.
   */
  async function runWithKey(key: string, ...args: Parameters<T>) {
    return execute(key || GLOBAL_KEY, args);
  }

  return {
    /**
     * Check loading state.
     * Pass a key for specific actions, or call without args for global actions.
     */
    isLoading(key?: string) {
      return loadingStates.get(key ?? GLOBAL_KEY) ?? false;
    },
    get error() {
      return error;
    },
    run,
    runWithKey
  };
}
