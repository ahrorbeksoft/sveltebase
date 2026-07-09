export type SerializedConnectionAuth = {
  auth: any;
  identity: string | null;
  topics?: string[];
};

/**
 * Converts an auth object into the identity string used for the default user topic.
 *
 * If an identity resolver is provided, its return value wins. Otherwise the
 * helper falls back to common shapes: `auth.identity`, `auth.user.id`, then
 * `auth.userId`.
 *
 * @example
 * ```ts
 * resolveIdentity({ user: { id: 42 } }); // "42"
 * resolveIdentity(user, (u) => u.orgId); // "acme"
 * ```
 */
export function resolveIdentity(
  auth: any,
  identity?: (auth: any) => string | number | bigint | null | undefined,
): string | null {
  const value = identity
    ? identity(auth)
    : (auth?.identity ?? auth?.user?.id ?? auth?.userId);
  return value == null ? null : String(value);
}

/**
 * Encodes websocket auth data into the internal header sent to the Durable Object.
 *
 * This is only used between trusted sync worker code and the sync engine. Client
 * requests cannot set this header because public handlers strip it first.
 */
export function serializeConnectionAuth(
  auth: any,
  identity: string | null,
  topics: Iterable<string> = [],
): string {
  return btoa(
    unescape(
      encodeURIComponent(
        JSON.stringify({ auth, identity, topics: Array.from(topics) }),
      ),
    ),
  );
}

/**
 * Decodes forwarded auth from the sync worker.
 *
 * Returns `null` for missing or malformed values so the engine can treat the
 * connection as unauthenticated instead of crashing during websocket setup.
 */
export function deserializeConnectionAuth(
  value: string | null,
): SerializedConnectionAuth | null {
  if (!value) return null;

  try {
    return JSON.parse(decodeURIComponent(escape(atob(value))));
  } catch {
    return null;
  }
}
