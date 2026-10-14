// HFY-TSK-134: the ALLOW# store. Grant and revoke transaction items (conditional, audited, ALLOWSUB# on GSI1), and the composite member
// reader that membership.js and any later allowlist consumer share. Synthetic data only.
import { describe, it, expect } from "vitest";
import { createFakeDdb, cmds } from "./world.js";
import { TxnCancelled, transact } from "../src/txn.js";
import {
  ALLOW_SOURCES, allowItem, createCompositeMemberReader, emailHash, grantAllow, grantItems, isActiveAllowItem, listAllowBySub, readAllowEntry, revokeAllow, revokeItems,
} from "../src/allowlist-store.js";
import * as shared from "../src/shared/allowlist-store.mjs";

const T = "hfy-app";
const AT = "2026-03-04T05:06:07.000Z";
const quiet = { error() {} };
const grant = { email: "New.Member@Example.com", sub: "I0555", source: "access-request", requestId: "req-1", at: AT, by: "I9000", uid: "u1", table: T };
const item = (ddb, email) => ddb.rows.get(`ALLOW#${email}\u0000META`);
const audits = (ddb) => ddb.all().filter((r) => r.PK.startsWith("AUDIT#allow:"));

describe("allowItem and grantItems", () => {
  it("builds ALLOW#<normalized email> / META with GSI1PK ALLOWSUB#<sub> and GSI1SK ALLOW#<email>", () => {
    expect(allowItem(grant)).toEqual({
      PK: "ALLOW#new.member@example.com", SK: "META", GSI1PK: "ALLOWSUB#I0555", GSI1SK: "ALLOW#new.member@example.com", entity: "allow",
      sub: "I0555", state: "active", source: "access-request", requestId: "req-1", at: AT, by: "I9000",
    });
    expect("requestId" in allowItem({ ...grant, requestId: undefined })).toBe(false);
  });
  it("makes a conditional Put (no item, or a revoked one) and an audit Put, both in the transact() shape", () => {
    const { puts } = grantItems(grant);
    expect(puts).toHaveLength(2);
    expect(puts[0]).toMatchObject({
      condition: "attribute_not_exists(PK) OR #state = :revoked", names: { "#state": "state" }, values: { ":revoked": "revoked" }, tag: "allow.grant",
    });
    expect(puts[0].item.PK).toBe("ALLOW#new.member@example.com");
    expect(puts[1].item).toMatchObject({ PK: `AUDIT#allow:${emailHash("new.member@example.com")}`, entity: "audit", op: "allow.grant", principal: "I9000", at: AT, before: null, after: { sub: "I0555", state: "active", source: "access-request" } });
  });
  it("rejects a bad source, address, sub or actor", () => {
    expect(ALLOW_SOURCES).toEqual(["access-request", "admin", "import"]);
    expect(() => allowItem({ ...grant, source: "form" })).toThrow(/source/);
    for (const email of ["", "nobody", "a b@example.com", `${"x".repeat(250)}@example.com`]) expect(() => allowItem({ ...grant, email })).toThrow(/email/);
    expect(() => allowItem({ ...grant, sub: "" })).toThrow(/sub/);
    expect(() => allowItem({ ...grant, by: undefined })).toThrow(/by/);
    expect(() => allowItem({ ...grant, at: "" })).toThrow(/at/);
  });
  it("hashes the normalized address, so spellings share one audit trail", () => {
    expect(emailHash(" A@Example.com ")).toBe(emailHash("a@example.com"));
    expect(emailHash("a@example.com")).toMatch(/^[0-9a-f]{64}$/);
  });
});

