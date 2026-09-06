import { describe, expect, it, vi } from "vitest";
import { flushSync } from "svelte";
import { createAuth, SerializableError } from "../src/client/index.js";

class Denied extends SerializableError { static readonly code = "Denied"; }

const session = { user: { id: "u1", name: "Alice" }, claims: { tenant: "t1" } };
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => { resolve = r; });
  return { promise, resolve };
}

describe("API-based auth", () => {
  it.each(["login", "google", "tma"])("authenticates through %s without a data client", async (action) => {
    const fetcher = vi.fn().mockResolvedValue(Response.json(session));
    vi.stubGlobal("fetch", fetcher);
    const onSession = vi.fn();
    const auth = createAuth({ routesBase: "/auth/", onSession });
    if (action === "login") await auth.login({ password: "secret" });
    if (action === "google") await auth.loginWithGoogle("credential");
    if (action === "tma") await auth.loginWithTma({ initData: "signed" });
    expect(fetcher.mock.calls[0][0]).toBe(`/auth/${action}`);
    expect(auth.session).toEqual(session);
    expect(auth.isAuthenticated).toBe(true);
    expect(onSession).toHaveBeenCalledWith(session);
  });

  it("does not restore a session when a refresh finishes after logout", async () => {
    const pending = deferred<Response>();
    vi.stubGlobal("fetch", vi.fn().mockReturnValueOnce(pending.promise).mockResolvedValue(new Response(null, { status: 204 })));
    const auth = createAuth();
    auth.user = session.user;
    const refresh = auth.refresh();
    expect(auth.isVerifying).toBe(true);
    await auth.logout();
    pending.resolve(Response.json(session));
    await refresh;
    expect(auth.session).toBeNull();
    expect(auth.isVerifying).toBe(false);
  });

  it("ignores an old 401 after a new login", async () => {
    const pending = deferred<Response>();
    vi.stubGlobal("fetch", vi.fn().mockReturnValueOnce(pending.promise).mockResolvedValue(Response.json(session)));
    const onInvalidSession = vi.fn();
    const auth = createAuth({ onInvalidSession });
    const refresh = auth.refresh();
    await auth.login({});
    pending.resolve(new Response(null, { status: 401 }));
    await refresh;
    expect(auth.session).toEqual(session);
    expect(onInvalidSession).not.toHaveBeenCalled();
  });

  it("checks for stale state again after reading the response body", async () => {
    const body = deferred<unknown>();
    vi.stubGlobal("fetch", vi.fn().mockResolvedValueOnce({ ok: true, status: 200, json: () => body.promise }).mockResolvedValue(new Response(null, { status: 204 })));
    const auth = createAuth();
    const refresh = auth.refresh();
    await Promise.resolve();
    await auth.logout();
    body.resolve(session);
    await refresh;
    expect(auth.session).toBeNull();
  });

  it("cleans up on 401 even when the invalid-session hook throws", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(null, { status: 401 })));
    const onLogout = vi.fn();
    const onSession = vi.fn();
    const auth = createAuth({ onSession, onLogout, onInvalidSession: () => { throw new Error("hook failed"); } });
    auth.user = session.user;
    await expect(auth.refresh()).rejects.toThrow("hook failed");
    expect(auth.session).toBeNull();
    expect(auth.isReady).toBe(true);
    expect(onSession).toHaveBeenCalledWith(null);
    expect(onLogout).toHaveBeenCalledOnce();
  });

  it.each(["network", "http"])("reports logout %s failure and still cleans local data", async (failure) => {
    vi.stubGlobal("fetch", failure === "network"
      ? vi.fn().mockRejectedValue(new Error("offline"))
      : vi.fn().mockResolvedValue(new Response("failed", { status: 500 })));
    const onLogout = vi.fn();
    const auth = createAuth({ onLogout });
    auth.user = session.user;
    await expect(auth.logout()).rejects.toThrow();
    expect(auth.session).toBeNull();
    expect(onLogout).toHaveBeenCalledOnce();
  });

  it("preserves the session on a transient refresh failure", async () => {
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("offline")));
    const auth = createAuth();
    auth.user = session.user;
    await expect(auth.refresh()).rejects.toThrow("offline");
    expect(auth.user).toEqual(session.user);
    expect(auth.isVerifying).toBe(false);
  });

  it("restores application error subclasses without importing sync", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(Response.json({ code: "Denied", message: "No access" }, { status: 400 })));
    await expect(createAuth({ errorClasses: [Denied] }).login({})).rejects.toBeInstanceOf(Denied);
  });

  it("rejects malformed successful responses", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(Response.json({ user: null })));
    const auth = createAuth();
    await expect(auth.login({})).rejects.toThrow("Invalid auth session response");
    expect(auth.isAuthenticated).toBe(false);
  });

  it("follows same-user profile and claims replacements from server load", () => {
    const fetcher = vi.fn();
    vi.stubGlobal("fetch", fetcher);
    type Profile = typeof session.user;
    type Claims = typeof session.claims;
    let data = $state(session);
    const auth = createAuth<Profile, Claims>({ refreshOnInit: false });
    const stop = $effect.root(() => auth.init(() => data.user, () => data.claims));
    try {
      flushSync();
      auth.user = { id: "u1", name: "Local" };
      data = { user: { id: "u1", name: "Updated" }, claims: { tenant: "t2" } };
      flushSync();
      expect(auth.session).toEqual({ user: { id: "u1", name: "Updated" }, claims: { tenant: "t2" } });
      expect(fetcher).not.toHaveBeenCalled();
    } finally { stop(); }
  });

  it("refreshes once during initialization and becomes ready", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(Response.json(session)));
    const auth = createAuth();
    const stop = $effect.root(() => auth.init(session.user));
    try {
      flushSync();
      await vi.waitFor(() => expect(auth.isReady).toBe(true));
      expect(fetch).toHaveBeenCalledTimes(1);
      expect(auth.session).toEqual(session);
    } finally { stop(); }
  });
});
