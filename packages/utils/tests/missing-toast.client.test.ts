import { expect, it, vi } from "vitest";
import { createAsync, tryCatch } from "../src/index.js";
vi.mock("esm-env", () => ({ BROWSER: true, DEV: true }));
vi.mock("svelte-sonner", () => { throw new Error("Toast chunk unavailable"); });

it("allows actions to finish when the toast import fails", async () => {
  vi.spyOn(console, "error").mockImplementation(() => {});
  const action = createAsync(async () => ({ success: "Saved" }));
  await expect(action.run()).resolves.toEqual({ success: "Saved" });
  expect(action.isLoading()).toBe(false);
  expect(action.error).toBeNull();
  await expect(tryCatch(() => ({ error: "Failed" }))).resolves.toBeUndefined();
  await expect(tryCatch(() => ({ success: "Saved" }))).resolves.toBeUndefined();
});
