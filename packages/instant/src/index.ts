export {
  createInstantHelpers,
  prefetchQuery,
  queryOnce,
  useQuery
} from "./query.svelte.js";

export { createAuthHandler, createInstantHandler, createQueryHandler, parseUser } from "./handlers.js";

export type {
  BoundInstantAuth,
  BoundInstantHelpers,
  InferDatabaseSchema,
  InstantAuthOptions,
  InstantBoundUser,
  InstantQueryClient,
  MaybeGetter,
  InstantAuthUser,
  QueryState,
  SubscribeQueryResponse
} from "./types.js";

export type { InstantAdminDatabase, InstantAuthRequestBody, InstantQueryRequestBody } from "./types.js";
