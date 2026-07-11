import { DEV } from "esm-env";


/**
 * Browser cookie options used by the `Cookies` helper.
 *
 * `expires` is measured in days and is converted to `max-age`.
 */
export interface CookieOptions {
  expires?: number;
  path?: string;
  domain?: string;
  secure?: boolean;
  sameSite?: "Lax" | "Strict" | "None";
  partitioned?: boolean;
}

type ToastModule = {
  toast: {
    success(message: string, options?: { description?: string }): void;
    error(message: string, options?: { description?: string }): void;
  };
};

let toastModulePromise: Promise<ToastModule | null> | null = null;

/**
 * Returns true when DOM cookie and toast APIs can be used.
 */
function hasBrowser() {
  return typeof window !== "undefined" && typeof document !== "undefined";
}

/**
 * Lazily imports `svelte-sonner` in the browser.
 *
 * Loading is memoized so repeated toast calls share the same import promise.
 */
async function getToast() {
  if (!hasBrowser()) {
    return null;
  }

  if (!toastModulePromise) {
    toastModulePromise = import("svelte-sonner")
      .then((module) => module as ToastModule)
      .catch(() => null);
  }

  return toastModulePromise;
}

/**
 * Shows a success toast when the toast library is available.
 */
async function toastSuccess(message: string, options?: { description?: string }) {
  const toast = await getToast();
  toast?.toast.success(message, options);
}

/**
 * Shows an error toast when the toast library is available.
 */
async function toastError(message: string, options?: { description?: string }) {
  const toast = await getToast();
  toast?.toast.error(message, options);
}

/**
 * Small browser-only cookie helper.
 *
 * Methods no-op or return `null` during SSR.
 */
export const Cookies = {
  /**
   * Writes a cookie in the browser.
   *
   * @param name Cookie name.
   * @param value Cookie value. It is URI-encoded before writing.
   * @param options Cookie options. `expires` is days from now.
   */
  set(name: string, value: string, options: CookieOptions = {}): void {
    if (!hasBrowser()) {
      return;
    }

    const defaults: CookieOptions = {
      path: "/",
      sameSite: "Lax",
      secure: window.location.protocol === "https:"
    };

    const settings = { ...defaults, ...options };

    let cookieString = `${encodeURIComponent(name)}=${encodeURIComponent(value)}`;

    if (settings.expires) {
      const maxAge = settings.expires * 24 * 60 * 60;
      cookieString += `; max-age=${maxAge}`;
    }

    cookieString += `; path=${settings.path}`;

    if (settings.domain) {
      cookieString += `; domain=${settings.domain}`;
    }

    if (settings.sameSite) {
      cookieString += `; samesite=${settings.sameSite}`;

      if (settings.sameSite === "None") {
        settings.secure = true;
      }
    }

    if (settings.secure) {
      cookieString += "; secure";
    }

    if (settings.partitioned) {
      cookieString += "; partitioned";
    }

    document.cookie = cookieString;
  },

  /**
   * Reads and decodes a browser cookie.
   *
   * Returns `null` during SSR or when the cookie is not present.
   */
  get(name: string): string | null {
    if (!hasBrowser()) {
      return null;
    }

    const match = document.cookie.match(
      new RegExp("(^| )" + encodeURIComponent(name) + "=([^;]+)")
    );

    return match ? decodeURIComponent(match[2]) : null;
  },

  /**
   * Deletes a browser cookie by writing it with a negative expiration.
   */
  remove(name: string, options: Pick<CookieOptions, "path" | "domain"> = {}): void {
    this.set(name, "", { ...options, expires: -1 });
  }
};

/**
 * Creates timestamp fields for create or update operations.
 *
 * @param updateOnly When true, only `updatedAt` is returned.
 *
 * @example
 * ```ts
 * const row = { ...timestamps(false), title: "Draft" };
 * const patch = timestamps(true);
 * ```
 */
export function timestamps<T extends boolean>(
  updateOnly: T
): T extends true ? { updatedAt: number } : { createdAt: number; updatedAt: number } {
  const date = Date.now();

  return (updateOnly ? { updatedAt: date } : { createdAt: date, updatedAt: date }) as any;
}

import type { TryCatchReturn } from "./async.svelte.js";
export type { TryCatchReturn } from "./async.svelte.js";

/** A custom error toast returned from `TryCatchOptions.onError`. */
export type TryCatchErrorToast =
  | string
  | {
      message: string;
      description?: string;
    };

/** Options for customizing `tryCatch` error handling. */
export interface TryCatchOptions {
  /**
   * Maps a thrown error to a custom toast. Return nothing to use the default
   * development or production error toast.
   */
  onError?: (error: Error) => TryCatchErrorToast | null | undefined | Promise<TryCatchErrorToast | null | undefined>;
}

/**
 * Executes a task and displays success or error toasts from its return value.
 *
 * In dev, thrown errors show the error name and message and are logged to the
 * console. In production, thrown errors show a generic message. Use
 * `options.onError` to show a custom message for a specific error type.
 */
export async function tryCatch(
  task: () => Promise<TryCatchReturn> | TryCatchReturn,
  options: TryCatchOptions = {}
) {
  try {
    const response = await task();

    if (response?.success) {
      await toastSuccess(response.success);
    } else if (response?.error) {
      await toastError(response.error);
    }
  } catch (err) {
    if (DEV) {
      const error = err instanceof Error ? err : new Error(String(err));
      console.error("[Dev Error]:", error);
    }

    const error = err instanceof Error ? err : new Error(String(err));
    const customToast = await options.onError?.(error);

    if (typeof customToast === "string") {
      await toastError(customToast);
    } else if (customToast) {
      await toastError(customToast.message, { description: customToast.description });
    } else if (DEV) {
      await toastError(error.name, { description: error.message });
    } else {
      await toastError("Something went wrong");
    }
  }
}

/**
 * Resolves after the provided number of milliseconds.
 */
export const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

export { createAsync } from "./async.svelte.js";

/**
 * Creates a UUID-like id.
 *
 * Uses `crypto.randomUUID` when available, falls back to
 * `crypto.getRandomValues`, then to `Math.random`.
 */
export function createId(): string {
	if (typeof globalThis !== "undefined" && globalThis.crypto?.randomUUID) {
		return globalThis.crypto.randomUUID();
	}
	if (typeof globalThis !== "undefined" && globalThis.crypto?.getRandomValues) {
		// Fallback using crypto.getRandomValues (RFC 4122 version 4 UUID compliant)
		return ("" + 1e7 + -1e3 + -4e3 + -8e3 + -1e11).replace(/[018]/g, (c: any) =>
			(c ^ (globalThis.crypto.getRandomValues(new Uint8Array(1))[0] & (15 >> (c / 4)))).toString(16)
		);
	}
	// Fallback using Math.random (works absolutely anywhere)
	return "xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx".replace(/[xy]/g, (c) => {
		const r = (Math.random() * 16) | 0;
		const v = c === "x" ? r : (r & 0x3) | 0x8;
		return v.toString(16);
	});
}

/**
 * Formats a count with singular/plural text.
 *
 * @param count Numeric count to render.
 * @param options.zero Optional text for zero.
 * @param options.one Singular noun used as `1 ${one}`.
 * @param options.other Plural noun or custom formatter.
 */
export function pluralize(
  count: number,
  { zero, one, other }: { zero?: string; one?: string; other: string | ((count: number) => string) }
) {
  if (count === 0 && zero) return zero;
  if (count === 1 && one) return `1 ${one}`;
  if (typeof other === "function") return other(count);

  return `${count} ${other}`;
}
