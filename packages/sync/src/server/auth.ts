export type SerializedConnectionAuth = {
  auth: any;
  identity: string | null;
};

export function resolveIdentity(
  auth: any,
  identity?: (auth: any) => string | number | bigint | null | undefined,
): string | null {
  const value = identity
    ? identity(auth)
    : (auth?.identity ?? auth?.user?.id ?? auth?.userId);
  return value == null ? null : String(value);
}

export function serializeConnectionAuth(
  auth: any,
  identity: string | null,
): string {
  return btoa(
    unescape(encodeURIComponent(JSON.stringify({ auth, identity }))),
  );
}

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
