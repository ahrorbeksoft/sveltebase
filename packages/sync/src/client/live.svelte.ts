import { onDestroy } from "svelte";
import { liveQuery } from "dexie";

export type LiveQueryResult<T> =
  | { status: "loading"; data: undefined; error: undefined; isLoading: true }
  | { status: "success"; data: T; error: undefined; isLoading: false }
  | { status: "error"; data: undefined; error: any; isLoading: false };

export function useLiveQuery<T>(queryFn: () => Promise<T> | T): LiveQueryResult<T> {
  let data = $state<T | undefined>(undefined);
  let error = $state<any>(undefined);
  let status = $state<"loading" | "success" | "error">("loading");

  if (typeof window !== "undefined") {
    const observable = liveQuery(queryFn);
    const subscription = observable.subscribe({
      next: (val) => {
        data = val;
        error = undefined;
        status = "success";
      },
      error: (err) => {
        data = undefined;
        error = err;
        status = "error";
        console.error("liveQuery error:", err);
      },
    });
    onDestroy(() => {
      subscription.unsubscribe();
    });
  }

  return {
    get data() {
      return data;
    },
    get error() {
      return error;
    },
    get status() {
      return status;
    },
    get isLoading() {
      return status === "loading";
    },
  } as unknown as LiveQueryResult<T>;
}

