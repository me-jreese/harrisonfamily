// HFY-TSK-254 (hfy-record-subs-api): record follows routes and the onRecordChanged fan-out rules. Synthetic ids and labels only.
import { beforeEach, describe, expect, it } from "vitest";
import { InMemoryNotificationStore } from "@io-kit/notify/server";
import { makeApi, signToken } from "./world.js";
import { buildCaps, ROUTES } from "../src/routes.js";
import { BATCH_DIGEST_OVER, DIGEST_OVER, createNotifier } from "../src/notify.js";
import { createPersonExists } from "../src/labels.js";

const ME = "I0001";
const KNOWN = ["I0002", "I0003", "I0004"];
const personExists = async (id) => KNOWN.includes(id) || id === ME;

describe("record follows routes", () => {
  let w, me;
  const put = (id, token = me) => w.call("PUT", `/api/subscriptions/person/${id}`, { token, body: {} });
  beforeEach(async () => {
    w = makeApi({ flags: { recordSubsV1: true }, extraDeps: { personExists } });
    me = await signToken(ME);
  });

  it("PUT writes RSUB#/REC#person:<id> with GSI1 RECSUB#person:<id>/<principal> and is idempotent", async () => {
    const a = await put("I0002");
    expect(a).toMatchObject({ status: 200, body: { subject: "person:I0002", subscribed: true } });
    const row = w.ddb.all().find((x) => x.PK === `RSUB#${ME}`);
    expect(row).toMatchObject({ SK: "REC#person:I0002", entity: "rsub", subject: "person:I0002", GSI1PK: "RECSUB#person:I0002", GSI1SK: ME });
    const first = row.created_at;
    expect((await put("I0002")).status).toBe(200);
    const rows = w.ddb.all().filter((x) => x.PK === `RSUB#${ME}`);
    expect(rows).toHaveLength(1);
    expect(rows[0].created_at).toBe(first);
  });

  it("PUT: 404 for an unknown person, 400 self_subscribe for your own page, 400 for a bad id, 503 when the lookup fails, 401 signed out", async () => {
    expect((await put("I9999")).status).toBe(404);
    const self = await put(ME);
    expect(self.status).toBe(400);
    expect(JSON.stringify(self.body)).toContain("self_subscribe");
    expect((await put("bad%20id")).status).toBe(400);
    expect(w.ddb.all().filter((x) => x.PK === `RSUB#${ME}`)).toHaveLength(0);
    const down = makeApi({ flags: { recordSubsV1: true }, extraDeps: { personExists: async () => { throw new Error("s3 down"); } } });
    expect((await down.call("PUT", "/api/subscriptions/person/I0002", { token: me, body: {} })).status).toBe(503);
    expect((await w.call("PUT", "/api/subscriptions/person/I0002", { body: {} })).status).toBe(401);
  });

  it("DELETE returns 204 and is idempotent; it removes only my follow", async () => {
    const other = await signToken("I0002");
    await put("I0003");
    await put("I0003", other);
    expect((await w.call("DELETE", "/api/subscriptions/person/I0003", { token: me })).status).toBe(204);
    expect((await w.call("DELETE", "/api/subscriptions/person/I0003", { token: me })).status).toBe(204);
    expect((await w.call("DELETE", "/api/subscriptions/person/I0004", { token: me })).status).toBe(204); // never followed
    expect(w.ddb.all().filter((x) => x.entity === "rsub").map((x) => x.PK)).toEqual(["RSUB#I0002"]);
  });

  it("GET ?subject= says whether I follow; a bad subject is 400", async () => {
    await put("I0002");
    expect((await w.call("GET", "/api/subscriptions", { token: me, query: { subject: "person:I0002" } })).body).toEqual({ subject: "person:I0002", subscribed: true });
    expect((await w.call("GET", "/api/subscriptions", { token: me, query: { subject: "person:I0003" } })).body).toEqual({ subject: "person:I0003", subscribed: false });
    for (const s of ["post:01J", "person:", "person:a b", ""]) expect((await w.call("GET", "/api/subscriptions", { token: me, query: { subject: s } })).status).toBe(400);
  });

  it("GET lists mine newest first with a cursor, and 400 cursor_invalid for a foreign cursor", async () => {
    for (const id of KNOWN) await put(id);
    await put("I0002", await signToken("I0003")); // someone else's follow stays out of my list
    const p1 = await w.call("GET", "/api/subscriptions", { token: me, query: { limit: "2" } });
    expect(p1.status).toBe(200);
    expect(p1.body.items.map((i) => i.subject)).toEqual(["person:I0004", "person:I0003"]);
    expect(Object.keys(p1.body.items[0]).sort()).toEqual(["created_at", "subject"]);
    expect(p1.body.cursor).toEqual(expect.any(String));
    const p2 = await w.call("GET", "/api/subscriptions", { token: me, query: { limit: "2", cursor: p1.body.cursor } });
    expect(p2.body).toMatchObject({ items: [{ subject: "person:I0002" }], cursor: null });
    const junk = await w.call("GET", "/api/subscriptions", { token: me, query: { cursor: Buffer.from("junk").toString("base64url") } });
    expect(junk.status).toBe(400);
    expect(JSON.stringify(junk.body)).toContain("cursor_invalid");
    expect((await w.call("GET", "/api/subscriptions", { token: me, query: { cursor: "!!" } })).status).toBe(400);
    expect((await w.call("GET", "/api/subscriptions", { token: me, query: { limit: "0" } })).status).toBe(400);
  });

  it("the routes are dark (404) without recordSubsV1", async () => {
    const dark = makeApi({ flags: { recordSubsV1: false }, extraDeps: { personExists } });
    expect((await dark.call("PUT", "/api/subscriptions/person/I0002", { token: me, body: {} })).status).toBe(404);
    expect((await dark.call("GET", "/api/subscriptions", { token: me })).status).toBe(404);
  });

  it("caps.json lists the four routes behind recordSubsV1, none is an MCP tool, and no route name ends in .delete", () => {
    const acts = buildCaps().actions.filter((a) => a.name.startsWith("subscriptions."));
    expect(acts.map((a) => `${a.method} ${a.name}`)).toEqual(["GET subscriptions.get", "GET subscriptions.list", "PUT subscriptions.put", "DELETE subscriptions.remove"]);
    for (const a of acts) expect(a.gate).toEqual({ feature: "recordSubsV1" });
    expect(buildCaps().mcp.tools.some((t) => /subscri/.test(t.name))).toBe(false);
    expect(ROUTES.filter((r) => r.name.startsWith("subscriptions.") && r.name.endsWith(".delete"))).toEqual([]);
  });
});

