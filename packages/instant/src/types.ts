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

export type MergeInstantAuthUser<
  TUser extends Record<string, unknown> = Record<string, never>
> = InstantUser & TUser;

export type InstantAuthUser<TUser extends Record<string, unknown> = Record<string, never>> =
  MergeInstantAuthUser<TUser>;

export type InstantBoundUser<
  TDatabase extends InstantQueryClient,
  TUser extends Record<string, unknown> = Record<string, never>
> = MergeInstantAuthUser<TUser>;

export interface BoundInstantAuth<
  TDatabase extends InstantQueryClient,
  TUser extends Record<string, unknown> = Record<string, never>
> {
  init(user: InstantBoundUser<TDatabase, TUser> | undefined): void;
  readonly user: InstantBoundUser<TDatabase, TUser> | undefined;
  readonly initialized: boolean;
  destroy(): void;
}

export interface InstantAuthOptions {
  endpoint?: string;
  fetcher?: (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;
}

export interface BoundInstantHelpers<
  TDatabase extends InstantQueryClient,
  TUser extends Record<string, unknown> = Record<string, never>
> {
  auth: BoundInstantAuth<TDatabase, TUser>;
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

export interface InstantUserDatabase<TQuery = unknown, TResult = unknown> {
  query(query: TQuery): Promise<TResult>;
}

export interface InstantAdminDatabase<TQuery = unknown, TResult = unknown> {
  asUser(input: { token: string }): InstantUserDatabase<TQuery, TResult>;
}

export type InstantAuthRequestBody<
  TUser extends Record<string, unknown> = Record<string, never>
> = {
  user?: MergeInstantAuthUser<TUser> | null;
};

export type InstantQueryRequestBody<TQuery = unknown> = {
  query?: TQuery;
};
