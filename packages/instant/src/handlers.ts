import { json } from "@sveltejs/kit";
import type { RequestHandler } from "@sveltejs/kit";
import type { User as InstantUser } from "@instantdb/svelte";

export const AUTH_COOKIE_NAME = "instant_user";
export const AUTH_COOKIE_PATH = "/";
export const AUTH_COOKIE_MAX_AGE = 60 * 60 * 24 * 7;

export type InstantAuthUser = InstantUser & Record<string, unknown>;

export type InstantAuthRequestBody<TUser extends InstantAuthUser = InstantAuthUser> = {
  user?: TUser | null;
};

export type InstantQueryRequestBody<TQuery = unknown> = {
  query?: TQuery;
};

export interface InstantUserDatabase<TQuery = unknown, TResult = unknown> {
  query(query: TQuery): Promise<TResult>;
}

export interface InstantAdminDatabase<TQuery = unknown, TResult = unknown> {
  asUser(input: { token: string }): InstantUserDatabase<TQuery, TResult>;
}

export function parseUser<TUser extends InstantAuthUser = InstantAuthUser>(
  cookies: { name: string; value: string }[]
): TUser | undefined {
  let user: TUser | undefined;
  const rawUser = cookies.find((cookie) => cookie.name === AUTH_COOKIE_NAME)?.value;

  if (rawUser) {
    user = JSON.parse(rawUser) as TUser;
  }

  return user;
}

function isAuthenticatedUser(
  user: InstantAuthUser | null | undefined
): user is InstantAuthUser & { refresh_token: string } {
  return typeof user?.refresh_token === "string" && user.refresh_token.length > 0;
}

async function handleAuthRequest({ request, cookies }: Parameters<RequestHandler>[0]) {
  let body: InstantAuthRequestBody;

  try {
    body = (await request.json()) as InstantAuthRequestBody;
  } catch {
    return json({ error: "Invalid JSON body" }, { status: 400 });
  }

  if (isAuthenticatedUser(body.user)) {
    cookies.set(AUTH_COOKIE_NAME, JSON.stringify(body.user), {
      path: AUTH_COOKIE_PATH,
      secure: true,
      sameSite: "strict",
      httpOnly: true,
      maxAge: AUTH_COOKIE_MAX_AGE
    });

    return json({ ok: true });
  }

  cookies.delete(AUTH_COOKIE_NAME, { path: AUTH_COOKIE_PATH });

  return json({ ok: true });
}

async function handleQueryRequest<
  TQuery = unknown,
  TResult = unknown,
  TAdminDB extends InstantAdminDatabase<TQuery, TResult> = InstantAdminDatabase<TQuery, TResult>
>({ request, cookies }: Parameters<RequestHandler>[0], adminDB: TAdminDB) {
  let body: InstantQueryRequestBody<TQuery>;

  try {
    body = (await request.json()) as InstantQueryRequestBody<TQuery>;
  } catch {
    return json({ error: "Invalid JSON body" }, { status: 400 });
  }

  if (body.query === undefined || body.query === null) {
    return json({ error: "Missing query" }, { status: 400 });
  }

  const rawUser = cookies.get(AUTH_COOKIE_NAME);
  let user: InstantAuthUser | undefined;

  if (rawUser) {
    try {
      user = JSON.parse(rawUser) as InstantAuthUser;
    } catch {
      cookies.delete(AUTH_COOKIE_NAME, { path: AUTH_COOKIE_PATH });
      return json({ data: null, error: "Invalid auth cookie" }, { status: 401 });
    }
  }

  if (!isAuthenticatedUser(user)) {
    return json({ data: null, error: "Unauthorized" }, { status: 401 });
  }

  const db = adminDB.asUser({ token: user.refresh_token });
  const result = await db.query(body.query);

  return json(result);
}

export function createInstantHandler<
  TQuery = unknown,
  TResult = unknown,
  TAdminDB extends InstantAdminDatabase<TQuery, TResult> = InstantAdminDatabase<TQuery, TResult>
>(adminDB: TAdminDB): RequestHandler {
  return async (event) => {
    const action = event.params.action?.split("/")[0];

    if (action === "auth") {
      return handleAuthRequest(event);
    }

    if (action === "query") {
      return handleQueryRequest(event, adminDB);
    }

    return json({ error: "Unknown instant action" }, { status: 404 });
  };
}

export function createAuthHandler(): RequestHandler {
  return async (event) => handleAuthRequest(event);
}

export function createQueryHandler<
  TQuery = unknown,
  TResult = unknown,
  TAdminDB extends InstantAdminDatabase<TQuery, TResult> = InstantAdminDatabase<TQuery, TResult>
>(adminDB: TAdminDB): RequestHandler {
  return async (event) => handleQueryRequest(event, adminDB);
}
