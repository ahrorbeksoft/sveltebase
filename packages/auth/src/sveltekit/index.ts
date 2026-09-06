import {
  error,
  isHttpError,
  isRedirect,
  json,
  type Cookies,
  type RequestEvent,
  type RequestHandler,
} from "@sveltejs/kit";
import type { GoogleData } from "../google/types.js";
import { verifyIdToken } from "../google/verifier.js";
import { serializeAuthError, SerializableError } from "../errors.js";
import type { AuthSession } from "../index.js";
import {
  verifyInitData,
  type TelegramInitData,
} from "../telegram/verifier.js";

/**
 * Server session helper shape expected by `createAuthRoutes`.
 */
export type ServerAuth<
  User extends { id: string },
  Claims extends Record<string, unknown> = Record<string, never>,
> = {
  login(
    cookies: Cookies,
    user: User,
    options?: { maxAge?: number; expires?: Date; claims?: Claims },
  ): Promise<AuthSession<User, Claims>>;
  logout(cookies: Cookies, options?: { path?: string; domain?: string }): void;
  getUser(cookies: Cookies): Promise<User | null>;
  getClaims(cookies: Cookies): Promise<Claims>;
  getSession(cookies: Cookies): Promise<AuthSession<User, Claims> | null>;
  refresh(
    cookies: Cookies,
    user: User,
    options?: { maxAge?: number; expires?: Date; claims?: Claims },
  ): Promise<AuthSession<User, Claims>>;
  setClaims(
    cookies: Cookies,
    claims: Claims | ((current: Claims) => Claims),
    options?: { maxAge?: number; expires?: Date },
  ): Promise<AuthSession<User, Claims> | null>;
};

/** Normalized login result from app callbacks. */
export type LoginResult<
  User extends { id: string },
  Claims extends Record<string, unknown> = Record<string, never>,
> = User | AuthSession<User, Claims>;

function normalizeLoginResult<
  User extends { id: string },
  Claims extends Record<string, unknown>,
>(result: LoginResult<User, Claims>): AuthSession<User, Claims> {
  if (result && typeof result === "object" && "user" in result && "claims" in result) {
    return result as AuthSession<User, Claims>;
  }
  return {
    user: result as User,
    claims: {} as Claims,
  };
}

export type CreateAuthRoutesOptions<
  User extends { id: string },
  LoginBody = unknown,
  Claims extends Record<string, unknown> = Record<string, never>,
  TmaBody extends { initData?: string } = { initData: string },
> = {
  auth: ServerAuth<User, Claims>;
  /**
   * Credential login for `POST /login`.
   * Return a user profile, or `{ user, claims }` for session claims.
   */
  login?: (
    credentials: LoginBody,
    event: RequestEvent,
  ) => Promise<LoginResult<User, Claims>> | LoginResult<User, Claims>;
  /**
   * Looks up the latest **profile** by session user id.
   * Claims are preserved from the cookie automatically.
   */
  getUser?: (
    userId: string,
    event: RequestEvent,
  ) => Promise<User | null | undefined> | User | null | undefined;
  /**
   * Optional claims update for `POST /claims`.
   * Required to enable the route. Validate and authorize all requested claims.
   */
  setClaims?: (
    claims: Claims,
    event: RequestEvent,
    current: AuthSession<User, Claims>,
  ) => Promise<Claims> | Claims;
  google?: {
    clientId: string;
    getUser: (
      profile: GoogleData,
      event: RequestEvent,
    ) => Promise<LoginResult<User, Claims>> | LoginResult<User, Claims>;
  };
  /**
   * Telegram Mini App login for `POST /tma`.
   * Package verifies initData; app maps verified data to a user/session.
   */
  tma?: {
    getBotToken: (
      event: RequestEvent,
      body: TmaBody,
    ) => Promise<string | null | undefined> | string | null | undefined;
    getUser: (
      initData: TelegramInitData,
      event: RequestEvent,
      body: TmaBody,
    ) => Promise<LoginResult<User, Claims>> | LoginResult<User, Claims>;
    maxAgeSeconds?: number;
    clockSkewSeconds?: number;
  };
};

async function parseJsonBody<T>(event: RequestEvent): Promise<T> {
  try {
    return (await event.request.json()) as T;
  } catch {
    error(400, "Invalid JSON body");
  }
}

function empty() {
  return new Response(null, { status: 204 });
}

function authErrorResponse(error: unknown) {
  if (isHttpError(error)) {
    const body = error.body as { code?: unknown; message?: unknown };
    return json(
      {
        code: typeof body.code === "string" ? body.code : "HttpError",
        message:
          typeof body.message === "string"
            ? body.message
            : "Authentication request failed",
      },
      { status: error.status },
    );
  }

  return json(serializeAuthError(error), {
    status: error instanceof SerializableError ? 400 : 500,
  });
}