describe("createPersonExists", () => {
  it("absent keys are false, other failures throw, odd ids never reach the loader", async () => {
    let calls = 0;
    const mk = (fn) => createPersonExists({ load: async (id) => { calls += 1; return fn(id); } });
    expect(await mk(() => true)("I0002")).toBe(true);
    expect(await mk(() => { throw Object.assign(new Error("x"), { name: "NoSuchKey" }); })("I0002")).toBe(false);
    expect(await mk(() => { throw Object.assign(new Error("x"), { $metadata: { httpStatusCode: 403 } }); })("I0002")).toBe(false);
    await expect(mk(() => { throw Object.assign(new Error("x"), { $metadata: { httpStatusCode: 500 } }); })("I0002")).rejects.toThrow();
    const before = calls;
    expect(await mk(() => true)("../x")).toBe(false);
    expect(calls).toBe(before);
  });
});

describe("onRecordChanged fan-out rules", () => {
  const ch = (id, over = {}) => ({ subject: `person:${id}`, actor: { id: "A1", label: "Eve" }, source: "self_edit", ...over });
  const mk = ({ members = [], follows = {} } = {}) => {
    const inbox = new InMemoryNotificationStore();
    const notifier = createNotifier({ inbox, featureOn: async () => true, listMembers: async () => new Set(members), followersOf: async (s) => follows[s] ?? [], log: { error() {} } });
    return { inbox, notifier };
  };
  const items = async (inbox, p) => (await inbox.list(p)).items;
  const types = async (inbox, p) => (await items(inbox, p)).map((i) => i.type);

  it("the owner is notified only when a member and not the actor", async () => {
    const { inbox, notifier } = mk({ members: ["P5", "P6"] });
    await notifier.onRecordChanged([ch("P5"), ch("P6", { actor: { id: "P6", label: "Me" } }), ch("P7")]);
    expect(await types(inbox, "P5")).toEqual(["record_updated_mine"]);
    expect(await items(inbox, "P6")).toEqual([]);
    expect(await items(inbox, "P7")).toEqual([]);
  });

  it("followers get record_updated_followed grouped by rec:<subject>; more than 3 in a batch become one digest", async () => {
    const ids = ["P11", "P12", "P13", "P14"];
    const follows = Object.fromEntries(ids.map((i) => [`person:${i}`, ["F1"]]));
    follows["person:P11"] = ["F1", "F2"];
    const { inbox, notifier } = mk({ follows });
    await notifier.onRecordChanged(ids.map((i) => ch(i)));
    expect(await types(inbox, "F1")).toEqual(["records_updated_followed_digest"]);
    expect(await types(inbox, "F2")).toEqual(["record_updated_followed"]);
    expect((await items(inbox, "F2"))[0].group).toBe("rec:person:P11");
    const few = mk({ follows });
    await few.notifier.onRecordChanged(ids.slice(0, DIGEST_OVER).map((i) => ch(i)));
    expect((await items(few.inbox, "F1")).map((i) => i.group).sort()).toEqual(["rec:person:P11", "rec:person:P12", "rec:person:P13"]);
    await few.notifier.onRecordChanged([ch("P11")]); // a repeat update coalesces onto the same group
    expect(await items(few.inbox, "F1")).toHaveLength(3);
    expect((await items(few.inbox, "F2"))[0].count).toBe(2);
  });

  it("silent:true, import:true and seed:true send nothing and read no followers", async () => {
    for (const opts of [{ silent: true }, { import: true }, { seed: true }]) {
      let reads = 0;
      const inbox = new InMemoryNotificationStore();
      const n = createNotifier({ inbox, featureOn: async () => true, listMembers: async () => new Set(["P5"]), followersOf: async () => { reads += 1; return ["F1"]; }, log: { error() {} } });
      await n.onRecordChanged([ch("P5")], opts);
      expect(reads).toBe(0);
      expect([...(await items(inbox, "P5")), ...(await items(inbox, "F1"))]).toEqual([]);
    }
  });

  it(`a non-silent batch of more than ${BATCH_DIGEST_OVER} subjects degrades to one digest per recipient plus one record_updated_mine per owner`, async () => {
    const ids = Array.from({ length: BATCH_DIGEST_OVER + 1 }, (_, i) => `P${100 + i}`);
    const follows = {};
    for (const [i, id] of ids.entries()) follows[`person:${id}`] = i === 0 ? ["F1", "F2"] : ["F1"]; // F2 follows a single page
    const { inbox, notifier } = mk({ members: ["P100", "P101", "P102"], follows });
    await notifier.onRecordChanged(ids.map((i) => ch(i)));
    expect(await types(inbox, "F1")).toEqual(["records_updated_followed_digest"]);
    expect((await items(inbox, "F1"))[0].count).toBe(1);
    expect(await types(inbox, "F2")).toEqual(["records_updated_followed_digest"]); // a lone page also digests in bulk
    for (const o of ["P100", "P101", "P102"]) expect(await types(inbox, o)).toEqual(["record_updated_mine"]);
    // exactly BATCH_DIGEST_OVER subjects is not bulk: F2's single page arrives as itself
    const edge = mk({ follows });
    await edge.notifier.onRecordChanged(ids.slice(0, BATCH_DIGEST_OVER).map((i) => ch(i)));
    expect(await types(edge.inbox, "F2")).toEqual(["record_updated_followed"]);
  });

  it("bulk: an owner who also follows other changed pages gets one record_updated_mine and one digest, never the owner twice for their own page", async () => {
    const ids = Array.from({ length: BATCH_DIGEST_OVER + 1 }, (_, i) => `P${200 + i}`);
    const follows = {};
    for (const id of ids) follows[`person:${id}`] = ["P200", "F1"]; // P200 owns the first page and follows every page, its own included
    const { inbox, notifier } = mk({ members: ["P200"], follows });
    await notifier.onRecordChanged(ids.map((i) => ch(i)));
    expect((await types(inbox, "P200")).sort()).toEqual(["record_updated_mine", "records_updated_followed_digest"]);
    const digest = (await items(inbox, "P200")).find((x) => x.type === "records_updated_followed_digest");
    expect(digest.count).toBe(1); // one grouped digest row, as in the follower case above
    expect(await types(inbox, "F1")).toEqual(["records_updated_followed_digest"]);
  });

  it("a batch beyond the old 500-subject lookup bound still notifies its owners", async () => {
    const { inbox, notifier } = mk({ members: ["P900"] });
    const many = Array.from({ length: 600 }, (_, i) => ch(`P${i + 400}`));
    await notifier.onRecordChanged(many);
    expect((await items(inbox, "P900"))).toHaveLength(1);
  });
});
