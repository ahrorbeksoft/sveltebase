import { DEV } from "esm-env";


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

function hasBrowser() {
  return typeof window !== "undefined" && typeof document !== "undefined";
}

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

async function toastSuccess(message: string, options?: { description?: string }) {
  const toast = await getToast();
  toast?.toast.success(message, options);
}

async function toastError(message: string, options?: { description?: string }) {
  const toast = await getToast();
  toast?.toast.error(message, options);
}

export const Cookies = {
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

  get(name: string): string | null {
    if (!hasBrowser()) {
      return null;
    }

    const match = document.cookie.match(
      new RegExp("(^| )" + encodeURIComponent(name) + "=([^;]+)")
    );

    return match ? decodeURIComponent(match[2]) : null;
  },

  remove(name: string, options: Pick<CookieOptions, "path" | "domain"> = {}): void {
    this.set(name, "", { ...options, expires: -1 });
  }
};

export function timestamps<T extends boolean>(
  updateOnly: T
): T extends true ? { updatedAt: number } : { createdAt: number; updatedAt: number } {
  const date = Date.now();

  return (updateOnly ? { updatedAt: date } : { createdAt: date, updatedAt: date }) as any;
}

import type { TryCatchReturn } from "./async.svelte.js";
export type { TryCatchReturn } from "./async.svelte.js";

export async function tryCatch(task: () => Promise<TryCatchReturn> | TryCatchReturn) {
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
      await toastError(error.name, { description: error.message });
      console.error("[Dev Error]:", error);
    } else {
      await toastError("Something went wrong");
    }
  }
}

export const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

export { createAsync } from "./async.svelte.js";

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

export function pluralize(
  count: number,
  { zero, one, other }: { zero?: string; one?: string; other: string | ((count: number) => string) }
) {
  if (count === 0 && zero) return zero;
  if (count === 1 && one) return `1 ${one}`;
  if (typeof other === "function") return other(count);

  return `${count} ${other}`;
}

