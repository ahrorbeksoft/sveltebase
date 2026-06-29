import { json, type Cookies, type RequestEvent, type RequestHandler } from "@sveltejs/kit";
import type { GoogleData } from "../google/types.js";
import { verifyIdToken } from "../google/verifier.js";

export type ServerAuth<User extends { id: string }> = {
  login(
    cookies: Cookies,
    user: User,
    options?: { maxAge?: number; expires?: Date },
  ): Promise<User>;
  logout(cookies: Cookies, options?: { path?: string; domain?: string }): void;
  getUser(cookies: Cookies): Promise<User | null>;
  refresh(
    cookies: Cookies,
    user: User,
    options?: { maxAge?: number; expires?: Date },
  ): Promise<User>;
};

export type CreateAuthRoutesOptions<
  User extends { id: string },
  LoginBody = unknown,
> = {
  auth: ServerAuth<User>;
  login?: (credentials: LoginBody, event: RequestEvent) => Promise<User> | User;
  getUser?: (userId: string, event: RequestEvent) => Promise<User | null | undefined> | User | null | undefined;
  google?: {
    clientId: string;
    getUser: (profile: GoogleData, event: RequestEvent) => Promise<User> | User;
  };
  returnUser?: boolean | {
    login?: boolean;
    refresh?: boolean;
    google?: boolean;
  };
};

function wantsUser(
  option: CreateAuthRoutesOptions<any, any>["returnUser"],
  route: "login" | "refresh" | "google",
) {
  if (option === undefined) return route === "login";
  if (typeof option === "boolean") return option;
  return option[route] ?? route === "login";
}

async function parseJsonBody<T>(event: RequestEvent): Promise<T> {
  try {
    return await event.request.json() as T;
  } catch {
    return {} as T;
  }
}

function empty() {
  return new Response(null, { status: 204 });
}

function routeSegment(event: RequestEvent) {
  const params = event.params as Record<string, string | undefined>;
  const value = params.auth ?? params["...auth"] ?? "";
  return value.split("/").filter(Boolean)[0] ?? "";
}

export function createAuthRoutes<
  User extends { id: string },
  LoginBody = unknown,
>(options: CreateAuthRoutesOptions<User, LoginBody>): {
  GET: RequestHandler;
  POST: RequestHandler;
} {
  const handlePost: RequestHandler = async (event) => {
    const route = routeSegment(event);

    if (route === "login") {
      if (!options.login) {
        return new Response("Login route is not configured", { status: 404 });
      }

      const credentials = await parseJsonBody<LoginBody>(event);
      const user = await options.login(credentials, event);
      await options.auth.login(event.cookies, user);
      return json(user);
    }

    if (route === "logout") {
      options.auth.logout(event.cookies);
      return empty();
    }

    if (route === "refresh") {
      if (!options.getUser) {
        return new Response("Refresh route is not configured", { status: 404 });
      }

      const sessionUser = await options.auth.getUser(event.cookies);
      if (!sessionUser) {
        options.auth.logout(event.cookies);
        return new Response("Unauthorized", { status: 401 });
      }

      const user = await options.getUser(sessionUser.id, event);
      if (!user) {
        options.auth.logout(event.cookies);
        return new Response("Unauthorized", { status: 401 });
      }

      await options.auth.refresh(event.cookies, user);
      return wantsUser(options.returnUser, "refresh") ? json(user) : empty();
    }

    if (route === "google") {
      if (!options.google) {
        return new Response("Google route is not configured", { status: 404 });
      }

      const body = await parseJsonBody<{ credential?: string } | string>(event);
      const credential = typeof body === "string" ? body : body.credential;
      if (!credential) {
        return new Response("Missing Google credential", { status: 400 });
      }

      const profile = await verifyIdToken({
        credential,
        clientId: options.google.clientId,
      });
      const user = await options.google.getUser(profile, event);
      await options.auth.login(event.cookies, user);

      return wantsUser(options.returnUser, "google") ? json(user) : empty();
    }

    return new Response("Not found", { status: 404 });
  };

  return {
    GET: () => new Response("Not found", { status: 404 }),
    POST: handlePost,
  };
}
