/**
 * Small Svelte state holder for sync connection status.
 *
 * `SyncClient.status` exposes this value so components can react to
 * `"connecting"`, `"connected"`, and `"disconnected"` without importing the
 * class directly.
 */
export class ConnectionStatus {
  private _value = $state<"connecting" | "connected" | "disconnected">("connecting");

  /** Current websocket status. */
  get value() {
    return this._value;
  }

  /** Updates the reactive websocket status. */
  set value(newValue: "connecting" | "connected" | "disconnected") {
    this._value = newValue;
  }
}

/**
 * Reactive activity flag for in-flight uploads (mutations) and downloads
 * (snapshot fetches). UI can show a brief "syncing" indicator while true.
 */
export class SyncActivity {
  private _syncing = $state(false);
  private _pendingMutations = $state(0);
  private _pendingFetches = $state(0);

  get isSyncing() {
    return this._syncing;
  }

  /** Mutations waiting for server ack (or queued while offline). */
  get pendingMutations() {
    return this._pendingMutations;
  }

  /** Channels waiting for a snapshot response. */
  get pendingFetches() {
    return this._pendingFetches;
  }

  setCounts(mutations: number, fetches: number) {
    this._pendingMutations = mutations;
    this._pendingFetches = fetches;
    this._syncing = mutations > 0 || fetches > 0;
  }
}
