import { beforeEach, describe, expect, it, vi } from "vitest";
import { flushSync } from "svelte";
import { z } from "zod";
import { Cookies } from "@sveltebase/utils";
import { PersistentState, State } from "../src/index.js";

const schema = z.object({ count: z.number().int().min(0) }).default({ count: 0 });
beforeEach(() => vi.spyOn(console, "warn").mockImplementation(() => {}));

describe("State", () => {
  it("supports direct and callback updates", () => {
    const state = new State(1);
    state.current = 2;
    state.set((n) => n + 3);
    expect(state.current).toBe(5);
  });
  it("reacts to replacements and nested changes", () => {
    const state = new State({ nested: { count: 0 } });
    const observed: number[] = [];
    const stop = $effect.root(() => { $effect(() => { observed.push(state.current.nested.count); }); });
    try {
      flushSync();
      state.current.nested.count++;
      flushSync();
      state.current = { nested: { count: 5 } };
      flushSync();
      expect(observed).toEqual([0, 1, 5]);
    } finally { stop(); }
  });
});

describe("PersistentState in the browser", () => {
  it("hydrates an existing JSON cookie and persists changes", () => {
    Cookies.set("counter", JSON.stringify({ count: 2 }));
    const state = new PersistentState("counter", schema);
    expect(state.current).toEqual({ count: 2 });
    state.current = { count: 3 };
    flushSync();
    expect(JSON.parse(Cookies.get("counter")!)).toEqual({ count: 3 });
    state.current.count = 4;
    flushSync();
    expect(JSON.parse(Cookies.get("counter")!)).toEqual({ count: 4 });
  });
  it.each([undefined, "not json", '{"count":-1}', "%E0%A4%A"])("defaults invalid or absent cookie %s", (raw) => {
    if (raw !== undefined) document.cookie = `counter=${raw}`;
    const state = new PersistentState("counter", schema);
    expect(state.current).toEqual({ count: 0 });
    flushSync();
    expect(JSON.parse(Cookies.get("counter")!)).toEqual({ count: 0 });
  });
  it("supports legacy double-encoded cookies", () => {
    Cookies.set("counter", encodeURIComponent(JSON.stringify({ count: 8 })));
    expect(new PersistentState("counter", schema).current).toEqual({ count: 8 });
  });
  it("rejects invalid assignments without changing state or storage", () => {
    const state = new PersistentState("counter", schema);
    flushSync();
    expect(() => { state.current = { count: -1 }; }).toThrow();
    expect(state.current).toEqual({ count: 0 });
    flushSync();
    expect(JSON.parse(Cookies.get("counter")!)).toEqual({ count: 0 });
  });
  it("validates callback updates just like assignments", () => {
    const state = new PersistentState("counter", schema);
    state.set((value) => ({ count: value.count + 2 }));
    expect(state.current.count).toBe(2);
    expect(() => state.set(() => ({ count: -1 }))).toThrow();
    expect(state.current.count).toBe(2);
  });
  it("applies schema transforms to callback updates", () => {
    const state = new PersistentState("name", z.string().trim().default("initial"));
    state.set(() => "  trimmed  ");
    expect(state.current).toBe("trimmed");
  });
  it("ignores server init and its getter in the browser", () => {
    const state = new PersistentState("counter", schema);
    const cookie = vi.fn(() => '{"count":9}');
    state.init(cookie);
    expect(cookie).not.toHaveBeenCalled();
    expect(state.current.count).toBe(0);
  });
  it("rejects async validators explicitly", () => {
    const asyncSchema = { "~standard": { version: 1 as const, vendor: "test", validate: async () => ({ value: 0 }) } };
    expect(() => new PersistentState("async", asyncSchema)).toThrow("Async schemas are not supported");
  });
  it("provides useful validation errors", () => {
    const invalid = { "~standard": { version: 1 as const, vendor: "test", validate: () => ({ issues: [{ message: "first" }, { message: "second" }] }) } };
    expect(() => new PersistentState("invalid", invalid)).toThrow("first, second");
    invalid["~standard"].validate = () => ({ issues: [] });
    expect(() => new PersistentState("invalid", invalid)).toThrow("Validation failed");
  });
});
