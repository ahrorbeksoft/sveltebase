import type { SyncErrorPayload } from "./errors.js";

/**
 * Wire messages exchanged between the browser sync client and the sync broker.
 *
 * The client sends `subscribe`, `unsubscribe`, `mutate`, and `ping`. The server
 * answers with snapshots, acknowledgements, rejections, and broadcast changes.
 */
export type SyncMessage =
  | {
      type: "subscribe";
      channel: string;
      since?: number;
      viewVersion?: string | number | null;
    }
  | { type: "unsubscribe"; channel: string }
  | {
      type: "mutate";
      id: string;
      channel: string;
      action: "create" | "update" | "delete";
      key?: string;
      data?: any;
    }
  | { type: "ping" }
  | { type: "pong" }
  | {
      type: "snapshot";
      channel: string;
      data: any[];
      isDelta?: boolean;
      viewVersion?: string | null;
    }
  | { type: "ack"; id: string; data?: any }
  | { type: "reject"; id: string; error: SyncErrorPayload | string }
  | {
      type: "change";
      channel: string;
      action: "create" | "update" | "delete";
      key?: string;
      data?: any;
      mutationId?: string;
    }
  | {
      type: "batch";
      channel: string;
      changes: Array<{
        action: "create" | "update" | "delete";
        key?: string;
        data?: any;
      }>;
    }
  | { type: "channel-change"; channel: string }
  | { type: "channel-reset"; channel: string };

/**
 * Safely parses a websocket payload into a sync message.
 *
 * Malformed JSON or objects without a string `type` return `null` so callers can
 * ignore bad frames without throwing from the websocket event handler.
 */
export function parseSyncMessage(data: string): SyncMessage | null {
  try {
    const parsed = JSON.parse(data);
    if (
      parsed &&
      typeof parsed === "object" &&
      typeof parsed.type === "string"
    ) {
      return parsed as SyncMessage;
    }
  } catch {
    // Ignore malformed JSON
  }
  return null;
}