function routeSegment(event: RequestEvent) {
  const params = event.params as Record<string, string | undefined>;
  const value = params.auth ?? params["...auth"] ?? "";
  return value.split("/").filter(Boolean)[0] ?? "";
}

/**
 * Creates SvelteKit auth route handlers.
 *
 * Supported POST actions: `login`, `logout`, `refresh`, `claims`, `google`, `tma`.
 * All successful auth responses return `{ user, claims }`.
 */
export function createAuthRoutes<
  User extends { id: string },
  LoginBody = unknown,
  Claims extends Record<string, unknown> = Record<string, never>,
  TmaBody extends { initData?: string } = { initData: string },
>(options: CreateAuthRoutesOptions<User, LoginBody, Claims, TmaBody>): {
  GET: RequestHandler;
  POST: RequestHandler;
} {
  const handlePost: RequestHandler = async (event) => {
    try {
      return await handlePostRequest(event);
    } catch (error) {
      if (isRedirect(error)) {
        throw error;
      }

      return authErrorResponse(error);
    }
  };

  const handlePostRequest: RequestHandler = async (event) => {
    const route = routeSegment(event);

    if (route === "login") {
      if (!options.login) {
        return new Response("Login route is not configured", { status: 404 });
      }

      const credentials = await parseJsonBody<LoginBody>(event);
      const result = normalizeLoginResult(
        await options.login(credentials, event),
      );
      const session = await options.auth.login(event.cookies, result.user, {
        claims: result.claims,
      });
      return json(session);
    }

    if (route === "logout") {
      options.auth.logout(event.cookies);
      return empty();
    }

    if (route === "refresh") {
      if (!options.getUser) {
        return new Response("Refresh route is not configured", { status: 404 });
      }

      const current = await options.auth.getSession(event.cookies);
      if (!current) {
        options.auth.logout(event.cookies);
        return new Response("Unauthorized", { status: 401 });
      }

      const user = await options.getUser(current.user.id, event);
      if (!user) {
        options.auth.logout(event.cookies);
        return new Response("Unauthorized", { status: 401 });
      }

      // Preserve claims; only refresh profile snapshot.
      const session = await options.auth.refresh(event.cookies, user, {
        claims: current.claims,
      });
      return json(session);
    }

    if (route === "claims") {
      if (!options.setClaims) {
        return new Response("Claims route is not configured", { status: 404 });
      }
      const current = await options.auth.getSession(event.cookies);
      if (!current) {
        options.auth.logout(event.cookies);
        return new Response("Unauthorized", { status: 401 });
      }

      const body = await parseJsonBody<Claims>(event);
      const nextClaims = await options.setClaims(body, event, current);

      const session = await options.auth.setClaims(event.cookies, nextClaims);
      if (!session) {
        return new Response("Unauthorized", { status: 401 });
      }
      return json(session);
    }

    if (route === "google") {
      if (!options.google) {
        return new Response("Google route is not configured", { status: 404 });
      }

      const body = await parseJsonBody<{ credential?: string } | string>(event);
      const credential = typeof body === "string" ? body : body?.credential;
      if (typeof credential !== "string" || !credential) {
        return new Response("Missing Google credential", { status: 400 });
      }

      const profile = await verifyIdToken({
        credential,
        clientId: options.google.clientId,
      });
      const result = normalizeLoginResult(
        await options.google.getUser(profile, event),
      );
      const session = await options.auth.login(event.cookies, result.user, {
        claims: result.claims,
      });
      return json(session);
    }

    if (route === "tma") {
      if (!options.tma) {
        return new Response("TMA route is not configured", { status: 404 });
      }

      const body = await parseJsonBody<TmaBody>(event);
      const initDataRaw =
        typeof (body as any)?.initData === "string"
          ? (body as any).initData
          : typeof (body as any)?.telegramData === "string"
            ? (body as any).telegramData
            : "";
      if (!initDataRaw) {
        return new Response("Missing Telegram initData", { status: 400 });
      }

      const botToken = await options.tma.getBotToken(event, body);
      if (!botToken) {
        return new Response("Telegram bot is not configured", { status: 400 });
      }

      const initData = await verifyInitData({
        initData: initDataRaw,
        botToken,
        maxAgeSeconds: options.tma.maxAgeSeconds,
        clockSkewSeconds: options.tma.clockSkewSeconds,
      });

      const result = normalizeLoginResult(
        await options.tma.getUser(initData, event, body),
      );
      const session = await options.auth.login(event.cookies, result.user, {
        claims: result.claims,
      });
      return json(session);
    }

    return new Response("Not found", { status: 404 });
  };

  return {
    GET: () => new Response("Not found", { status: 404 }),
    POST: handlePost,
  };
}
