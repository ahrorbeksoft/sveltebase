/** Message accepted by an optional application notification adapter. */
export interface NotificationMessage {
  message: string;
  description?: string;
}

/**
 * Optional notification adapter shared by `createAsync` and `tryCatch`.
 * Applications can adapt any toast library without making it a package peer.
 */
export interface NotificationAdapter {
  success(message: NotificationMessage): void | Promise<void>;
  error(message: NotificationMessage): void | Promise<void>;
}

let adapter: NotificationAdapter | null = null;

/** Sets the process-local notification adapter and returns a restoration function. */
export function setNotificationAdapter(
  next: NotificationAdapter | null,
): () => void {
  const previous = adapter;
  adapter = next;
  return () => {
    adapter = previous;
  };
}

/** Returns the configured adapter, primarily for composition and tests. */
export function getNotificationAdapter(): NotificationAdapter | null {
  return adapter;
}

/** Delivers a notification without allowing adapter failures to mask an operation result. */
export async function notify(
  kind: 'success' | 'error',
  message: NotificationMessage,
  override?: NotificationAdapter | null,
): Promise<void> {
  try {
    await (override ?? adapter)?.[kind](message);
  } catch {
    // Notifications are presentation-only. The caller's result remains authoritative.
  }
}
