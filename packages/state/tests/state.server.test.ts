import { beforeEach, expect, it, vi } from "vitest";
import { z } from "zod";
import { PersistentState, State } from "../src/index.js";
const schema = z.enum(["light", "dark"]).default("light");
beforeEach(() => vi.spyOn(console, "warn").mockImplementation(() => {}));

it("constructs and updates plain state during SSR", () => {
  const state = new State(2);
  state.set((n) => n * 2);
  expect(state.current).toBe(4);
});
it.each(['"dark"', '%22dark%22'])("initializes from raw or encoded request cookies: %s", (value) => {
  const state = new PersistentState("theme", schema);
  expect(state.current).toBe("light");
  const cookie = vi.fn(() => value);
  state.init(cookie);
  expect(cookie).toHaveBeenCalledOnce();
  expect(state.current).toBe("dark");
});
it("resets to the default when the next request has no cookie", () => {
  const state = new PersistentState("theme", schema);
  state.init('"dark"');
  state.init();
  expect(state.current).toBe("light");
});
it.each(['"invalid"', "not json", "%E0%A4%A"])("resets invalid request cookie %s instead of retaining the previous request", (value) => {
  const state = new PersistentState("theme", schema);
  state.init('"dark"');
  state.init(value);
  expect(state.current).toBe("light");
  expect(console.warn).toHaveBeenCalled();
});
it("does not replace equal parsed objects", () => {
  const state = new PersistentState("object", z.object({ a: z.number() }).default({ a: 1 }));
  const before = state.current;
  state.init('{"a":1}');
  expect(state.current).toBe(before);
});
it.each([undefined, null, () => undefined, () => null])("defaults missing serialized values: %s", (value) => {
  const state = new PersistentState("theme", schema);
  state.current = "dark";
  state.init(value);
  expect(state.current).toBe("light");
});
