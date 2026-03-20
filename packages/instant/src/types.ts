import type {
  InstaQLParams,
  InstaQLResult,
  InstantSchemaDef,
  InstantSvelteDatabase,
  User as InstantUser
} from "@instantdb/svelte";

export type InstantQueryClient = InstantSvelteDatabase<
  InstantSchemaDef<any, any, any>,
  boolean,
  any
>;

export type InferDatabaseSchema<TDatabase extends InstantQueryClient> =
  TDatabase extends InstantSvelteDatabase<infer TSchema, any, any> ? TSchema : never;

export type MaybeGetter<T> = T | (() => T);

export type SubscribeQueryResponse<
  TSchema extends InstantSchemaDef<any, any, any>,
  TQuery extends InstaQLParams<TSchema>
> = {
  data?: InstaQLResult<TSchema, TQuery>;
  error?: unknown;
};

export type QueryState<
  TSchema extends InstantSchemaDef<any, any, any>,
  TQuery extends InstaQLParams<TSchema>
> = {
  isLoading: boolean;
  data: InstaQLResult<TSchema, TQuery> | null;
};

export type InstantBoundUser<TDatabase extends InstantQueryClient> = InstantUser &
  Record<string, unknown>;

export interface BoundInstantAuth<TDatabase extends InstantQueryClient> {
  init(user: InstantBoundUser<TDatabase> | undefined): void;
  readonly user: InstantBoundUser<TDatabase> | undefined;
  readonly initialized: boolean;
  destroy(): void;
}

export interface InstantAuthOptions {
  endpoint?: string;
  fetcher?: (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;
}

export interface BoundInstantHelpers<TDatabase extends InstantQueryClient> {
  auth: BoundInstantAuth<TDatabase>;
  queryOnce<TQuery extends InstaQLParams<InferDatabaseSchema<TDatabase>>>(
    query: TQuery,
    timeoutMs?: number
  ): Promise<InstaQLResult<InferDatabaseSchema<TDatabase>, TQuery>>;
  useQuery<TQuery extends InstaQLParams<InferDatabaseSchema<TDatabase>>>(
    queryInput: MaybeGetter<TQuery | null>,
    initialData?: MaybeGetter<InstaQLResult<InferDatabaseSchema<TDatabase>, TQuery> | null>
  ): QueryState<InferDatabaseSchema<TDatabase>, TQuery>;
  prefetchQuery<TQuery extends InstaQLParams<InferDatabaseSchema<TDatabase>>>(
    query: TQuery,
    fetcher: (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>,
    endpoint?: string
  ): Promise<InstaQLResult<InferDatabaseSchema<TDatabase>, TQuery> | null>;
}

export type InstantAuthUser = InstantUser & Record<string, unknown>;

export interface InstantUserDatabase<TQuery = unknown, TResult = unknown> {
  query(query: TQuery): Promise<TResult>;
}

export interface InstantAdminDatabase<TQuery = unknown, TResult = unknown> {
  asUser(input: { token: string }): InstantUserDatabase<TQuery, TResult>;
}

export type InstantAuthRequestBody<TUser extends InstantAuthUser = InstantAuthUser> = {
  user?: TUser | null;
};

export type InstantQueryRequestBody<TQuery = unknown> = {
  query?: TQuery;
};
