import { liveQuery } from 'dexie';

export type LiveQueryState<T> = {
  data?: T;
  isLoading: boolean;
  error?: unknown;
  dispose(): void;
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
    dispose: () => {},
  });

  const dispose = $effect.root(() => {
    $effect(() => {
      dependencies?.();
      query.data = undefined;
      query.error = undefined;
      query.isLoading = true;

      const subscription = liveQuery(querier).subscribe(
        (value) => {
          query.data = value;
          query.error = undefined;
          query.isLoading = false;
        },
        (error) => {
          query.error = error;
          query.isLoading = false;
        },
      );
      return () => subscription.unsubscribe();
    });
  });
  query.dispose = dispose;

  return query;
}
