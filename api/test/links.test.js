// HFY-TSK-193 (surf-links-api): GET and PUT /api/people/:id/links, the PLINKS#/META item with its AUDIT#plinks: item in one transaction, the
// status matrix (owner 200, non-owner 403, admin non-null 403, admin clear 200, invalid 422 with details.fields, stale 409 with the current item).
import { beforeEach, describe, expect, it } from "vitest";
import { makeApi, signToken } from "./world.js";
import { buildCaps } from "../src/routes.js";
import { errorResponse, HttpError } from "../src/http.js";

const OWNER = "I0001";
const OTHER = "I0002";
const ADMIN = "I0099";
const PATH = `/api/people/${OWNER}/links`;
const IG = { url: "https://www.instagram.com/jane.example/", handle: "jane.example" };

describe("profile links API (synthetic ids)", () => {
  let w, owner, other, admin;
  const put = (token, links, version, path = PATH) => w.call("PUT", path, { token, body: { links, version } });
  beforeEach(async () => {
    w = makeApi({ admins: [ADMIN], flags: { profileLinks: true } });
    [owner, other, admin] = await Promise.all([OWNER, OTHER, ADMIN].map((s) => signToken(s)));
  });

  it("GET with no item is {links:{}, version:0} and can.edit follows ownership", async () => {
    expect((await w.call("GET", PATH, { token: owner })).body).toEqual({ links: {}, version: 0, can: { edit: true } });
    expect((await w.call("GET", PATH, { token: other })).body).toEqual({ links: {}, version: 0, can: { edit: false } });
    expect((await w.call("GET", PATH)).status).toBe(401);
    expect((await w.call("GET", "/api/people/bad%20id/links", { token: owner })).status).toBe(400);
  });

  it("owner set returns 200 and writes the item and the audit item in one TransactWriteItems", async () => {
    const r = await put(owner, { instagram: "@jane.example", website: "https://example.org/about" }, 0);
    expect(r.status).toBe(200);
    expect(r.body).toEqual({ links: { instagram: IG, website: { url: "https://example.org/about", host: "example.org" } }, version: 1 });
    const rows = w.ddb.all();
    const item = rows.find((x) => x.PK === `PLINKS#${OWNER}`);
    expect(item).toMatchObject({ SK: "META", version: 1, updatedBy: OWNER, links: r.body.links });
    expect(typeof item.updatedAt).toBe("string");
    const audits = rows.filter((x) => x.PK === `AUDIT#plinks:${OWNER}`);
    expect(audits).toHaveLength(1);
    expect(audits[0]).toMatchObject({ op: "links.update", id: `plinks:${OWNER}`, principal: OWNER, before: { links: {}, version: 0 }, after: { version: 1 } });
    expect(w.ddb.calls.filter((c) => c === "TransactWriteCommand")).toHaveLength(1);
    expect(w.ddb.calls.filter((c) => c === "PutCommand")).toHaveLength(0);
    expect((await w.call("GET", PATH, { token: other })).body).toEqual({ ...r.body, can: { edit: false } });
  });

  it("platforms that are not in the body stay as they were; null clears one", async () => {
    await put(owner, { instagram: "@jane.example" }, 0);
    const r = await put(owner, { tiktok: "@jane.example" }, 1);
    expect(Object.keys(r.body.links).sort()).toEqual(["instagram", "tiktok"]);
    const c = await put(owner, { instagram: null }, 2);
    expect(c.body).toEqual({ links: { tiktok: { url: "https://www.tiktok.com/@jane.example", handle: "jane.example" } }, version: 3 });
    const ops = w.ddb.all().filter((x) => x.PK.startsWith("AUDIT#")).sort((a, b) => a.SK.localeCompare(b.SK)).map((x) => x.op);
    expect(ops).toEqual(["links.update", "links.update", "links.clear"]);
  });

  it("non-owner member is 403 before anything is validated or written", async () => {
    const r = await put(other, { instagram: "@jane.example" }, 0);
    expect(r.status).toBe(403);
    expect(r.body.error).toBe("forbidden");
    expect((await put(other, { instagram: null }, 0)).status).toBe(403);
    expect(w.ddb.all()).toEqual([]);
  });

  it("an admin setting a non-null value is 403; an admin clear is 200 and audited as links.clear by the admin", async () => {
    await put(owner, { instagram: "@jane.example", tiktok: "@jane.example" }, 0);
    const denied = await put(admin, { instagram: "@someone.else" }, 1);
    expect(denied.status).toBe(403);
    const cleared = await put(admin, { instagram: null }, 1);
    expect(cleared.status).toBe(200);
    expect(Object.keys(cleared.body.links)).toEqual(["tiktok"]);
    expect(cleared.body.version).toBe(2);
    const clear = w.ddb.all().find((x) => x.op === "links.clear");
    expect(clear).toMatchObject({ principal: ADMIN, id: `plinks:${OWNER}` });
    expect(clear.before.links.instagram).toEqual(IG);
    expect(clear.after.links.instagram).toBeUndefined();
    expect(w.ddb.all().find((x) => x.PK === `PLINKS#${OWNER}`).updatedBy).toBe(ADMIN);
  });

  it("an admin who owns the page has the owner's rights", async () => {
    const r = await w.call("PUT", `/api/people/${ADMIN}/links`, { token: admin, body: { links: { instagram: "@jane.example" }, version: 0 } });
    expect(r.status).toBe(200);
  });

  it("an invalid field is 422 with details.fields, and nothing is written", async () => {
    const r = await put(owner, { website: "facebook.com/jane.example", instagram: "@jane.example", snapchat: "mailto:a@b.example", myspace: "x" }, 0);
    expect(r.status).toBe(422);
    expect(r.body.error).toBe("validation");
    expect(r.body.details.fields).toEqual(expect.arrayContaining([
      { field: "website", code: "wrong_platform", suggest: "facebook" },
      { field: "snapchat", code: "contact_channel" },
      { field: "myspace", code: "unknown_platform" },
    ]));
    expect(r.body.details.fields.some((f) => f.field === "instagram")).toBe(false);
    expect(w.ddb.all()).toEqual([]);
    const nonString = await put(owner, { instagram: 5 }, 0);
    expect(nonString.status).toBe(422);
    expect(nonString.body.details.fields).toEqual([{ field: "instagram", code: "invalid_url" }]);
  });

  it("a malformed body is 400", async () => {
    expect((await w.call("PUT", PATH, { token: owner, body: { links: [], version: 0 } })).status).toBe(400);
    expect((await w.call("PUT", PATH, { token: owner, body: { links: {} } })).status).toBe(400);
    expect((await w.call("PUT", PATH, { token: owner, body: { links: {}, version: "0" } })).status).toBe(400);
  });

  it("a stale version is 409 with the current item, for a first write and for a later one", async () => {
    await put(owner, { instagram: "@jane.example" }, 0);
    const stale = await put(owner, { tiktok: "@jane.example" }, 0);
    expect(stale.status).toBe(409);
    expect(stale.body).toMatchObject({ error: "conflict", details: { current: { links: { instagram: IG }, version: 1 } } });
    const ahead = await put(owner, { tiktok: "@jane.example" }, 5);
    expect(ahead.status).toBe(409);
    expect(ahead.body.details.current.version).toBe(1);
  });

  it("a race lost inside the transaction is 409 with the winner's item, and the loser wrote nothing", async () => {
    let raced = false;
    const racing = makeApi({
      admins: [ADMIN], flags: { profileLinks: true },
      intercept: async (cmd) => {
        if (cmd.constructor.name === "TransactWriteCommand" && !raced) {
          raced = true;
          await racing.ddb.send(new (await import("./fake-ddb.js")).cmds.PutCommand({ TableName: "hfy-app", Item: { PK: `PLINKS#${OWNER}`, SK: "META", links: { tiktok: { url: "https://www.tiktok.com/@a.b", handle: "a.b" } }, version: 1 } }));
        }
      },
    });
    const r = await racing.call("PUT", PATH, { token: owner, body: { links: { instagram: "@jane.example" }, version: 0 } });
    expect(r.status).toBe(409);
    expect(r.body.details.current.version).toBe(1);
    expect(racing.ddb.all().filter((x) => x.PK.startsWith("AUDIT#"))).toEqual([]);
  });

  it("a no-op body writes nothing: empty body, or clearing platforms that are not set, or an admin clear on a missing item", async () => {
    const empty = await put(owner, {}, 0);
    expect(empty.status).toBe(200);
    expect(empty.body).toEqual({ links: {}, version: 0 });
    expect((await put(owner, { tiktok: null }, 0)).body.version).toBe(0);
    expect((await put(admin, { instagram: null }, 0)).status).toBe(200);
    expect(w.ddb.all()).toEqual([]);
    await put(owner, { instagram: "@jane.example" }, 0);
    const again = await put(owner, { tiktok: null }, 1);
    expect(again.body.version).toBe(1);
    expect(w.ddb.all().filter((x) => x.PK.startsWith("AUDIT#"))).toHaveLength(1);
    expect(w.ddb.calls.filter((c) => c === "TransactWriteCommand")).toHaveLength(1);
  });

  it("a stale version on a no-op body is still 409 (422 and 403 come first, then 409)", async () => {
    await put(owner, { instagram: "@jane.example" }, 0);
    expect((await put(owner, {}, 0)).status).toBe(409);
    expect((await put(owner, { myspace: "x" }, 0)).status).toBe(422);
    expect((await put(other, { instagram: null }, 0)).status).toBe(403);
  });

  it("a mixed set and clear body is audited as links.update; an all-clear body as links.clear", async () => {
    await put(owner, { instagram: "@jane.example" }, 0);
    await put(owner, { instagram: null, tiktok: "@jane.example" }, 1);
    await put(owner, { tiktok: null }, 2);
    const ops = w.ddb.all().filter((x) => x.PK.startsWith("AUDIT#")).sort((a, b) => a.SK.localeCompare(b.SK)).map((x) => x.op);
    expect(ops).toEqual(["links.update", "links.update", "links.clear"]);
  });

  it("the transaction guards the item with the version (or its absence for a first write)", async () => {
    const seen = [];
    const spy = makeApi({ flags: { profileLinks: true }, intercept: async (cmd) => { if (cmd.constructor.name === "TransactWriteCommand") seen.push(cmd.input.TransactItems[0].Put); } });
    const t = await signToken(OWNER);
    const go = (links, version) => spy.call("PUT", PATH, { token: t, body: { links, version } });
    await go({ instagram: "@jane.example" }, 0);
    await go({ tiktok: "@jane.example" }, 1);
    expect(seen[0].ConditionExpression).toBe("attribute_not_exists(PK)");
    expect(seen[1]).toMatchObject({ ConditionExpression: "#v = :v", ExpressionAttributeNames: { "#v": "version" }, ExpressionAttributeValues: { ":v": 1 } });
  });

  it("a cancelled transaction maps to 503 busy (conflict) or 503 unavailable (throttle); a condition failure is 409 with updatedAt", async () => {
    const t = await signToken(OWNER);
    const attempt = async (code) => {
      const f = makeApi({ flags: { profileLinks: true } });
      f.ddb.failNext(code, 20);
      const r = await f.call("PUT", PATH, { token: t, body: { links: { instagram: "@jane.example" }, version: 0 } });
      expect(f.ddb.all()).toEqual([]);
      return r;
    };
    const busy = await attempt("TransactionConflict");
    expect([busy.status, busy.body.error]).toEqual([503, "busy"]);
    const unavailable = await attempt("ThrottlingError");
    expect([unavailable.status, unavailable.body.error]).toEqual([503, "unavailable"]);
    const f = makeApi({ flags: { profileLinks: true } });
    const go = (links, version) => f.call("PUT", PATH, { token: t, body: { links, version } });
    expect((await go({ instagram: "@jane.example" }, 0)).status).toBe(200);
    const stale = await go({ tiktok: "@jane.example" }, 0);
    expect(typeof stale.body.details.current.updatedAt).toBe("string");
  });

  it("the routes are dark (404) without profileLinks, even for the owner", async () => {
    const dark = makeApi({ flags: { profileLinks: false } });
    expect((await dark.call("GET", PATH, { token: owner })).status).toBe(404);
    expect((await dark.call("PUT", PATH, { token: owner, body: { links: {}, version: 0 } })).status).toBe(404);
  });

  it("caps.json lists both routes gated by profileLinks and adds no MCP tool", () => {
    const caps = buildCaps();
    const acts = caps.actions.filter((a) => a.path.endsWith("/people/:id/links"));
    expect(acts.map((a) => `${a.method} ${a.name}`)).toEqual(["GET links.get", "PUT links.put"]);
    for (const a of acts) expect(a.gate).toEqual({ feature: "profileLinks" });
    expect(caps.mcp.tools.some((t) => /link/.test(t.name))).toBe(false);
  });
});

describe("errorResponse carries details", () => {
  it("an HttpError with details sends them; without, the body is unchanged", () => {
    expect(JSON.parse(errorResponse(new HttpError(422, "validation", "m", { fields: [{ field: "a", code: "x" }] })).body).details).toEqual({ fields: [{ field: "a", code: "x" }] });
    expect(JSON.parse(errorResponse(new HttpError(403, "forbidden", "m")).body)).toEqual({ error: "forbidden", message: "m" });
  });
});
