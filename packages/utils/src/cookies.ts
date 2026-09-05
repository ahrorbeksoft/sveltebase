/**
 * Options used when writing a browser cookie.
 *
 * `expires` is measured in days. `0` intentionally expires the cookie now.
 */
export interface CookieOptions {
  expires?: number;
  path?: string;
  domain?: string;
  secure?: boolean;
  sameSite?: 'Lax' | 'Strict' | 'None';
  partitioned?: boolean;
}

/** The small document surface required by a cookie store. */
export interface CookieDocument {
  cookie: string;
}

/** Browser cookie store with no dependency on Svelte or a notification library. */
export interface CookieStore {
  get(name: string): string | null;
  set(name: string, value: string, options?: CookieOptions): void;
  remove(name: string, options?: Pick<CookieOptions, 'path' | 'domain'>): void;
}

function getDocument(): CookieDocument | null {
  return typeof document === 'undefined' ? null : document;
}

function isSecureContext(): boolean {
  return typeof window !== 'undefined' && window.location.protocol === 'https:';
}

function decode(value: string): string | null {
  try {
    return decodeURIComponent(value);
  } catch {
    return null;
  }
}

/**
 * Creates a cookie store for a document. Cookie parsing compares decoded names
 * exactly, so names containing regex syntax cannot affect a lookup.
 */
export function createCookieStore(
  target: CookieDocument | null = getDocument(),
): CookieStore {
  return {
    set(name, value, options = {}) {
      if (!target) return;

      const sameSite = options.sameSite ?? 'Lax';
      const secure =
        (options.secure ?? isSecureContext()) || sameSite === 'None';
      const path = options.path ?? '/';
      let cookie = `${encodeURIComponent(name)}=${encodeURIComponent(value)}; path=${path}`;

      if (options.expires !== undefined) {
        if (!Number.isFinite(options.expires)) {
          throw new TypeError('Cookie expiry must be a finite number of days.');
        }

        cookie += `; max-age=${Math.trunc(options.expires * 86_400)}`;
      }

      if (options.domain) cookie += `; domain=${options.domain}`;
      cookie += `; samesite=${sameSite}`;
      if (secure) cookie += '; secure';
      if (options.partitioned) cookie += '; partitioned';
      target.cookie = cookie;
    },

    get(name) {
      if (!target) return null;

      for (const part of target.cookie.split(';')) {
        const separator = part.indexOf('=');
        if (separator < 0) continue;
        const storedName = decode(part.slice(0, separator).trim());
        if (storedName !== name) continue;

        // A malformed unrelated cookie must never make cookie reads throw.
        return decode(part.slice(separator + 1).trim());
      }

      return null;
    },

    remove(name, options = {}) {
      this.set(name, '', { ...options, expires: 0 });
    },
  };
}

/** Default browser cookie store. It is safe to import during SSR. */
export const Cookies = createCookieStore();
