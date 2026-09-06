import { afterEach, describe, expect, it, vi } from "vitest";
import { Cookies, createAsync, createId, pluralize, timestamps, tryCatch, wait } from "../src/index.js";

afterEach(() => vi.useRealTimers());

describe("server-safe utilities", () => {
  it("makes cookies no-ops without a DOM", () => {
    expect(Cookies.get("x")).toBeNull();
    expect(() => Cookies.set("x", "y")).not.toThrow();
    expect(() => Cookies.remove("x")).not.toThrow();
  });
  it("runs async helpers without importing browser toast code", async () => {
    await expect(tryCatch(() => ({ success: "ok" }))).resolves.toBeUndefined();
    const action = createAsync(async () => ({ success: "ok" }));
    await expect(action.run()).resolves.toEqual({ success: "ok" });
    expect(action.isLoading()).toBe(false);
    const onError = vi.fn();
    vi.spyOn(console, "error").mockImplementation(() => {});
    await tryCatch(() => { throw "failure"; }, { onError });
    expect(onError).toHaveBeenCalledWith(expect.objectContaining({ message: "failure" }));
  });
  it("uses a single timestamp for creation and update", () => {
    vi.spyOn(Date, "now").mockReturnValue(12345);
    expect(timestamps(false)).toEqual({ createdAt: 12345, updatedAt: 12345 });
    expect(timestamps(true)).toEqual({ updatedAt: 12345 });
  });
  it("waits for the requested duration", async () => {
    vi.useFakeTimers();
    const done = vi.fn();
    const pending = wait(100).then(done);
    await vi.advanceTimersByTimeAsync(99);
    expect(done).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    await pending;
    expect(done).toHaveBeenCalledOnce();
  });
  it.each([
    [0, { zero: "No items", one: "item", other: "items" }, "No items"],
    [1, { one: "item", other: "items" }, "1 item"],
    [2, { one: "item", other: "items" }, "2 items"],
    [0, { other: "items" }, "0 items"],
    [1, { other: "items" }, "1 items"],
    [-2, { other: (n: number) => `${n} matches` }, "-2 matches"]
  ] as const)("pluralizes %s", (count, options, expected) => {
    expect(pluralize(count, options)).toBe(expected);
  });
  it("prefers native UUIDs", () => {
    const randomUUID = vi.fn(() => "native-id");
    vi.stubGlobal("crypto", { randomUUID });
    expect(createId()).toBe("native-id");
    expect(randomUUID).toHaveBeenCalledOnce();
  });
  it.each([true, false])("generates UUID v4 shape with crypto fallback: %s", (cryptoAvailable) => {
    vi.stubGlobal("crypto", cryptoAvailable ? { getRandomValues: (array: Uint8Array) => array.fill(171) } : undefined);
    expect(createId()).toMatch(/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/);
  });
});