describe("grantAllow", () => {
  it("writes the item and its audit atomically; the audit holds the sub and the hash, never the address", async () => {
    const ddb = createFakeDdb();
    await grantAllow(ddb, cmds, T, grant);
    expect(item(ddb, "new.member@example.com")).toMatchObject({ sub: "I0555", state: "active", GSI1PK: "ALLOWSUB#I0555" });
    const [a] = audits(ddb);
    expect(a.op).toBe("allow.grant");
    expect(JSON.stringify(ddb.all().filter((r) => r.PK.startsWith("AUDIT#")))).not.toMatch(/example\.com/);
  });
  it("refuses a second grant while the item is active (nothing is written, the failure is tagged)", async () => {
    const ddb = createFakeDdb();
    await grantAllow(ddb, cmds, T, grant);
    const before = ddb.all();
    const e = await grantAllow(ddb, cmds, T, { ...grant, sub: "I0777", uid: "u2" }).catch((x) => x);
    expect(e).toBeInstanceOf(TxnCancelled);
    expect(e.conditionFailed).toBe(true);
    expect(e.failures[0]).toMatchObject({ index: 0, code: "ConditionalCheckFailed", tag: "allow.grant" });
    expect(ddb.all()).toEqual(before);
  });
  it("re-grants a revoked email, replacing the item and adding an audit", async () => {
    const ddb = createFakeDdb();
    await grantAllow(ddb, cmds, T, grant);
    await revokeAllow(ddb, cmds, T, { email: grant.email, sub: "I0555", at: AT, by: "I9000", uid: "u2" });
    await grantAllow(ddb, cmds, T, { ...grant, sub: "I0556", source: "admin", uid: "u3", requestId: undefined });
    const it_ = item(ddb, "new.member@example.com");
    expect(it_).toMatchObject({ sub: "I0556", state: "active", source: "admin", GSI1PK: "ALLOWSUB#I0556" });
    expect(it_.revokedAt).toBeUndefined();
    expect(audits(ddb).map((a) => a.op).sort()).toEqual(["allow.grant", "allow.grant", "allow.revoke"]);
  });
  it("composes with a caller's own items in one transaction: a failed grant rolls the others back", async () => {
    const ddb = createFakeDdb();
    await grantAllow(ddb, cmds, T, grant);
    const frag = grantItems({ ...grant, uid: "u9" });
    const e = await transact(ddb, cmds, T, { puts: [...frag.puts, { item: { PK: "ACCESSREQ#r1", SK: "META", state: "active" } }] }).catch((x) => x);
    expect(e.conditionFailed).toBe(true);
    expect(ddb.rows.has("ACCESSREQ#r1\u0000META")).toBe(false);
  });
});

describe("revokeAllow", () => {
  it("sets state revoked and keeps the keys, so the revoke still overrides the S3 file; adds an audit", async () => {
    const ddb = createFakeDdb();
    await grantAllow(ddb, cmds, T, grant);
    await revokeAllow(ddb, cmds, T, { email: "NEW.member@example.com", sub: "I0555", at: AT, by: "I9001", reason: "asked", uid: "u2" });
    expect(item(ddb, "new.member@example.com")).toMatchObject({ state: "revoked", sub: "I0555", GSI1PK: "ALLOWSUB#I0555", revokedAt: AT, revokedBy: "I9001" });
    expect(audits(ddb).find((a) => a.op === "allow.revoke")).toMatchObject({ principal: "I9001", before: { sub: "I0555", state: "active" }, after: { sub: "I0555", state: "revoked" }, reason: "asked" });
  });
  it("fails (ConditionalCheckFailed, tagged) for an absent item, a revoked item or another sub", async () => {
    const ddb = createFakeDdb();
    const rv = (o = {}) => revokeAllow(ddb, cmds, T, { email: grant.email, sub: "I0555", at: AT, by: "I9000", uid: "ux", ...o }).catch((x) => x);
    const absent = await rv();
    expect(absent.conditionFailed).toBe(true);
    expect(absent.failures[0].tag).toBe("allow.revoke");
    await grantAllow(ddb, cmds, T, grant);
    expect((await rv({ sub: "I0777" })).conditionFailed).toBe(true);
    await rv({ uid: "u2" });
    expect((await rv({ uid: "u3" })).conditionFailed).toBe(true);
    expect(audits(ddb).filter((a) => a.op === "allow.revoke")).toHaveLength(1);
  });
  it("builds an Update item plus an audit Put", () => {
    const f = revokeItems({ email: grant.email, sub: "I0555", at: AT, by: "I9000", uid: "u", table: T });
    expect(f.updates).toHaveLength(1);
    expect(f.updates[0].key).toEqual({ PK: "ALLOW#new.member@example.com", SK: "META" });
    expect(f.updates[0].condition).toBe("attribute_exists(PK) AND #state = :active AND #sub = :sub");
    expect(f.puts[0].item.op).toBe("allow.revoke");
    expect(() => revokeItems({ email: grant.email, at: AT, by: "I9000" })).toThrow(/sub/);
  });
});

