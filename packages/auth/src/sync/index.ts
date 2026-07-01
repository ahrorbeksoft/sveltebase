import { getVerifiedUserFromRequest } from "../index.js";
import type { SyncPlatform } from "@sveltebase/sync";

/**
 * Creates a sync websocket auth resolver backed by the signed session cookie.
 *
 * The returned function can be passed to `syncDevPlugin`, `syncEngineRoute`, or
 * `createSyncAppWorker`. It also carries metadata that marks unauthenticated
 * websocket connections as forbidden and uses `user.id` as the default scope
 * identity.
 *
 * @example
 * ```ts
 * createSyncAppWorker(app, {
 *   handlers,
 *   auth: sessionCookieAuth<User>({ secretBinding: "JWT_SECRET" })
 * });
 * ```
 */
export function sessionCookieAuth<User extends { id: string }>(options?: {
  /**
   * Session signing secret or resolver.
   *
   * If omitted, the secret is read from `platform.env[secretBinding]`.
   */
  secret?: string | ((platform: SyncPlatform) => string | undefined);
  /** Env binding name used when `secret` is not provided. */
  secretBinding?: string;
  /** Session cookie name. Defaults to `"sf_session"`. */
  cookieName?: string;
  /** Converts the verified user into the identity used by sync `scope`. */
  identity?: (user: User) => string | number | bigint | null | undefined;
}) {
  const resolver = async (request: Request, platform: SyncPlatform) => {
    const secretBinding = options?.secretBinding ?? "JWT_SECRET";
    const secret =
      typeof options?.secret === "function"
        ? options.secret(platform)
        : options?.secret ?? platform.env[secretBinding];
    if (!secret) {
      throw new Error(`Missing ${secretBinding} binding for sync auth`);
    }

    const user = await getVerifiedUserFromRequest<User>(
      request,
      String(secret),
      options?.cookieName,
    );

    if (!user) return null;

    return user;
  };

  return Object.assign(resolver, {
    allowUnauthenticated: false,
    identity: options?.identity ?? ((user: User) => user.id),
  });
}
