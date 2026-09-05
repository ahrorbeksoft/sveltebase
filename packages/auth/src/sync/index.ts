import { getSessionPayloadFromRequest } from '../index.js';

export type AuthSyncPlatform = { env: Record<string, unknown> };

/** Cookie resolver for sync adapters. Identity always comes from the signed subject. */
export function sessionCookieAuth<
  User extends { id: string },
  Claims extends Record<string, unknown> = Record<string, never>,
>(
  options: {
    secret?: string | ((platform: AuthSyncPlatform) => string | undefined);
    secretBinding?: string;
    cookieName?: string;
  } = {},
) {
  const resolver = async (request: Request, platform: AuthSyncPlatform) => {
    const binding = options.secretBinding ?? 'JWT_SECRET';
    const secret =
      typeof options.secret === 'function'
        ? options.secret(platform)
        : (options.secret ?? platform.env[binding]);
    if (typeof secret !== 'string' || secret.length === 0) {
      throw new Error(`Missing or invalid ${binding} binding for sync auth`);
    }
    const session = await getSessionPayloadFromRequest<User, Claims>(
      request,
      secret,
      options.cookieName,
    );
    if (!session) return null;
    return {
      subject: session.subject,
      user: session.user,
      claims: session.claims,
      expiresAt: session.exp * 1000,
    };
  };
  return Object.assign(resolver, { allowUnauthenticated: false as const });
}

export type { AuthSyncAdapter } from '../client/auth.svelte.js';
