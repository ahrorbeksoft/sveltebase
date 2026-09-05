import type {
  AsyncResult,
  NotificationAdapter,
  NotificationMessage,
} from './async.svelte.js';
import { notify } from './notifications.js';

/** A custom notification returned from `tryCatch` error handling. */
export type TryCatchErrorNotification = string | NotificationMessage;

/** Options that control notification handling for one `tryCatch` invocation. */
export interface TryCatchOptions {
  /** Uses this adapter rather than the shared adapter for this operation. */
  notifications?: NotificationAdapter | null;
  /** Maps a thrown value to a notification. Return nothing to use its message. */
  onError?: (
    error: Error,
  ) =>
    | TryCatchErrorNotification
    | null
    | undefined
    | Promise<TryCatchErrorNotification | null | undefined>;
}

function asError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error));
}

/**
 * Executes a one-off action and presents any declared result through the
 * configured notification adapter. It returns the declared result; thrown
 * errors are reported and become `undefined`.
 */
export async function tryCatch(
  task: () => Promise<AsyncResult> | AsyncResult,
  options: TryCatchOptions = {},
): Promise<AsyncResult> {
  try {
    const result = await task();
    if (result?.success)
      await notify(
        'success',
        { message: result.success },
        options.notifications,
      );
    if (result?.error)
      await notify('error', { message: result.error }, options.notifications);
    return result;
  } catch (reason) {
    const error = asError(reason);
    const custom = await options.onError?.(error);
    const message =
      typeof custom === 'string'
        ? { message: custom }
        : (custom ?? { message: error.message });
    await notify('error', message, options.notifications);
    return undefined;
  }
}

/** Resolves after a finite, non-negative number of milliseconds. */
export function wait(milliseconds: number): Promise<void> {
  if (!Number.isFinite(milliseconds) || milliseconds < 0) {
    return Promise.reject(
      new RangeError('wait requires a finite, non-negative duration.'),
    );
  }

  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

export function timestamps(updateOnly: true): { updatedAt: number };
export function timestamps(updateOnly: false): {
  createdAt: number;
  updatedAt: number;
};
/** Creates create/update timestamp fields from one clock reading. */
export function timestamps(
  updateOnly: boolean,
): { updatedAt: number } | { createdAt: number; updatedAt: number } {
  const now = Date.now();
  return updateOnly ? { updatedAt: now } : { createdAt: now, updatedAt: now };
}

/** Creates a UUID v4 identifier, using cryptographic randomness when available. */
export function createId(): string {
  if (globalThis.crypto?.randomUUID) return globalThis.crypto.randomUUID();

  if (globalThis.crypto?.getRandomValues) {
    const bytes = globalThis.crypto.getRandomValues(new Uint8Array(16));
    bytes[6] = (bytes[6]! & 0x0f) | 0x40;
    bytes[8] = (bytes[8]! & 0x3f) | 0x80;
    const hex = Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0'));
    return `${hex.slice(0, 4).join('')}-${hex.slice(4, 6).join('')}-${hex.slice(6, 8).join('')}-${hex.slice(8, 10).join('')}-${hex.slice(10).join('')}`;
  }

  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(
    /[xy]/g,
    (character) => {
      const random = Math.floor(Math.random() * 16);
      return (character === 'x' ? random : (random & 0x3) | 0x8).toString(16);
    },
  );
}

/** Formats a count using explicit zero, singular, and plural forms. */
export function pluralize(
  count: number,
  options: {
    zero?: string;
    one?: string;
    other: string | ((count: number) => string);
  },
): string {
  if (count === 0 && options.zero !== undefined) return options.zero;
  if (count === 1 && options.one !== undefined) return `1 ${options.one}`;
  return typeof options.other === 'function'
    ? options.other(count)
    : `${count} ${options.other}`;
}
