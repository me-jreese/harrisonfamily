import { describe, it, expect, vi, beforeAll } from "vitest";
import { originVerified } from "../src/origin.js";

const SECRET = "s3cret-origin-value";
const ev = (headers) => ({ rawPath: "/auth/session", requestContext: { http: { method: "GET" } }, headers });

describe("origin verify (HFY-R43)", () => {
  it("accepts only the exact secret, case-insensitive header name", () => {
    expect(originVerified(ev({ "x-origin-verify": SECRET }), SECRET)).toBe(true);
    expect(originVerified(ev({ "X-Origin-Verify": SECRET }), SECRET)).toBe(true);
    for (const h of [{}, { "x-origin-verify": "" }, { "x-origin-verify": "wrong" }, { "x-origin-verify": SECRET + "x" }, { "x-origin-verify": SECRET.slice(1) }]) expect(originVerified(ev(h), SECRET)).toBe(false);
  });
  it("fails closed when the secret is not configured", () => {
    expect(originVerified(ev({ "x-origin-verify": "" }), "")).toBe(false);
    expect(originVerified(ev({ "x-origin-verify": "x" }), undefined)).toBe(false);
  });
});

describe("hfy-auth-edge handler gate", () => {
  let handler;
  beforeAll(async () => { process.env.ORIGIN_VERIFY = SECRET; ({ handler } = await import("../src/index.js")); vi.spyOn(console, "error").mockImplementation(() => {}); });
  it("403 before routing without or with a wrong header, including the JWKS and discovery paths", async () => {
    for (const path of ["/auth/session", "/auth/.well-known/jwks.json", "/.well-known/oauth-authorization-server/auth", "/auth/token"]) {
      for (const headers of [{}, { "x-origin-verify": "nope" }]) {
        const r = await handler({ ...ev(headers), rawPath: path });
        expect(r.statusCode).toBe(403);
        expect(JSON.parse(r.body)).toEqual({ error: "forbidden" });
      }
    }
  });
  it("403 when the Lambda has no ORIGIN_VERIFY configured", async () => {
    delete process.env.ORIGIN_VERIFY;
    try { expect((await handler(ev({ "x-origin-verify": SECRET }))).statusCode).toBe(403); } finally { process.env.ORIGIN_VERIFY = SECRET; }
  });
  it("a correct header passes the gate (init then fails on the missing test env, which is a 500, not a 403)", async () => {
    expect((await handler(ev({ "x-origin-verify": SECRET }))).statusCode).toBe(500);
  });
});
