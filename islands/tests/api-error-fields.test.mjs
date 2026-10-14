// HFY-TSK-193: ApiError keeps the API's details.fields (a 422) and details.current (a 409), beside the older single details.field.
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { ApiError, createApi } from "../src/lib/api.js";

const reply = (status, body) => async () => ({ status, ok: status < 400, json: async () => body });

describe("ApiError.fields", () => {
  it("exposes details.fields on a 422", async () => {
    const fields = [{ field: "website", code: "wrong_platform", suggest: "facebook" }];
    const api = createApi({ fetchImpl: reply(422, { error: "validation", message: "bad", details: { fields } }), skipWhenSignedOut: false });
    await assert.rejects(api.put?.("/people/I0001/links", {}) ?? api.request("PUT", "/people/I0001/links", { body: {} }), (e) => {
      assert.ok(e instanceof ApiError);
      assert.equal(e.status, 422);
      assert.equal(e.code, "validation");
      assert.deepEqual(e.fields, fields);
      return true;
    });
  });

  it("exposes details.current on a 409, keeps details.field, and has no fields when the body has none", async () => {
    const current = { links: {}, version: 3 };
    const api = createApi({ fetchImpl: reply(409, { error: "conflict", details: { current } }), skipWhenSignedOut: false });
    await assert.rejects(api.request("PUT", "/x", { body: {} }), (e) => e.details.current === current || JSON.stringify(e.details.current) === JSON.stringify(current));
    const single = createApi({ fetchImpl: reply(400, { error: "validation", details: { field: "body" } }), skipWhenSignedOut: false });
    await assert.rejects(single.request("GET", "/x"), (e) => e.field === "body" && e.fields === undefined);
    const none = createApi({ fetchImpl: reply(403, { error: "forbidden" }), skipWhenSignedOut: false });
    await assert.rejects(none.request("GET", "/x"), (e) => e.fields === undefined && e.details === undefined);
  });
});
