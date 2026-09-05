export type SerializedConnectionAuth = {
  subject: string;
  user: unknown;
  claims?: unknown;
  topics: string[];
  expiresAt?: number;
};

function encodeUtf8(value: string) {
  const bytes = new TextEncoder().encode(value);
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}
function decodeUtf8(value: string) {
  const binary = atob(value);
  const bytes = Uint8Array.from(binary, (char) => char.charCodeAt(0));
  return new TextDecoder(undefined, { fatal: true }).decode(bytes);
}
const object = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

export function serializeConnectionAuth(
  auth: SerializedConnectionAuth,
): string {
  return encodeUtf8(JSON.stringify(auth));
}

export function deserializeConnectionAuth(
  value: string | null,
): SerializedConnectionAuth | null {
  if (!value || value.length > 64 * 1024) return null;
  try {
    const parsed: unknown = JSON.parse(decodeUtf8(value));
    if (
      !object(parsed) ||
      typeof parsed.subject !== 'string' ||
      !parsed.subject ||
      parsed.subject.length > 256 ||
      !Array.isArray(parsed.topics) ||
      !parsed.topics.every(
        (topic) =>
          typeof topic === 'string' && topic.length > 0 && topic.length <= 256,
      )
    )
      return null;
    if (
      parsed.expiresAt !== undefined &&
      (typeof parsed.expiresAt !== 'number' ||
        !Number.isFinite(parsed.expiresAt))
    )
      return null;
    return {
      subject: parsed.subject,
      user: parsed.user,
      ...(parsed.claims === undefined ? {} : { claims: parsed.claims }),
      topics: [...new Set(parsed.topics)],
      ...(parsed.expiresAt === undefined
        ? {}
        : { expiresAt: parsed.expiresAt }),
    };
  } catch {
    return null;
  }
}
