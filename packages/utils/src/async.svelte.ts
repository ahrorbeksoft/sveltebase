import { DEV } from "esm-env";
import { toast } from "svelte-sonner";
import { SvelteMap } from "svelte/reactivity";

export type TryCatchReturn =
  | { success: string; error?: never }
  | { error: string; success?: never }
  | null
  | void;

const GLOBAL_KEY = "__global__";

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
        toast.success(response.success);
      } else if (response?.error) {
        toast.error(response.error);
      }

      return response;
    } catch (err) {
      const e = err instanceof Error ? err : new Error(String(err));
      error = e;

      if (DEV) {
        toast.error(e.name, { description: e.message });
        console.error("[Dev Error]:", e);
      } else {
        toast.error("Something went wrong");
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
