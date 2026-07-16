import {
  getVerifiedSessionFromRequest,
  mergeSessionUser,
} from "../index.js";
import type { SyncPlatform } from "@sveltebase/sync";

/**
 * Creates a sync websocket auth resolver backed by the signed session cookie.
 *
 * Returns the **merged** profile + claims object so handlers can read claims
 * like `activeRoleId` on `ctx.auth.user` without a separate claims field.
 *
 * The returned function can be passed to `syncDevPlugin`, `syncEngineRoute`, or
 * `createSyncAppWorker`. It marks unauthenticated websockets as forbidden and
 * uses `user.id` as the default identity.
 */
export function sessionCookieAuth<
  User extends { id: string },
  Claims extends Record<string, unknown> = Record<string, never>,
>(options?: {
  secret?: string | ((platform: SyncPlatform) => string | undefined);
  secretBinding?: string;
  cookieName?: string;
  identity?: (
    user: User & Claims,
  ) => string | number | bigint | null | undefined;
}) {
  const resolver = async (request: Request, platform: SyncPlatform) => {
    const secretBinding = options?.secretBinding ?? "JWT_SECRET";
    const secret =
      typeof options?.secret === "function"
        ? options.secret(platform)
        : (options?.secret ?? platform.env[secretBinding]);
    if (!secret) {
      throw new Error(`Missing ${secretBinding} binding for sync auth`);
    }

    const session = await getVerifiedSessionFromRequest<User, Claims>(
      request,
      String(secret),
      options?.cookieName,
    );

    if (!session) return null;

    return mergeSessionUser(session.user, session.claims);
  };

  return Object.assign(resolver, {
    allowUnauthenticated: false,
    identity:
      options?.identity ??
      ((user: User & Claims) => user.id),
  });
}
