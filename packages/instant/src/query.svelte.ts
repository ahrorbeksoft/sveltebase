import type {
  InstantQuery,
  InstantQueryResult,
  InstantSvelteDatabase,
} from "@instantdb/svelte";

export type SubscribeQueryResponse<
  TDatabase extends InstantSvelteDatabase<any, any>,
  TQuery extends InstantQuery<TDatabase>
> = {
  data?: InstantQueryResult<TDatabase, TQuery>;
  error?: unknown;
};

export type InstantQueryClient = InstantSvelteDatabase<any, any>;

export type QueryState<
  TDatabase extends InstantSvelteDatabase<any, any>,
  TQuery extends InstantQuery<TDatabase>
> = {
  isLoading: boolean;
  data: InstantQueryResult<TDatabase, TQuery> | null;
};

export interface BoundInstantHelpers<TDatabase extends InstantQueryClient> {
  queryOnce<TQuery extends InstantQuery<TDatabase>>(
    query: TQuery,
    timeoutMs?: number
  ): Promise<InstantQueryResult<TDatabase, TQuery>>;
  useQuery<TQuery extends InstantQuery<TDatabase>>(
    queryInput: MaybeGetter<TQuery | null>,
    initialData?: MaybeGetter<InstantQueryResult<TDatabase, TQuery> | null>
  ): QueryState<TDatabase, TQuery>;
  prefetchQuery<TQuery extends InstantQuery<TDatabase>>(
    query: TQuery,
    fetcher: (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>,
    endpoint?: string
  ): Promise<InstantQueryResult<TDatabase, TQuery> | null>;
}

type MaybeGetter<T> = T | (() => T);

export async function queryOnce<
  TDatabase extends InstantQueryClient,
  TQuery extends InstantQuery<TDatabase>
>(
  db: TDatabase,
  query: TQuery,
  timeoutMs = 5000
): Promise<InstantQueryResult<TDatabase, TQuery>> {
  return new Promise((resolve, reject) => {
    let unsubscribe: (() => void) | undefined;
    let settled = false;

    const finish = (handler: () => void) => {
      if (settled) {
        return;
      }

      settled = true;
      clearTimeout(timeout);
      unsubscribe?.();
      handler();
    };

    const timeout = setTimeout(() => {
      finish(() => reject(new Error("InstantDB query timed out")));
    }, timeoutMs);

    unsubscribe = db.core.subscribeQuery(query, (response) => {
      if (response.error) {
        finish(() => reject(normalizeError(response.error)));
        return;
      }

      if (response.data !== undefined) {
        finish(() => resolve(response.data as InstantQueryResult<TDatabase, TQuery>));
      }
    });

    if (settled) {
      unsubscribe?.();
    }
  });
}

export function useQuery<
  TDatabase extends InstantQueryClient,
  TQuery extends InstantQuery<TDatabase>
>(
  db: TDatabase,
  queryInput: MaybeGetter<TQuery | null>,
  initialData?: MaybeGetter<InstantQueryResult<TDatabase, TQuery> | null>
) {
  const initial = unwrap(initialData) ?? null;
  const state = $state<QueryState<TDatabase, TQuery>>({
    isLoading: initial == null,
    data: initial
  });

  $effect(() => {
    const query = unwrap(queryInput);

    if (!query) {
      return;
    }

    return db.core.subscribeQuery(query, (response) => {
      if (response.error) {
        throw normalizeError(response.error);
      }

      if (response.data !== undefined) {
        state.isLoading = false;
        state.data = response.data as InstantQueryResult<TDatabase, TQuery>;
      }
    });
  });

  return state;
}

export async function prefetchQuery<
  TDatabase extends InstantQueryClient,
  TQuery extends InstantQuery<TDatabase>
>(
  db: TDatabase,
  query: TQuery,
  fetcher: (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>,
  endpoint = "/api/query"
): Promise<InstantQueryResult<TDatabase, TQuery> | null> {
  if (typeof window !== "undefined") {
    return queryOnce(db, query);
  }

  const response = await fetcher(endpoint, {
    method: "POST",
    body: JSON.stringify({ query })
  });

  return response.ok ? ((await response.json()) as InstantQueryResult<TDatabase, TQuery>) : null;
}

export function createInstantHelpers<TDatabase extends InstantQueryClient>(
  db: TDatabase
): BoundInstantHelpers<TDatabase> {
  return {
    queryOnce: <TQuery extends InstantQuery<TDatabase>>(query: TQuery, timeoutMs?: number) =>
      queryOnce(db, query, timeoutMs),
    useQuery: <TQuery extends InstantQuery<TDatabase>>(
      queryInput: MaybeGetter<TQuery | null>,
      initialData?: MaybeGetter<InstantQueryResult<TDatabase, TQuery> | null>
    ) => useQuery(db, queryInput, initialData),
    prefetchQuery: <TQuery extends InstantQuery<TDatabase>>(
      query: TQuery,
      fetcher: (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>,
      endpoint?: string
    ) => prefetchQuery(db, query, fetcher, endpoint)
  };
}

function unwrap<T>(value: MaybeGetter<T> | undefined): T | undefined {
  return typeof value === "function" ? (value as () => T)() : value;
}

function normalizeError(error: unknown) {
  return error instanceof Error ? error : new Error(String(error));
}
