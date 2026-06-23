export class ConnectionStatus {
  private _value = $state<"connecting" | "connected" | "disconnected">("connecting");

  get value() {
    return this._value;
  }

  set value(newValue: "connecting" | "connected" | "disconnected") {
    this._value = newValue;
  }
}
