import { liveQuery } from "dexie";

export type LiveQueryState<T> = {
  data?: T;
  isLoading: boolean;
  error?: any;
};

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
