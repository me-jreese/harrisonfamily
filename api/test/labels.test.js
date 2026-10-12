// HFY-R68: author labels are never an email. They come from the site's own person record (person/<gramps_id>.json "displayName"), cached per container.
import { describe, expect, it, vi } from "vitest";
import { PERSON_KEY, cleanLabel, createLabelResolver, fallbackLabel, ownLabelOnly } from "../src/labels.js";
import { makeApi, signToken } from "./world.js";

const quiet = () => ({ warn: vi.fn(), error: vi.fn() });
const person = (displayName, extra = {}) => ({ grampsId: "I0044", displayName, givenName: "Jane", ...extra });
const s3Error = (name, status) => Object.assign(new Error(name), { name, $metadata: { httpStatusCode: status } });
/** A resolver over a fake person store with a hand-turned clock; `calls` records every fetched gramps_id. */
function setup(records = { I0044: person("Jane Harrison") }, opts = {}) {
  let t = 1_000_000;
  const calls = [];
  const log = quiet();
  const load = vi.fn(async (id) => {
    calls.push(id);
    const r = records[id];
    if (r instanceof Error) throw r;
    if (r === undefined) throw s3Error("NoSuchKey", 404);
    return r;
  });
  const resolve = createLabelResolver({ load, now: () => t, log, ...opts });
  return { resolve, load, calls, log, tick: (ms) => { t += ms; } };
}
const EMAIL_NAME = "jane@example.test"; // what the kit's resolver puts in the io_id `name` when the allowlist entry is a plain string

describe("label from the person record", () => {
  it("the S3 key is person/<gramps_id>.json", () => {
    expect(PERSON_KEY("I0044")).toBe("person/I0044.json");
  });
  it("an email-valued session name (plain-string allowlist entry) resolves to the person's displayName", async () => {
    const { resolve, calls } = setup();
    expect(await resolve({ sub: "I0044", name: EMAIL_NAME })).toBe("Jane Harrison");
    expect(calls).toEqual(["I0044"]);
  });
  it("no name at all resolves the same way; surrounding whitespace is trimmed", async () => {
    const { resolve } = setup({ I0044: person("  Jane Harrison \n") });
    expect(await resolve({ sub: "I0044" })).toBe("Jane Harrison");
  });
  it("a session name that is just the sub counts as no name", async () => {
    const { resolve, calls } = setup();
    expect(await resolve({ sub: "I0044", name: "I0044" })).toBe("Jane Harrison");
    expect(calls).toHaveLength(1);
  });
  it("an explicit non-email allowlist label wins and costs no lookup", async () => {
    const { resolve, calls } = setup();
    expect(await resolve({ sub: "I0044", name: "Janie H." })).toBe("Janie H.");
    expect(calls).toEqual([]);
  });
});

describe("falls back to the gramps_id", () => {
  it.each([
    ["no such record (NoSuchKey)", { I0044: undefined }],
    ["S3's 403 for a missing key (no s3:ListBucket)", { I0044: s3Error("AccessDenied", 403) }],
    ["a failed fetch", { I0044: s3Error("InternalError", 500) }],
    ["unparsable JSON", { I0044: new SyntaxError("Unexpected token") }],
    ["a record without displayName", { I0044: { grampsId: "I0044" } }],
    ["a non-string displayName", { I0044: person(42) }],
    ["an empty displayName", { I0044: person("   ") }],
    ["a null record", { I0044: null }],
    ["a displayName that is only the gramps_id", { I0044: person("I0044") }],
    ["a control character in displayName", { I0044: person("Jane\u0000 Harrison") }],
    ["an over-long displayName", { I0044: person("J".repeat(201)) }],
  ])("%s", async (_what, records) => {
    const { resolve } = setup(records);
    expect(await resolve({ sub: "I0044", name: EMAIL_NAME })).toBe("I0044");
  });
  it("a hung fetch times out instead of holding the request", async () => {
    const resolve = createLabelResolver({ load: () => new Promise(() => {}), timeoutMs: 20, log: quiet() });
    expect(await resolve({ sub: "I0044" })).toBe("I0044");
  });
  it("a load that throws synchronously, or a resolver call with no arguments, still answers", async () => {
    const resolve = createLabelResolver({ load: () => { throw new Error("sync"); }, log: quiet() });
    expect(await resolve({ sub: "I0044" })).toBe("I0044");
    expect(await resolve()).toBe("family member");
  });
  it("logs a failed fetch but not an absent record", async () => {
    const a = setup({ I0044: undefined });
    await a.resolve({ sub: "I0044" });
    expect(a.log.warn).not.toHaveBeenCalled();
    const b = setup({ I0044: s3Error("InternalError", 500) });
    await b.resolve({ sub: "I0044" });
    expect(b.log.warn).toHaveBeenCalledTimes(1);
  });
  it("never builds an S3 key from a sub that does not look like a gramps_id", async () => {
    const { resolve, calls } = setup();
    for (const sub of ["../config/userGrampsID", "I0044/../../x", "a b", "", undefined, 42, "x".repeat(65)]) await resolve({ sub, name: EMAIL_NAME });
    expect(calls).toEqual([]);
  });
});

