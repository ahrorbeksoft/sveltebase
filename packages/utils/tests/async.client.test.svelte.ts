import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { flushSync } from "svelte";
import { createAsync, tryCatch } from "../src/index.js";

const toast = vi.hoisted(() => ({ success: vi.fn(), error: vi.fn() }));
vi.mock("svelte-sonner", () => ({ toast }));
const env = vi.hoisted(() => ({ BROWSER: true, DEV: true }));
vi.mock("esm-env", () => env);

function deferred() {
  let resolve!: () => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<void>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
beforeEach(() => {
  vi.clearAllMocks();
  env.DEV = true;
  vi.spyOn(console, "error").mockImplementation(() => {});
});
afterEach(() => { env.DEV = true; });

describe("createAsync", () => {
  it("forwards arguments, returns results and reacts to loading", async () => {
    const pending = deferred();
    const fn = vi.fn(async (id: number, name: string) => { await pending.promise; return { success: `${id}:${name}` }; });
    const action = createAsync(fn);
    const observed: boolean[] = [];
    const stop = $effect.root(() => { $effect(() => { observed.push(action.isLoading()); }); });
    try {
      flushSync();
      const run = action.run(7, "saved");
      flushSync();
      expect(fn).toHaveBeenCalledWith(7, "saved");
      expect(action.error).toBeNull();
      pending.resolve();
      await expect(run).resolves.toEqual({ success: "7:saved" });
      flushSync();
      expect(observed).toEqual([false, true, false]);
      expect(toast.success).toHaveBeenCalledWith("7:saved");
    } finally { stop(); }
  });
  it("tracks independent keys separately from global loading", async () => {
    const a = deferred(), b = deferred();
    const action = createAsync((key: string) => key === "a" ? a.promise : b.promise);
    const first = action.runWithKey("a", "a"), second = action.runWithKey("b", "b");
    expect(action.isLoading()).toBe(false);
    expect(action.isLoading("a")).toBe(true);
    expect(action.isLoading("b")).toBe(true);
    a.resolve(); await first;
    expect(action.isLoading("a")).toBe(false);
    expect(action.isLoading("b")).toBe(true);
    b.resolve(); await second;
    expect(action.isLoading("b")).toBe(false);
  });
  it.each([undefined, "row"])("keeps loading until all overlapping calls finish (%s)", async (key) => {
    const a = deferred(), b = deferred();
    const fn = vi.fn().mockReturnValueOnce(a.promise).mockReturnValueOnce(b.promise);
    const action = createAsync(fn);
    const run = () => key === undefined ? action.run() : action.runWithKey(key);
    const first = run(), second = run();
    a.resolve(); await first;
    expect(action.isLoading(key)).toBe(true);
    b.resolve(); await second;
    expect(action.isLoading(key)).toBe(false);
  });
  it("normalizes an empty key consistently", async () => {
    const pending = deferred();
    const action = createAsync(() => pending.promise);
    const run = action.runWithKey("");
    expect(action.isLoading("")).toBe(true);
    expect(action.isLoading()).toBe(true);
    pending.resolve(); await run;
  });
  it("treats returned errors as results, not exceptions", async () => {
    const action = createAsync(async () => ({ error: "Rejected" }));
    await expect(action.run()).resolves.toEqual({ error: "Rejected" });
    expect(action.error).toBeNull();
    expect(toast.error).toHaveBeenCalledWith("Rejected", undefined);
  });
  it.each([new TypeError("bad"), "bad"])("normalizes thrown errors and resets error on the next run", async (failure) => {
    const fn = vi.fn().mockRejectedValueOnce(failure).mockResolvedValueOnce(undefined);
    const action = createAsync(fn);
    await expect(action.run()).rejects.toThrow("bad");
    expect(action.error).toBeInstanceOf(Error);
    expect(action.isLoading()).toBe(false);
    expect(toast.error).toHaveBeenCalledWith(action.error!.name, { description: "bad" });
    await action.run();
    expect(action.error).toBeNull();
  });
  it("uses a generic production error toast", async () => {
    env.DEV = false;
    const action = createAsync(async () => { throw new Error("private"); });
    await expect(action.run()).rejects.toThrow("private");
    expect(toast.error).toHaveBeenCalledWith("Something went wrong", undefined);
    expect(console.error).not.toHaveBeenCalled();
  });
  it.each([undefined, null])("silently completes %s results", async (result) => {
    await createAsync(async () => result).run();
    expect(toast.success).not.toHaveBeenCalled();
    expect(toast.error).not.toHaveBeenCalled();
  });
});

describe("tryCatch", () => {
  it.each([{ success: "Saved" }, { error: "Invalid" }, null, undefined])("handles task result %j", async (result) => {
    await expect(tryCatch(() => result)).resolves.toBeUndefined();
    expect(toast.success).toHaveBeenCalledTimes(result?.success ? 1 : 0);
    expect(toast.error).toHaveBeenCalledTimes(result?.error ? 1 : 0);
  });
  it.each(["Custom", { message: "Custom", description: "Retry" }, null, undefined])("awaits custom error handler returning %j", async (custom) => {
    const onError = vi.fn(async () => custom);
    await expect(tryCatch(() => { throw "bad"; }, { onError })).resolves.toBeUndefined();
    expect(onError).toHaveBeenCalledWith(expect.objectContaining({ message: "bad" }));
    if (typeof custom === "string") expect(toast.error).toHaveBeenCalledWith("Custom", undefined);
    else if (custom) expect(toast.error).toHaveBeenCalledWith("Custom", { description: "Retry" });
    else expect(toast.error).toHaveBeenCalledWith("Error", { description: "bad" });
  });
  it("hides internal errors in production", async () => {
    env.DEV = false;
    await tryCatch(async () => { throw new Error("private"); });
    expect(toast.error).toHaveBeenCalledWith("Something went wrong", undefined);
    expect(console.error).not.toHaveBeenCalled();
  });
});
