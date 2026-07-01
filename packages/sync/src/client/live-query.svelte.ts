import { liveQuery } from "dexie";

export type LiveQueryState<T> = {
  data?: T;
  isLoading: boolean;
  error?: any;
};

/**
 * Creates Svelte-reactive state from a Dexie `liveQuery`.
 *
 * The query reruns when Dexie observes a relevant table change. If
 * `dependencies` is provided, Svelte also tracks those values so the effect can
 * be recreated when external inputs change.
 *
 * @example
 * ```ts
 * const todos = createLiveQuery(
 *   () => db.todos.where("done").equals(false).toArray(),
 *   () => [filter]
 * );
 * ```
 */
export function createLiveQuery<T>(
  querier: () => T | Promise<T>,
  dependencies?: () => unknown[],
): LiveQueryState<T> {
  const query = $state<LiveQueryState<T>>({
    data: undefined,
    isLoading: true,
    error: undefined,
  });

  $effect(() => {
    dependencies?.();

    return liveQuery(querier).subscribe(
      (value) => {
        query.error = undefined;

        if (value !== undefined) {
          query.data = value;
          query.isLoading = false;
        } else {
          query.isLoading = true;
        }
      },
      (error) => {
        query.error = error;
        query.isLoading = false;
      },
    ).unsubscribe;
  });

  return query;
}