describe("never an email", () => {
  it("rejects an email-shaped displayName in the person record", async () => {
    for (const dn of [EMAIL_NAME, "Jane <jane@example.test>", "jane@example.test (Jane)", "@jane"]) {
      const { resolve } = setup({ I0044: person(dn) });
      expect(await resolve({ sub: "I0044", name: EMAIL_NAME }), dn).toBe("I0044");
    }
  });
  it("rejects an email-shaped session name, with or without a person record", async () => {
    expect(await setup().resolve({ sub: "I0044", name: "ana@example.test" })).toBe("Jane Harrison");
    expect(await setup({}).resolve({ sub: "I0044", name: "ana@example.test" })).toBe("I0044");
    expect(await ownLabelOnly({ sub: "I0044", name: "ana@example.test" })).toBe("I0044");
  });
  it("even a sub that is email-shaped (a broken allowlist) is not used as a label", async () => {
    const { resolve, calls } = setup();
    expect(await resolve({ sub: "ana@example.test", name: "ana@example.test" })).toBe("family member");
    expect(calls).toEqual([]);
    expect(fallbackLabel("ana@example.test")).toBe("family member");
    expect(fallbackLabel("I0044")).toBe("I0044");
  });
  it("cleanLabel unit rules", () => {
    expect(cleanLabel("  Jane Harrison  ", "I0044")).toBe("Jane Harrison");
    expect([cleanLabel(undefined), cleanLabel(null), cleanLabel(""), cleanLabel("  "), cleanLabel(7), cleanLabel("a@b.test"), cleanLabel("x\ny"), cleanLabel("I0044", "I0044")]).toEqual(Array(8).fill(undefined));
  });
});

describe("cache", () => {
  it("serves a found label from memory for an hour, then fetches again", async () => {
    const { resolve, load, tick } = setup();
    for (let i = 0; i < 5; i++) expect(await resolve({ sub: "I0044", name: EMAIL_NAME })).toBe("Jane Harrison");
    expect(load).toHaveBeenCalledTimes(1);
    tick(3_599_000);
    await resolve({ sub: "I0044", name: EMAIL_NAME });
    expect(load).toHaveBeenCalledTimes(1);
    tick(2_000);
    await resolve({ sub: "I0044", name: EMAIL_NAME });
    expect(load).toHaveBeenCalledTimes(2);
  });
  it("a renamed person shows the new displayName after the TTL", async () => {
    const records = { I0044: person("Jane Harrison") };
    const { resolve, tick } = setup(records);
    expect(await resolve({ sub: "I0044" })).toBe("Jane Harrison");
    records.I0044 = person("Jane Harrison Smith");
    tick(3_600_001);
    expect(await resolve({ sub: "I0044" })).toBe("Jane Harrison Smith");
  });
  it("a miss is cached briefly (60 s), then retried; a record that appears later is picked up", async () => {
    const records = {};
    const { resolve, load, tick } = setup(records);
    expect(await resolve({ sub: "I0044" })).toBe("I0044");
    expect(await resolve({ sub: "I0044" })).toBe("I0044");
    expect(load).toHaveBeenCalledTimes(1);
    records.I0044 = person("Jane Harrison");
    tick(59_000);
    expect(await resolve({ sub: "I0044" })).toBe("I0044");
    tick(2_000);
    expect(await resolve({ sub: "I0044" })).toBe("Jane Harrison");
    expect(load).toHaveBeenCalledTimes(2);
  });
  it("a failed fetch is retried after 5 s, not an hour", async () => {
    const records = { I0044: s3Error("InternalError", 500) };
    const { resolve, load, tick } = setup(records);
    expect(await resolve({ sub: "I0044" })).toBe("I0044");
    expect(await resolve({ sub: "I0044" })).toBe("I0044");
    expect(load).toHaveBeenCalledTimes(1);
    records.I0044 = person("Jane Harrison");
    tick(5_001);
    expect(await resolve({ sub: "I0044" })).toBe("Jane Harrison");
  });
  it("when a refresh fails after a good label was cached, the old label keeps being served", async () => {
    const records = { I0044: person("Jane Harrison") };
    const { resolve, tick } = setup(records);
    await resolve({ sub: "I0044" });
    records.I0044 = s3Error("InternalError", 500);
    tick(3_600_001);
    expect(await resolve({ sub: "I0044" })).toBe("Jane Harrison");
  });
  it("members are cached independently, and concurrent lookups for one id share one fetch", async () => {
    const { resolve, calls } = setup({ I0044: person("Jane Harrison"), I0045: person("Sam Harrison") });
    const got = await Promise.all([resolve({ sub: "I0044" }), resolve({ sub: "I0044" }), resolve({ sub: "I0045" }), resolve({ sub: "I0045" })]);
    expect(got).toEqual(["Jane Harrison", "Jane Harrison", "Sam Harrison", "Sam Harrison"]);
    expect(calls.sort()).toEqual(["I0044", "I0045"]);
  });
  it("the cache is bounded", async () => {
    const records = Object.fromEntries(Array.from({ length: 6 }, (_, i) => [`I${i}`, person(`P${i}`)]));
    const { resolve, load } = setup(records, { maxEntries: 3 });
    for (let i = 0; i < 6; i++) await resolve({ sub: `I${i}` });
    await resolve({ sub: "I5" });
    expect(load).toHaveBeenCalledTimes(6);
  });
});

