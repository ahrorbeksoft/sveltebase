import { describe, expect, it, vi } from "vitest";
import { Cookies } from "../src/index.js";

describe("Cookies", () => {
  it("round-trips encoded names and values", () => {
    Cookies.set("user name", "a=b; привет %");
    expect(Cookies.get("user name")).toBe("a=b; привет %");
    expect(Cookies.get("missing")).toBeNull();
  });
  it("matches cookie names literally", () => {
    Cookies.set("aXb", "wrong");
    Cookies.set("a.b", "right");
    Cookies.set("a(b)", "parentheses");
    expect(Cookies.get("a.b")).toBe("right");
    expect(Cookies.get("a(b)")).toBe("parentheses");
  });
  it("reads empty values and values containing equals", () => {
    document.cookie = "empty=";
    document.cookie = "token=a=b=c";
    expect(Cookies.get("empty")).toBe("");
    expect(Cookies.get("token")).toBe("a=b=c");
  });
  it("handles malformed URI encoding without throwing", () => {
    document.cookie = "broken=%E0%A4%A";
    expect(Cookies.get("broken")).toBeNull();
  });
  it("sets browser defaults and all explicit attributes", () => {
    const write = vi.spyOn(document, "cookie", "set");
    Cookies.set("theme", "dark");
    expect(write).toHaveBeenLastCalledWith("theme=dark; path=/; samesite=Lax; secure");
    Cookies.set("x", "y", { expires: 0.5, path: "/app", domain: "example.test", sameSite: "None", secure: false, partitioned: true });
    expect(write).toHaveBeenLastCalledWith("x=y; max-age=43200; path=/app; domain=example.test; samesite=None; secure; partitioned");
  });
  it("treats zero days as immediate expiration", () => {
    Cookies.set("session", "old");
    Cookies.set("session", "new", { expires: 0 });
    expect(Cookies.get("session")).toBeNull();
  });
  it("removes cookies and forwards their scope", () => {
    Cookies.set("theme", "dark");
    Cookies.remove("theme");
    expect(Cookies.get("theme")).toBeNull();
    const write = vi.spyOn(document, "cookie", "set");
    Cookies.remove("scoped", { path: "/app", domain: "example.test" });
    expect(write.mock.lastCall?.[0]).toContain("max-age=-86400; path=/app; domain=example.test");
  });
  it("does not mark HTTP cookies secure by default", () => {
    vi.stubGlobal("window", { location: { protocol: "http:" } });
    const write = vi.spyOn(document, "cookie", "set");
    Cookies.set("x", "y");
    expect(write).toHaveBeenLastCalledWith("x=y; path=/; samesite=Lax");
  });
});
