import { describe, it, expect, beforeAll } from "vitest";
import { originVerified } from "../src/origin.js";

const SECRET = "s3cret-origin-value";
const ev = (headers, rawPath = "/api/posts") => ({ rawPath, requestContext: { http: { method: "GET" } }, headers });

describe("origin verify (HFY-R43)", () => {
  it("accepts only the exact secret, case-insensitive header name; fails closed with no secret", () => {
    expect(originVerified(ev({ "x-origin-verify": SECRET }), SECRET)).toBe(true);
    expect(originVerified(ev({ "X-Origin-Verify": SECRET }), SECRET)).toBe(true);
    for (const h of [{}, { "x-origin-verify": "" }, { "x-origin-verify": "wrong" }, { "x-origin-verify": SECRET + "x" }]) expect(originVerified(ev(h), SECRET)).toBe(false);
    expect(originVerified(ev({ "x-origin-verify": "x" }), "")).toBe(false);
  });
});

describe("hfy-api handler gate", () => {
  let handler;
  beforeAll(async () => { process.env.ORIGIN_VERIFY = SECRET; ({ handler } = await import("../src/index.js")); });
  it("403 before routing without or with a wrong header", async () => {
    for (const headers of [{}, { "x-origin-verify": "nope" }]) {
      const r = await handler(ev(headers));
      expect(r.statusCode).toBe(403);
      expect(JSON.parse(r.body)).toEqual({ error: "forbidden" });
    }
  });
  it("403 when the Lambda has no ORIGIN_VERIFY configured", async () => {
    delete process.env.ORIGIN_VERIFY;
    try { expect((await handler(ev({ "x-origin-verify": SECRET }))).statusCode).toBe(403); } finally { process.env.ORIGIN_VERIFY = SECRET; }
  });
  it("a correct header reaches the router (not a 403)", async () => {
    const r = await handler(ev({ "x-origin-verify": SECRET }, "/api/nonexistent"));
    expect(r.statusCode).not.toBe(403);
  });
});
