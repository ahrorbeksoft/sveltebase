import { getVerifiedUserFromRequest } from "../index.js";
import type { SyncPlatform } from "@sveltebase/sync";

export function sessionCookieAuth<User extends { id: string }>(options?: {
  secret?: string | ((platform: SyncPlatform) => string | undefined);
  secretBinding?: string;
  cookieName?: string;
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

    const identityValue = options?.identity
      ? options.identity(user)
      : user.id;
    const identity = identityValue == null ? null : String(identityValue);

    return { user, identity };
  };

  return Object.assign(resolver, {
    allowUnauthenticated: false,
  });
}
