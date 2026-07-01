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
