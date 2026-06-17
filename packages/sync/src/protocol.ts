export type SyncMessage =
  | { type: "subscribe"; channel: string; since?: string }
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
  | { type: "snapshot"; channel: string; data: any[]; isDelta?: boolean }
  | { type: "ack"; id: string; data?: any }
  | { type: "reject"; id: string; error: string }
  | {
      type: "change";
      channel: string;
      action: "create" | "update" | "delete";
      key?: string;
      data?: any;
      mutationId?: string;
    };

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