describe("reads", () => {
  it("readAllowEntry returns the item or undefined; listAllowBySub returns active and revoked items of one sub", async () => {
    const ddb = createFakeDdb();
    await grantAllow(ddb, cmds, T, grant);
    await grantAllow(ddb, cmds, T, { ...grant, email: "second@example.com", uid: "u2" });
    await revokeAllow(ddb, cmds, T, { email: "second@example.com", sub: "I0555", at: AT, by: "I9000", uid: "u3" });
    await grantAllow(ddb, cmds, T, { ...grant, email: "other@example.com", sub: "I0600", uid: "u4" });
    expect(await readAllowEntry(ddb, cmds, T, " NEW.member@Example.com")).toMatchObject({ sub: "I0555" });
    expect(await readAllowEntry(ddb, cmds, T, "ghost@example.com")).toBeUndefined();
    const list = await listAllowBySub(ddb, cmds, T, "I0555");
    expect(list.map((i) => `${i.PK}:${i.state}`).sort()).toEqual(["ALLOW#new.member@example.com:active", "ALLOW#second@example.com:revoked"]);
    expect(list.every((i) => i.entity === "allow")).toBe(true);
    expect(list.filter(isActiveAllowItem)).toHaveLength(1);
  });
  it("pages through GSI1 until the sub's partition is exhausted", async () => {
    const pages = [{ Items: [{ PK: "ALLOW#a@x.org", SK: "META", state: "active", sub: "I1" }], LastEvaluatedKey: { PK: "k" } }, { Items: [{ PK: "ALLOW#b@x.org", SK: "META", state: "revoked", sub: "I1" }] }];
    const seen = [];
    const ddb = { send: async (c) => { seen.push(c.input.ExclusiveStartKey); return pages.shift(); } };
    expect((await listAllowBySub(ddb, cmds, T, "I1")).map((i) => i.PK)).toEqual(["ALLOW#a@x.org", "ALLOW#b@x.org"]);
    expect(seen).toEqual([undefined, { PK: "k" }]);
  });
});

describe("the composite member reader (against the store's real items)", () => {
  const file = new Map([
    ["ana@example.com", { sub: "I0111", roles: ["member"] }],
    ["bo@example.com", { sub: "I0222", roles: ["member", "editors"] }],
  ]);
  const reader = (ddb, o = {}) => createCompositeMemberReader({ readEntries: async () => file, ddb, cmds, table: T, log: quiet, ...o });

  it("is exported from allowlist-store.js and is the same code the auth edge runs", () => {
    expect(createCompositeMemberReader).toBe(shared.createCompositeMemberReader);
  });
  it("S3 only: members keep their roles; strangers are null", async () => {
    const r = reader(createFakeDdb());
    expect(await r("I0111")).toEqual({ roles: [] });
    expect(await r("I0222")).toEqual({ roles: ["editors"] });
    expect(await r("I0999")).toBeNull();
  });
  it("a granted item admits a principal that is in no file", async () => {
    const ddb = createFakeDdb();
    await grantAllow(ddb, cmds, T, grant);
    expect(await reader(ddb)("I0555")).toEqual({ roles: [] });
  });
  it("a revoked item removes a principal the file lists; a re-grant restores it", async () => {
    const ddb = createFakeDdb();
    await grantAllow(ddb, cmds, T, { ...grant, email: "ana@example.com", sub: "I0111" });
    await revokeAllow(ddb, cmds, T, { email: "ana@example.com", sub: "I0111", at: AT, by: "I9000", uid: "u2" });
    expect(await reader(ddb, { ttlMs: 0 })("I0111")).toBeNull();
    await grantAllow(ddb, cmds, T, { ...grant, email: "ana@example.com", sub: "I0111", uid: "u3" });
    expect(await reader(ddb, { ttlMs: 0 })("I0111")).toEqual({ roles: [] });
  });
  it("a DDB failure falls back to the file", async () => {
    const down = { send: async () => { throw Object.assign(new Error("boom"), { name: "InternalServerError" }); } };
    const r = reader(down);
    expect(await r("I0222")).toEqual({ roles: ["editors"] });
    expect(await r("I0999")).toBeNull();
  });
});