describe("HTTP principal (src/auth.js): author.label on comments and posts", () => {
  const records = { I0044: person("Jane Harrison") };
  const mk = (recs = records) => {
    const load = vi.fn(async (id) => { if (!recs[id]) throw s3Error("NoSuchKey", 404); return recs[id]; });
    const resolveLabel = createLabelResolver({ load, log: quiet() });
    return { load, w: makeApi({ resolveLabel }) };
  };
  it("a session whose name is the member's email is stored as the person's displayName, everywhere, and the email is stored nowhere", async () => {
    const { w, load } = mk();
    const tok = await signToken("I0044", { name: EMAIL_NAME });
    const c = await w.call("POST", "/api/comments", { token: tok, body: { subject: "person:I0001", body: "hi" } });
    expect(c.status).toBe(201);
    expect(c.body.author).toEqual({ id: "I0044", label: "Jane Harrison" });
    const p = await w.call("POST", "/api/posts", { token: tok, body: { body: "hello family" } });
    expect(p.status).toBe(201);
    expect(p.body.author).toMatchObject({ id: "I0044", label: "Jane Harrison" });
    const listed = await w.call("GET", "/api/comments", { token: await signToken("I0001"), query: { subject: "person:I0001" } });
    expect(listed.body.thread.comments.map((x) => x.author.label)).toEqual(["Jane Harrison"]);
    expect(JSON.stringify(w.ddb.all())).not.toContain(EMAIL_NAME);
    expect(load.mock.calls.map(([id]) => id).sort()).toEqual(["I0001", "I0044"]); // four requests, one fetch per member (the viewer I0001 has no record)
  });
  it("no person record: the gramps_id, never the email", async () => {
    const { w } = mk({});
    const c = await w.call("POST", "/api/comments", { token: await signToken("I0044", { name: EMAIL_NAME }), body: { subject: "person:I0001", body: "hi" } });
    expect(c.body.author).toEqual({ id: "I0044", label: "I0044" });
    expect(JSON.stringify(w.ddb.all())).not.toContain(EMAIL_NAME);
  });
  it("a resolver that throws never ends the session", async () => {
    const w = makeApi({ resolveLabel: async () => { throw new Error("boom"); } });
    const c = await w.call("POST", "/api/comments", { token: await signToken("I0044", { name: EMAIL_NAME }), body: { subject: "person:I0001", body: "hi" } });
    expect(c.status).toBe(201);
    expect(c.body.author).toEqual({ id: "I0044", label: "I0044" });
  });
  it("without a resolver (default) the session name is used unless it is an email", async () => {
    const w = makeApi();
    const named = await w.call("POST", "/api/comments", { token: await signToken("I0044", { name: "Jane H" }), body: { subject: "person:I0001", body: "a" } });
    expect(named.body.author.label).toBe("Jane H");
    const mailed = await w.call("POST", "/api/comments", { token: await signToken("I0044", { name: EMAIL_NAME }), body: { subject: "person:I0001", body: "b" } });
    expect(mailed.body.author.label).toBe("I0044");
  });
});
