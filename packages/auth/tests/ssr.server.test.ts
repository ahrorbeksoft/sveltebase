import { expect, it, vi } from "vitest";
import { createAuth } from "../src/client/index.js";

it("initializes isolated server auth state without fetching", () => {
  const fetcher = vi.fn();
  vi.stubGlobal("fetch", fetcher);
  const first = createAuth();
  const second = createAuth();
  first.init({ id: "first" });
  second.init({ id: "second" });
  expect(first.user?.id).toBe("first");
  expect(second.user?.id).toBe("second");
  expect(first.isReady).toBe(true);
  expect(fetcher).not.toHaveBeenCalled();
});
