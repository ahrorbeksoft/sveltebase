import type { InstaQLParams, InstaQLResult, ValidQuery } from "@instantdb/svelte";
import { createInstantAuth } from "./auth.svelte.js";
import type {
  BoundInstantAuth,
  BoundInstantHelpers,
  InferDatabaseSchema,
  InstantAuthOptions,
  InstantQueryClient,
  MaybeGetter,
  QueryState,
  SubscribeQueryResponse
} from "./types.js";

export interface CreateInstantHelpersOptions {
  auth?: InstantAuthOptions;
}

function subscribeQuery<
  TDatabase extends InstantQueryClient,
  TQuery extends InstaQLParams<InferDatabaseSchema<TDatabase>>
>(
  db: TDatabase,
  query: TQuery,
  onResponse: (
    response: SubscribeQueryResponse<InferDatabaseSchema<TDatabase>, TQuery>
  ) => void
): () => void {
  const validQuery =
    query as unknown as Parameters<TDatabase["core"]["subscribeQuery"]>[0] &
      ValidQuery<TQuery, InferDatabaseSchema<TDatabase>>;

  const callback = ((response: unknown) => {
    onResponse(response as SubscribeQueryResponse<InferDatabaseSchema<TDatabase>, TQuery>);
  }) as Parameters<TDatabase["core"]["subscribeQuery"]>[1];

  return db.core.subscribeQuery(validQuery, callback);
}

export async function queryOnce<
  TDatabase extends InstantQueryClient,
  TQuery extends InstaQLParams<InferDatabaseSchema<TDatabase>>
>(
  db: TDatabase,
  query: TQuery,
  timeoutMs = 5000
): Promise<InstaQLResult<InferDatabaseSchema<TDatabase>, TQuery>> {
  const result = await new Promise<unknown>((resolve, reject) => {
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

    unsubscribe = subscribeQuery(db, query, (response) => {
      if (response.error) {
        finish(() => reject(normalizeError(response.error)));
        return;
      }

      if (response.data !== undefined) {
        finish(() => resolve(response.data));
      }
    });

    if (settled) {
      unsubscribe?.();
    }
  });

  return result as InstaQLResult<InferDatabaseSchema<TDatabase>, TQuery>;
}

export function useQuery<
  TDatabase extends InstantQueryClient,
  TQuery extends InstaQLParams<InferDatabaseSchema<TDatabase>>
>(
  db: TDatabase,
  queryInput: MaybeGetter<TQuery | null>,
  initialData?: MaybeGetter<InstaQLResult<InferDatabaseSchema<TDatabase>, TQuery> | null>
): QueryState<InferDatabaseSchema<TDatabase>, TQuery> {
  const initial = unwrap(initialData) ?? null;

  const state = $state<QueryState<InferDatabaseSchema<TDatabase>, TQuery>>({
    isLoading: initial == null,
    data: initial
  });

  $effect(() => {
    const query = unwrap(queryInput);

    if (!query) {
      state.isLoading = false;
      state.data = initial;
      return;
    }

    state.isLoading = state.data == null;

    return subscribeQuery(db, query, (response) => {
      if (response.error) {
        throw normalizeError(response.error);
      }

      if (response.data !== undefined) {
        state.isLoading = false;
        state.data =
          response.data as unknown as InstaQLResult<InferDatabaseSchema<TDatabase>, TQuery>;
      }
    });
  });

  return state;
}

export async function prefetchQuery<
  TDatabase extends InstantQueryClient,
  TQuery extends InstaQLParams<InferDatabaseSchema<TDatabase>>
>(
  db: TDatabase,
  query: TQuery,
  fetcher: (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>,
  endpoint = "/api/instant/query"
): Promise<InstaQLResult<InferDatabaseSchema<TDatabase>, TQuery> | null> {
  if (typeof window !== "undefined") {
    return (await queryOnce(db, query)) as unknown as InstaQLResult<
      InferDatabaseSchema<TDatabase>,
      TQuery
    >;
  }

  const response = await fetcher(endpoint, {
    method: "POST",
    headers: {
      "Content-Type": "application/json"
    },
    body: JSON.stringify({ query })
  });

  if (!response.ok) {
    return null;
  }

  return (await response.json()) as unknown as InstaQLResult<
    InferDatabaseSchema<TDatabase>,
    TQuery
  >;
}

export function createInstantHelpers<
  TUser extends Record<string, unknown> = Record<string, never>,
  TDatabase extends InstantQueryClient = InstantQueryClient
>(
  db: TDatabase,
  options: CreateInstantHelpersOptions = {}
): BoundInstantHelpers<TDatabase, TUser> {
  return {
    auth: createInstantAuth<TDatabase, TUser>(db, options.auth),
    queryOnce: <TQuery extends InstaQLParams<InferDatabaseSchema<TDatabase>>>(
      query: TQuery,
      timeoutMs?: number
    ) => queryOnce(db, query, timeoutMs),
    useQuery: <TQuery extends InstaQLParams<InferDatabaseSchema<TDatabase>>>(
      queryInput: MaybeGetter<TQuery | null>,
      initialData?: MaybeGetter<InstaQLResult<InferDatabaseSchema<TDatabase>, TQuery> | null>
    ) => useQuery(db, queryInput, initialData),
    prefetchQuery: <TQuery extends InstaQLParams<InferDatabaseSchema<TDatabase>>>(
      query: TQuery,
      fetcher: (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>,
      endpoint?: string
    ) => prefetchQuery(db, query, fetcher, endpoint)
  };
}

function unwrap<T>(value: MaybeGetter<T> | undefined): T | undefined {
  return typeof value === "function" ? (value as () => T)() : value;
}

function normalizeError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error));
}
