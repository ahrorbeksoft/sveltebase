import { describe, expect, it, vi } from "vitest";
import type { Cookies, RequestEvent } from "@sveltejs/kit";
import { createServerAuth, signJWT, verifyJWT, getSessionFromRequest, signSessionPayload } from "../src/index.js";
import { createAuthRoutes } from "../src/sveltekit/index.js";
import { SerializableError, serializeAuthError, createAuthErrorCodec } from "../src/errors.js";

const secret = "test-signing-secret";
function cookieJar() {
  const values = new Map<string, string>();
  return {
    get: vi.fn((name: string) => values.get(name)),
    set: vi.fn((name: string, value: string) => { values.set(name, value); }),
    delete: vi.fn((name: string) => { values.delete(name); }),
  } as unknown as Cookies;
}
function event(action: string, cookies: Cookies, body = "{}") {
  return { params: { auth: action }, cookies, request: new Request(`https://example.test/api/auth/${action}`, { method: "POST", body }) } as unknown as RequestEvent;
}

describe("auth routes", () => {
  it("does not expose claims updates without an authorization callback", async () => {
    const cookies = cookieJar();
    const auth = createServerAuth<{ id: string }, Record<string, unknown>>({ secret });
    await auth.login(cookies, { id: "u1" }, { claims: { role: "reader" } });
    const routes = createAuthRoutes({ auth });
    expect((await routes.POST(event("claims", cookies, '{"role":"admin"}'))).status).toBe(404);
    expect((await auth.getSession(cookies))?.claims).toEqual({ role: "reader" });
  });

  it("writes only claims returned by the server callback", async () => {
    const cookies = cookieJar();
    const auth = createServerAuth<{ id: string }, Record<string, unknown>>({ secret });
    await auth.login(cookies, { id: "u1" });
    const routes = createAuthRoutes({ auth, setClaims: () => ({ role: "reader" }) });
    expect((await routes.POST(event("claims", cookies, '{"role":"admin"}'))).status).toBe(200);
    expect((await auth.getSession(cookies))?.claims).toEqual({ role: "reader" });
  });

  it("rejects malformed JSON before invoking login", async () => {
    const login = vi.fn(() => ({ id: "u1" }));
    const routes = createAuthRoutes({ auth: createServerAuth({ secret }), login });
    expect((await routes.POST(event("login", cookieJar(), "{broken"))).status).toBe(400);
    expect(login).not.toHaveBeenCalled();
  });

  it("returns a serialized auth error with the expected status", async () => {
    class Denied extends SerializableError { static readonly code = "Denied"; }
    const routes = createAuthRoutes({ auth: createServerAuth({ secret }), login: () => { throw new Denied("No access"); } });
    const response = await routes.POST(event("login", cookieJar()));
    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ code: "Denied", message: "No access" });
  });

  it("refreshes the profile and preserves server-issued claims", async () => {
    const cookies = cookieJar();
    const auth = createServerAuth<{ id: string; name: string }, { role: string }>({ secret });
    await auth.login(cookies, { id: "u1", name: "Old" }, { claims: { role: "reader" } });
    const routes = createAuthRoutes({ auth, getUser: (id) => ({ id, name: "New" }) });
    const response = await routes.POST(event("refresh", cookies));
    expect(await response.json()).toEqual({ user: { id: "u1", name: "New" }, claims: { role: "reader" } });
  });
});

describe("session cookies", () => {
  it("deletes cookies using their configured path and domain", () => {
    const cookies = cookieJar();
    createServerAuth({ secret, cookieOptions: { path: "/app", domain: "example.test" } }).logout(cookies);
    expect(cookies.delete).toHaveBeenCalledWith("sf_session", { path: "/app", domain: "example.test" });
  });
  it("honors zero maxAge and the default expires in the signed token", async () => {
    const cookies = cookieJar();
    const auth = createServerAuth({ secret, cookieOptions: { maxAge: 3600 } });
    await auth.login(cookies, { id: "u1" }, { maxAge: 0 });
    expect(await auth.getSession(cookies)).toBeNull();
    const expired = createServerAuth({ secret, cookieOptions: { expires: new Date(0) } });
    await expired.login(cookies, { id: "u1" });
    expect(await expired.getSession(cookies)).toBeNull();
  });
  it.each([0, "invalid"])("rejects invalid or expired exp=%s", async (exp) => {
    await expect(verifyJWT(await signJWT({ exp }, secret), secret)).rejects.toThrow();
  });
  it("ignores malformed unrelated cookies", async () => {
    const token = await signSessionPayload({ user: { id: "u1" }, claims: {} }, secret);
    const request = new Request("https://example.test", { headers: { Cookie: `broken=%E0%A4%A; sf_session=${token}` } });
    expect((await getSessionFromRequest(request, secret))?.user.id).toBe("u1");
  });
  it("rejects a tampered session", async () => {
    const token = await signJWT({ user: { id: "u1" } }, "different-secret");
    expect(await getSessionFromRequest(new Request("https://example.test", { headers: { Cookie: `sf_session=${token}` } }), secret)).toBeNull();
  });
});

it("round trips standalone auth errors", () => {
  class Custom extends SerializableError { static readonly code = "Custom"; }
  const payload = serializeAuthError(new Custom("message"));
  expect(createAuthErrorCodec([Custom]).deserialize(payload)).toBeInstanceOf(Custom);
  expect(() => createAuthErrorCodec([Custom, Custom])).toThrow("Duplicate auth error code");
});
