// HFY-TSK-256 (hfy-contrib-read-api): contributions.list, contributions.stats and contributions.site, pickLine and the LINE cache.
// Synthetic ids and data only.
import { describe, expect, it } from "vitest";
import { CANDIDATES, LINE_TTL_MS, createContribReader, hrefOf, lineText, pickLine, proposalVisible } from "../src/contrib-read.js";
import { buildEvent, contribOps, hideOps } from "../src/contrib.js";
import { ROUTES, buildCaps, matchRoute } from "../src/routes.js";
import { transact } from "../src/txn.js";
import { TABLE, cmds, makeApi, signToken } from "./world.js";

// ---------------------------------------------------------------------------------------------------------------------------------
// pickLine: the golden table
// ---------------------------------------------------------------------------------------------------------------------------------

const TODAY = "2026-03-14";
const DAY = 86_400_000;
const dayAgo = (n, from = TODAY) => new Date(Date.parse(`${from}T00:00:00Z`) - n * DAY).toISOString().slice(0, 10);
/** Day buckets from {daysAgo: n}. */
const days = (o) => Object.fromEntries(Object.entries(o).map(([k, v]) => [dayAgo(Number(k)), v]));
const OLD = "2025-01-01T00:00:00.000Z"; // 437 days before TODAY: every window up to 365 days is eligible
const ago = (n) => `${dayAgo(n)}T08:00:00.000Z`;

const GOLDEN = [
  { name: "empty site: no history, no buckets", buckets: {}, firstAt: undefined, want: null },
  { name: "empty buckets on an old site", buckets: {}, firstAt: OLD, want: null },
  { name: "burst: 12 in the last 3 days is hot at 3 days", buckets: days({ 0: 2, 1: 2, 2: 8 }), firstAt: OLD, want: { x: 12, y: 3, unit: "day", window_days: 3, text: "12 contributions in the past 3 days" } },
  { name: "trickle: one every 3 days is hot at 2 weeks (5 against 5)", buckets: days(Object.fromEntries(Array.from({ length: 30 }, (_, i) => [i * 3, 1]))), firstAt: OLD, want: { x: 5, y: 2, unit: "week", window_days: 14, text: "5 contributions in the past 2 weeks" } },
  { name: "falling: busy before, quiet now, falls back to volume (6 days)", buckets: days({ 5: 3, 9: 3, 15: 10, 22: 10, 35: 10, 40: 10, 45: 10 }), firstAt: OLD, want: { x: 3, y: 6, unit: "day", window_days: 6, text: "3 contributions in the past 6 days" } },
  { name: "rising: quiet before, busier now, hot at 2 weeks", buckets: days({ 0: 2, 1: 2, 8: 1 }), firstAt: OLD, want: { x: 5, y: 2, unit: "week", window_days: 14, text: "5 contributions in the past 2 weeks" } },
  { name: "young site: three days of history, hot at 2 days", buckets: days({ 0: 4, 1: 3, 2: 3 }), firstAt: ago(2), want: { x: 7, y: 2, unit: "day", window_days: 2, text: "7 contributions in the past 2 days" } },
  { name: "young site never claims a window longer than its history", buckets: days({ 0: 1, 5: 1, 9: 1 }), firstAt: ago(9), want: null },
  { name: "year boundary: 364 days of history cannot claim the past year", buckets: days({ 100: 1, 200: 1, 300: 1 }), firstAt: ago(363), want: null },
  { name: "year boundary: 365 days of history can", buckets: days({ 100: 1, 200: 1, 300: 1 }), firstAt: ago(364), want: { x: 3, y: 1, unit: "year", window_days: 365, text: "3 contributions in the past year" } },
  { name: "year boundary: past 365 days the line sums month buckets (2 years)", buckets: { "2025-06": 1, "2025-11": 1, "2026-02": 1, "2024-02": 5 }, firstAt: "2024-01-01T00:00:00.000Z", want: { x: 3, y: 2, unit: "year", window_days: 730, text: "3 contributions in the past 2 years" } },
  { name: "negative bucket clamps to 0 (a revoke past a day row's ttl)", buckets: days({ 0: -2, 1: 3, 2: 3, 3: 4 }), firstAt: OLD, want: { x: 6, y: 3, unit: "day", window_days: 3, text: "6 contributions in the past 3 days" } },
  { name: "a non-numeric bucket counts as 0", buckets: { ...days({ 1: 3 }), [dayAgo(0)]: "9", [dayAgo(2)]: Number.NaN }, firstAt: OLD, want: { x: 3, y: 2, unit: "day", window_days: 2, text: "3 contributions in the past 2 days" } },
  { name: "a quiet month is a month", buckets: days({ 25: 3 }), firstAt: OLD, want: { x: 3, y: 1, unit: "month", window_days: 30, text: "3 contributions in the past month" } },
  { name: "a quieter site gets a longer true window (2 months)", buckets: days({ 45: 3 }), firstAt: OLD, want: { x: 3, y: 2, unit: "month", window_days: 60, text: "3 contributions in the past 2 months" } },
  { name: "two contributions are never a line", buckets: days({ 0: 1, 40: 1 }), firstAt: OLD, want: null },
  { name: "no first_at is no claim", buckets: days({ 0: 9 }), firstAt: undefined, want: null },
  // Dwell hysteresis: a pick cached earlier today is kept within one candidate step while it stays valid.
  { name: "dwell: the cached 7-day window is kept against a fresh 6-day pick (one step)", buckets: days({ 0: 1, 1: 1, 5: 1 }), firstAt: OLD, prev: { window_days: 7, day: TODAY }, want: { x: 3, y: 1, unit: "week", window_days: 7, text: "3 contributions in the past week" } },
  { name: "dwell: the kept window shows its current count", buckets: days({ 0: 1, 1: 1, 5: 1, 6: 1 }), firstAt: OLD, prev: { window_days: 7, day: TODAY }, want: { x: 4, y: 1, unit: "week", window_days: 7, text: "4 contributions in the past week" } },
  { name: "dwell: two steps away moves to the fresh pick", buckets: days({ 0: 1, 1: 1, 5: 1 }), firstAt: OLD, prev: { window_days: 14, day: TODAY }, want: { x: 3, y: 6, unit: "day", window_days: 6, text: "3 contributions in the past 6 days" } },
  { name: "dwell: a cached window that fell below 3 is dropped", buckets: days({ 1: 1, 2: 1, 3: 1 }), firstAt: OLD, prev: { window_days: 3, day: TODAY }, want: { x: 3, y: 4, unit: "day", window_days: 4, text: "3 contributions in the past 4 days" } },
  { name: "dwell: yesterday's pick is not kept", buckets: days({ 0: 1, 1: 1, 5: 1 }), firstAt: OLD, prev: { window_days: 7, day: dayAgo(1) }, want: { x: 3, y: 6, unit: "day", window_days: 6, text: "3 contributions in the past 6 days" } },
  { name: "dwell: a cached window longer than the history is not kept", buckets: days({ 0: 3 }), firstAt: ago(3), prev: { window_days: 7, day: TODAY }, want: { x: 3, y: 1, unit: "day", window_days: 1, text: "3 contributions in the past day" } },
];

describe("pickLine golden table (AC1)", () => {
  it("has at least 12 cases covering the named situations", () => {
    expect(GOLDEN.length).toBeGreaterThanOrEqual(12);
    const names = GOLDEN.map((g) => g.name).join("|");
    for (const word of ["empty", "burst", "trickle", "falling", "rising", "young", "negative", "dwell", "year boundary"]) expect(names, word).toContain(word);
  });
  for (const g of GOLDEN) {
    it(g.name, () => {
      expect(pickLine(g.buckets, TODAY, g.firstAt, g.prev)).toEqual(g.want);
    });
  }
});

describe("pickLine rules", () => {
  it("never produces a line for fewer than 3, and the copy is singular for one unit", () => {
    for (let n = 0; n < 3; n += 1) expect(pickLine(days({ 0: n }), TODAY, OLD)).toBeNull();
    expect(lineText(1, 1, "day")).toBe("1 contribution in the past day");
    expect(lineText(4, 1, "week")).toBe("4 contributions in the past week");
    expect(lineText(9, 3, "month")).toBe("9 contributions in the past 3 months");
  });

  it("the candidates run 1-6 days, weeks, months, then years", () => {
    expect(CANDIDATES.map((c) => c.days).slice(0, 13)).toEqual([1, 2, 3, 4, 5, 6, 7, 14, 21, 30, 60, 90, 180]);
    expect(CANDIDATES.slice(13, 16).map((c) => [c.days, c.y, c.unit])).toEqual([[365, 1, "year"], [730, 2, "year"], [1095, 3, "year"]]);
    expect(CANDIDATES.slice(0, 6).every((c) => c.unit === "day")).toBe(true);
    expect(CANDIDATES.slice(6, 9).map((c) => [c.y, c.unit])).toEqual([[1, "week"], [2, "week"], [3, "week"]]);
    expect(CANDIDATES.slice(9, 13).map((c) => [c.y, c.unit])).toEqual([[1, "month"], [2, "month"], [3, "month"], [6, "month"]]);
  });

  it("hot is limited to 30 days: a flat 5 in 60 days is volume, not hot", () => {
    // 5 events spread over 40..59 days ago: no window of 30 days or fewer holds 5, so volume picks the shortest window with 3 (60 days).
    const out = pickLine(days({ 40: 1, 45: 1, 50: 1, 55: 1, 59: 1 }), TODAY, OLD);
    expect(out).toMatchObject({ window_days: 60, x: 5 });
  });

  it("is pure: it does not touch its inputs and gives the same answer twice", () => {
    const b = days({ 0: 2, 1: 2, 2: 8 });
    const snap = structuredClone(b);
    expect(pickLine(b, TODAY, OLD)).toEqual(pickLine(b, TODAY, OLD));
    expect(b).toEqual(snap);
  });

  it("answers null for a bad day or first_at", () => {
    expect(pickLine(days({ 0: 9 }), "not a day", OLD)).toBeNull();
    expect(pickLine(days({ 0: 9 }), TODAY, "garbage")).toBeNull();
    expect(pickLine(days({ 0: 9 }), TODAY, "2027-01-01T00:00:00.000Z")).toBeNull(); // first contribution in the future
  });
});

// ---------------------------------------------------------------------------------------------------------------------------------
// The routes
// ---------------------------------------------------------------------------------------------------------------------------------

const U = (n) => `01J${String(n).padStart(23, "0")}`; // a 26-character ULID
const ANN = "I0001";
const BEN = "I0002";
const CAL = "I0003";
const ADMIN = "I0099";
const PAGE = "I0010";
const AT = "2026-03-14T10:00:00.000Z";
const tokens = {};
const tok = async (id) => (tokens[id] ??= await signToken(id, { name: `member ${id}` }));
const get = async (w, who, path, query) => w.call("GET", `/api/${path}`, { token: await tok(who), ...(query ? { query } : {}), ct: undefined });
const world = (opts = {}) => makeApi({ admins: [ADMIN], flags: { contribV1: true }, ...opts });
const put = (w, item) => w.ddb.send(new cmds.PutCommand({ TableName: TABLE, Item: item }));
/** Writes a synthetic event straight into the ledger (no counters). */
const seed = async (w, args) => {
  const event = buildEvent({ at: AT, via: "ui", ...args });
  await put(w, event);
  return event;
};
const withComment = (n, over = {}) => ({ actor: { id: ANN, label: "Ann" }, kind: "comment", ref: { type: "comment", id: U(n), thread: `person:${PAGE}` }, subject: `person:${PAGE}`, id: U(n), ...over });

describe("gate and shape", () => {
  it("the three routes are dark (404, signed in or out) until contribV1 is on", async () => {
    const w = makeApi({ admins: [ADMIN], flags: { contribV1: false } });
    for (const [path, query] of [["contributions", { author: ANN }], ["contributions/stats", { author: ANN }], ["contributions/stats", undefined]]) {
      expect((await get(w, BEN, path, query)).status, path).toBe(404);
      expect((await w.call("GET", `/api/${path}`, { ct: undefined, ...(query ? { query } : {}) })).status, `${path} signed out`).toBe(404);
    }
  });

  it("a uat member reaches them while the flag is off; once on they need a session", async () => {
    const dark = makeApi({ flags: { contribV1: false }, uat: [BEN] });
    expect((await get(dark, BEN, "contributions", { author: ANN })).status).toBe(200);
    expect((await get(dark, CAL, "contributions", { author: ANN })).status).toBe(404);
    const on = world();
    expect((await on.call("GET", "/api/contributions", { ct: undefined, query: { author: ANN } })).status).toBe(401);
  });

  it("caps.json lists the three routes with the contribV1 gate, and no MCP tool", () => {
    const actions = buildCaps().actions.filter((a) => a.name.startsWith("contributions."));
    expect(actions.map((a) => [a.name, a.method, a.path, a.gate])).toEqual([
      ["contributions.list", "GET", "/api/contributions", { feature: "contribV1" }],
      ["contributions.stats", "GET", "/api/contributions/stats", { feature: "contribV1" }],
      ["contributions.site", "GET", "/api/contributions/stats", { feature: "contribV1" }],
    ]);
    expect(ROUTES.filter((r) => r.name.startsWith("contributions.")).some((r) => r.mcp)).toBe(false);
  });

  it("?author= picks stats, its absence picks site; another method is 405", async () => {
    expect(matchRoute("GET", "/contributions/stats", ROUTES, { author: ANN }).route.name).toBe("contributions.stats");
    expect(matchRoute("GET", "/contributions/stats", ROUTES, {}).route.name).toBe("contributions.site");
    expect(matchRoute("GET", "/contributions/stats", ROUTES, { author: "" }).route.name).toBe("contributions.site");
    const w = world();
    expect((await get(w, BEN, "contributions/stats", { author: ANN })).body).toMatchObject({ author: ANN });
    expect((await get(w, BEN, "contributions/stats")).body).toHaveProperty("total");
    expect((await w.call("POST", "/api/contributions", { token: await tok(BEN), body: {} })).status).toBe(405);
  });

  it("validates author, limit and cursor", async () => {
    const w = world();
    const bad = async (query) => get(w, BEN, "contributions", query);
    expect((await bad(undefined)).status).toBe(400);
    expect((await bad({ author: "" })).status).toBe(400);
    expect((await bad({ author: "I0001#x" })).status).toBe(400);
    for (const limit of ["0", "51", "abc", "2.5", "-1"]) expect((await bad({ author: ANN, limit })).status, limit).toBe(400);
    expect((await bad({ author: ANN, limit: "50" })).status).toBe(200);
    const c = await bad({ author: ANN, cursor: "not-a-cursor!" });
    expect([c.status, c.body.error]).toEqual([400, "cursor_invalid"]);
    expect((await bad({ author: ANN, cursor: Buffer.from("CAP#x").toString("base64url") })).body.error).toBe("cursor_invalid");
  });
});

describe("contributions.list: href for each ref type (AC3)", () => {
  it("computes a link for a post, a comment (person, post and proposal threads), a proposal, a record, a tag and a photo", async () => {
    const w = world();
    const P = U(500);
    await put(w, { PK: `POST#${P}`, SK: "META", post: { id: P, visibility: "published", author: { id: ANN, label: "Ann" }, body: "hi" } });
    await put(w, { PK: `PROP#${U(600)}`, SK: "META", proposal: { id: U(600), proposer: { id: ANN }, subject: { gramps_id: PAGE } } });
    const rows = [
      ["post", { kind: "post", ref: { type: "post", id: P }, subject: PAGE, id: U(1) }, `/posts/?id=${P}`],
      ["comment on a person", withComment(2), `/person/?id=${PAGE}#comment-${U(2)}`],
      ["comment on a post", withComment(3, { ref: { type: "comment", id: U(3), thread: `post:${P}` }, subject: `post:${P}` }), `/posts/?id=${P}#comment-${U(3)}`],
      ["comment on a proposal", withComment(4, { ref: { type: "comment", id: U(4), thread: `proposal:${U(600)}` }, subject: `proposal:${U(600)}` }), `/person/?id=${PAGE}#comment-${U(4)}`],
      ["proposal", { kind: "proposal_accepted", ref: { type: "proposal", id: U(600) }, subject: `person:${PAGE}`, id: U(5) }, `/person/?id=${PAGE}`],
      ["record", { kind: "self_edit", ref: { type: "record", id: PAGE }, subject: PAGE, id: U(6) }, `/person/?id=${PAGE}`],
      ["tag", { kind: "tag", ref: { type: "tag", id: "t1" }, subject: `person:${PAGE}`, id: U(7) }, `/person/?id=${PAGE}`],
      ["media", { kind: "photo_to_record", ref: { type: "media", id: "m1" }, subject: `person:${PAGE}`, id: U(8) }, `/person/?id=${PAGE}#photos`],
    ];
    for (const [, args] of rows) await seed(w, { actor: { id: ANN, label: "Ann" }, ...args });
    const r = await get(w, ADMIN, "contributions", { author: ANN, limit: "20" });
    expect(r.status).toBe(200);
    const byId = Object.fromEntries(r.body.items.map((i) => [i.id, i]));
    for (const [name, args, href] of rows) expect(byId[args.id]?.href, name).toBe(href);
    expect(r.body.items.map((i) => i.id)).toEqual(rows.map(([, a]) => a.id).reverse()); // newest first
  });

  it("returns the documented fields and nothing else: no actor, no origin, no keys", async () => {
    const w = world();
    await seed(w, withComment(1, { photos: 2 }));
    const [item] = (await get(w, BEN, "contributions", { author: ANN })).body.items;
    expect(item).toEqual({
      id: U(1), kind: "comment", at: AT, weight: 3, photos: 2, ref: { type: "comment", id: U(1), thread: `person:${PAGE}` }, subject: `person:${PAGE}`,
      href: `/person/?id=${PAGE}#comment-${U(1)}`,
    });
  });

  it("hrefOf names no page for a subject it cannot resolve", () => {
    expect(hrefOf({ ref: { type: "record", id: "x" }, subject: "post:abc" })).toBeNull();
    expect(hrefOf({ ref: { type: "weird", id: "x" } })).toBeNull();
  });
});

describe("contributions.list: who sees what (AC3)", () => {
  it("shows a hidden event only to its author and to admins", async () => {
    const w = world();
    await seed(w, withComment(1));
    await seed(w, withComment(2, { hidden: true }));
    const ids = async (who) => (await get(w, who, "contributions", { author: ANN })).body.items.map((i) => [i.id, i.hidden === true]);
    expect(await ids(ANN)).toEqual([[U(2), true], [U(1), false]]);
    expect(await ids(ADMIN)).toEqual([[U(2), true], [U(1), false]]);
    expect(await ids(BEN)).toEqual([[U(1), false]]);
    expect(await ids(CAL)).toEqual([[U(1), false]]);
  });

  it("omits events whose post the viewer cannot see: a withdrawn post, a deleted post, a post the batch cannot read", async () => {
    const w = world();
    const a = await tok(ANN);
    const b = await tok(BEN);
    const post = (await w.call("POST", "/api/posts", { token: a, body: { body: "synthetic words", visibility: "published" } })).body;
    const comment = (await w.call("POST", "/api/comments", { token: b, body: { subject: `post:${post.id}`, body: "synthetic reply" } })).body;
    const ids = async (who, author) => (await get(w, who, "contributions", { author })).body.items.map((i) => i.kind);

    // Published: everyone sees both.
    expect(await ids(CAL, ANN)).toEqual(["post"]);
    expect(await ids(CAL, BEN)).toEqual(["comment"]);

    // Withdrawn: Ann's post event is hidden; Ben's comment event is not hidden but its post is. Only Ann and admins still see it.
    expect((await w.call("POST", `/api/posts/${post.id}/visibility`, { token: a, body: { visibility: "withdrawn" } })).status).toBe(200);
    expect(await ids(CAL, ANN)).toEqual([]);
    expect(await ids(CAL, BEN)).toEqual([]);
    expect(await ids(BEN, BEN)).toEqual([]); // Ben cannot see the post either, so not his own comment event
    expect(await ids(ANN, BEN)).toEqual(["comment"]);
    expect(await ids(ADMIN, BEN)).toEqual(["comment"]);
    expect(await ids(ANN, ANN)).toEqual(["post"]);
    expect((await get(w, ANN, "contributions", { author: ANN })).body.items[0].hidden).toBe(true);

    // Republished: visible again, hidden flag gone.
    await w.call("POST", `/api/posts/${post.id}/visibility`, { token: a, body: { visibility: "published" } });
    expect(await ids(CAL, ANN)).toEqual(["post"]);
    expect(await ids(CAL, BEN)).toEqual(["comment"]);

    // A comment event whose post no longer exists is omitted (fail closed), whoever asks.
    expect(comment.id).toBeTruthy();
    await seed(w, withComment(900, { actor: { id: BEN }, ref: { type: "comment", id: U(900), thread: `post:${U(901)}` }, subject: `post:${U(901)}` }));
    expect(await ids(ADMIN, BEN)).toEqual(["comment"]); // only the real one
  });

  it("event rows carry no body text, so a withdrawn thread leaks nothing", async () => {
    const w = world();
    const a = await tok(ANN);
    const post = (await w.call("POST", "/api/posts", { token: a, body: { body: "needle words", visibility: "published" } })).body;
    await w.call("POST", "/api/comments", { token: await tok(BEN), body: { subject: `post:${post.id}`, body: "needle reply" } });
    const raw = JSON.stringify([(await get(w, CAL, "contributions", { author: ANN })).body, (await get(w, CAL, "contributions", { author: BEN })).body]);
    expect(raw).not.toContain("needle");
  });

  it("returns events on a proposal thread only to the proposer, the owner of the page and admins; a third member gets nothing", async () => {
    const w = world();
    const prop = U(700);
    await put(w, { PK: `PROP#${prop}`, SK: "META", GSI1PK: "PROPQ#pending", GSI1SK: prop, proposal: { id: prop, state: "pending", proposer: { id: ANN, label: "Ann" }, subject: { gramps_id: BEN } } });
    await seed(w, withComment(1, { ref: { type: "comment", id: U(1), thread: `proposal:${prop}` }, subject: `proposal:${prop}` }));
    await seed(w, withComment(2)); // an ordinary person-thread comment by the same member
    const kinds = async (who) => (await get(w, who, "contributions", { author: ANN })).body.items.map((i) => i.id);
    expect(await kinds(ANN)).toEqual([U(2), U(1)]); // the proposer
    expect(await kinds(BEN)).toEqual([U(2), U(1)]); // the owner of the targeted page
    expect(await kinds(ADMIN)).toEqual([U(2), U(1)]);
    expect(await kinds(CAL)).toEqual([U(2)]); // a third member
    // and the proposal link lands on the page the proposal is about
    expect((await get(w, BEN, "contributions", { author: ANN })).body.items.find((i) => i.id === U(1)).href).toBe(`/person/?id=${BEN}#comment-${U(1)}`);
  });

  it("a proposal_accepted event (proposal ref) is shown to every member and needs no proposal read", async () => {
    const w = world();
    await seed(w, { actor: { id: ANN, label: "Ann" }, kind: "proposal_accepted", ref: { type: "proposal", id: U(710) }, subject: `person:${PAGE}`, id: U(1) });
    for (const who of [ANN, BEN, CAL]) expect((await get(w, who, "contributions", { author: ANN })).body.items.map((i) => i.id), who).toEqual([U(1)]);
    expect(w.ddb.batchGets).toEqual([]);
  });

  it("omits a proposal-thread event when the proposal is gone", async () => {
    const w = world();
    await seed(w, withComment(1, { ref: { type: "comment", id: U(1), thread: `proposal:${U(701)}` }, subject: `proposal:${U(701)}` }));
    expect((await get(w, ADMIN, "contributions", { author: ANN })).body.items).toEqual([]);
  });

  it("proposalVisible: proposer, subject owner, listed owners and admins only", () => {
    const p = { proposer: { id: ANN }, subject: { gramps_id: BEN }, owners: [CAL] };
    expect([ANN, BEN, CAL].map((id) => proposalVisible(p, { id }))).toEqual([true, true, true]);
    expect(proposalVisible(p, { id: "I0004" })).toBe(false);
    expect(proposalVisible(p, { id: "I0004", admin: true })).toBe(true);
    expect(proposalVisible(undefined, { id: ANN })).toBe(false);
    expect(proposalVisible(p, null)).toBe(false);
  });

  it("a replacement proposal rule is honoured", async () => {
    const prop = U(702);
    const w = world();
    await put(w, { PK: `PROP#${prop}`, SK: "META", proposal: { id: prop, proposer: { id: ANN }, subject: { gramps_id: BEN } } });
    await seed(w, withComment(1, { ref: { type: "comment", id: U(1), thread: `proposal:${prop}` }, subject: `proposal:${prop}` }));
    const reader = createContribReader({ ddb: w.ddb, cmds, table: TABLE, actor: { id: CAL }, proposalVisible: () => true });
    expect((await reader.list(ANN)).items).toHaveLength(1);
  });
});

describe("contributions.list: paging and batch reads", () => {
  it("pages newest first with a cursor, and a page filled across events the viewer cannot see", async () => {
    const w = world();
    for (let n = 1; n <= 12; n += 1) await seed(w, withComment(n, n % 3 === 0 ? { hidden: true } : {})); // 4 hidden: 3, 6, 9, 12
    const walk = async (who, limit) => {
      const seen = [];
      let cursor;
      for (let i = 0; i < 20; i += 1) {
        const r = (await get(w, who, "contributions", { author: ANN, limit: String(limit), ...(cursor ? { cursor } : {}) })).body;
        expect(r.items.length).toBeLessThanOrEqual(limit);
        seen.push(...r.items.map((x) => x.id));
        cursor = r.cursor;
        if (!cursor) return seen;
        expect(r.items.length).toBe(limit); // a full page whenever more may follow
      }
      throw new Error("did not end");
    };
    const expected = (ids) => ids.map(U);
    expect(await walk(BEN, 3)).toEqual(expected([11, 10, 8, 7, 5, 4, 2, 1])); // hidden ones skipped, pages still full
    expect(await walk(ANN, 5)).toEqual(expected([12, 11, 10, 9, 8, 7, 6, 5, 4, 3, 2, 1]));
    expect(await walk(CAL, 50)).toEqual(expected([11, 10, 8, 7, 5, 4, 2, 1]));
  });

  it("defaults to 10 items", async () => {
    const w = world();
    for (let n = 1; n <= 13; n += 1) await seed(w, withComment(n));
    const r = (await get(w, BEN, "contributions", { author: ANN })).body;
    expect(r.items).toHaveLength(10);
    expect(r.cursor).toBeTruthy();
  });

  it("an unknown author reads as an empty list", async () => {
    expect((await get(world(), BEN, "contributions", { author: "I7777" })).body).toEqual({ items: [], cursor: null });
  });

  it("batch-checks posts in chunks of at most 20, one key each", async () => {
    const w = world();
    for (let n = 1; n <= 45; n += 1) {
      const P = U(2000 + n);
      await put(w, { PK: `POST#${P}`, SK: "META", post: { id: P, visibility: "published", author: { id: BEN }, body: "x" } });
      await seed(w, withComment(n, { ref: { type: "comment", id: U(n), thread: `post:${P}` }, subject: `post:${P}` }));
    }
    const r = (await get(w, CAL, "contributions", { author: ANN, limit: "50" })).body;
    expect(r.items).toHaveLength(45);
    expect(w.ddb.batchGets).toEqual([20, 20, 5]);
  });

  it("retries unprocessed keys once; keys still unprocessed are omitted (fail closed)", async () => {
    const mk = async () => {
      const w = world();
      for (let n = 1; n <= 3; n += 1) {
        const P = U(3000 + n);
        await put(w, { PK: `POST#${P}`, SK: "META", post: { id: P, visibility: "published", author: { id: BEN }, body: "x" } });
        await seed(w, withComment(n, { ref: { type: "comment", id: U(n), thread: `post:${P}` }, subject: `post:${P}` }));
      }
      return w;
    };
    const once = await mk();
    once.ddb.leaveUnprocessed(1, 2); // two of three keys come back unprocessed once
    expect((await get(once, CAL, "contributions", { author: ANN })).body.items).toHaveLength(3);
    expect(once.ddb.batchGets).toEqual([3, 2]);

    const twice = await mk();
    twice.ddb.leaveUnprocessed(2, 2); // the retry leaves them unprocessed again
    const r = (await get(twice, CAL, "contributions", { author: ANN })).body.items;
    expect(r.map((i) => i.id)).toEqual([U(3)]); // the one key that was read; the two unprocessed events are omitted
    expect(twice.ddb.batchGets).toEqual([3, 2]);
  });

  it("makes no BatchGet when nothing depends on a post or proposal", async () => {
    const w = world();
    await seed(w, withComment(1));
    await get(w, BEN, "contributions", { author: ANN });
    expect(w.ddb.batchGets).toEqual([]);
  });
});

describe("contributions.stats", () => {
  it("reports the member's counters by kind, and first_at", async () => {
    const w = world();
    const credit = (n, args) => transact(w.ddb, cmds, TABLE, contribOps({ actor: { id: ANN, label: "Ann" }, at: AT, uid: () => U(n), ...args }));
    await credit(1, { kind: "post", ref: { type: "post", id: U(50) }, photos: 3 });
    await credit(2, { kind: "comment", ref: { type: "comment", id: U(51), thread: `person:${PAGE}` }, subject: `person:${PAGE}` });
    await credit(3, { kind: "tag", ref: { type: "tag", id: "t" }, subject: PAGE });
    const r = await get(w, BEN, "contributions/stats", { author: ANN });
    expect(r.status).toBe(200);
    expect(r.body).toEqual({
      author: ANN, total: 6, first_at: AT,
      by_kind: { post: 1, comment: 1, photo: 3, self_edit: 0, proposal_accepted: 0, tag: 1, photo_to_record: 0 },
    });
  });

  it("an unknown author returns zeros, not 404", async () => {
    const r = await get(world(), BEN, "contributions/stats", { author: "I7777" });
    expect(r.status).toBe(200);
    expect(r.body).toEqual({ author: "I7777", total: 0, by_kind: { post: 0, comment: 0, photo: 0, self_edit: 0, proposal_accepted: 0, tag: 0, photo_to_record: 0 } });
  });

  it("hidden events still count: a withdrawn post keeps its credit in the totals others see", async () => {
    const w = world();
    const credit = (n, args) => transact(w.ddb, cmds, TABLE, contribOps({ actor: { id: ANN, label: "Ann" }, at: AT, uid: () => U(n), ...args }));
    const { event } = await credit(1, { kind: "comment", ref: { type: "comment", id: U(51), thread: `person:${PAGE}` }, subject: `person:${PAGE}` });
    await transact(w.ddb, cmds, TABLE, hideOps(event ?? { actor: { id: ANN }, id: U(1) }, true));
    expect((await get(w, BEN, "contributions", { author: ANN })).body.items).toEqual([]);
    expect((await get(w, BEN, "contributions/stats", { author: ANN })).body).toMatchObject({ total: 1, by_kind: { comment: 1 } });
  });

  it("clamps negative counters at 0", async () => {
    const w = world();
    await put(w, { PK: `CSTAT#person:${ANN}`, SK: "TOTAL", n: -3, n_post: -1, n_comment: 2, n_photo: -4 });
    const r = (await get(w, BEN, "contributions/stats", { author: ANN })).body;
    expect(r).toMatchObject({ total: 0, by_kind: { post: 0, comment: 2, photo: 0 } });
  });

  it("counts follow the real write paths: a post with a photo, a comment, then a delete", async () => {
    const w = world();
    const a = await tok(ANN);
    const post = (await w.call("POST", "/api/posts", { token: a, body: { body: "synthetic", visibility: "published" } })).body;
    await w.call("POST", "/api/comments", { token: a, body: { subject: `person:${PAGE}`, body: "synthetic" } });
    expect((await get(w, BEN, "contributions/stats", { author: ANN })).body).toMatchObject({ total: 2, by_kind: { post: 1, comment: 1 } });
    await w.call("DELETE", `/api/posts/${post.id}`, { token: a });
    expect((await get(w, BEN, "contributions/stats", { author: ANN })).body).toMatchObject({ total: 1, by_kind: { post: 0, comment: 1 } });
  });
});

describe("contributions.site and the LINE cache (AC4)", () => {
  const T0 = Date.parse("2026-03-14T12:00:00.000Z");
  const queries = (w) => w.ddb.calls.filter((c) => c === "QueryCommand").length;
  const lineRow = (w) => w.ddb.all().find((r) => r.PK === "CSTAT#site" && r.SK === "LINE");
  const site = (w) => get(w, BEN, "contributions/stats");

  async function seedSite(w, perDay, total = 40) {
    await put(w, { PK: "CSTAT#site", SK: "TOTAL", n: total, first_at: "2025-06-01T00:00:00.000Z" });
    for (const [ago_, n] of Object.entries(perDay)) await put(w, { PK: "CSTAT#site", SK: `D#${dayAgo(Number(ago_), "2026-03-14")}`, n });
  }

  it("returns the total, the line and computed_at, and writes the LINE row with a 2 hour ttl", async () => {
    let t = T0;
    const w = world({ clock: () => t });
    await seedSite(w, { 0: 2, 1: 2, 2: 8 });
    const r = await site(w);
    expect(r.status).toBe(200);
    expect(r.body).toEqual({
      total: 40, computed_at: "2026-03-14T12:00:00.000Z",
      line: { x: 12, y: 3, unit: "day", window_days: 3, text: "12 contributions in the past 3 days" },
    });
    expect(lineRow(w)).toMatchObject({ x: 12, y: 3, unit: "day", window_days: 3, text: "12 contributions in the past 3 days", computed_at: "2026-03-14T12:00:00.000Z", ttl: Math.floor(T0 / 1000) + 7200 });
  });

  it("recomputes only after 1 hour (injected clock)", async () => {
    let t = T0;
    const w = world({ clock: () => t });
    await seedSite(w, { 0: 2, 1: 2, 2: 8 });
    const first = (await site(w)).body;
    const q1 = queries(w);
    expect(q1).toBeGreaterThan(0);

    // New activity lands, but within the hour the cached line is served and nothing is re-read.
    await put(w, { PK: "CSTAT#site", SK: `D#${dayAgo(0, "2026-03-14")}`, n: 30 });
    t = T0 + LINE_TTL_MS - 1;
    const cached = (await site(w)).body;
    expect(cached.line).toEqual(first.line);
    expect(cached.computed_at).toBe(first.computed_at);
    expect(queries(w)).toBe(q1);

    // At one hour exactly it recomputes, and the new line reflects the new activity.
    t = T0 + LINE_TTL_MS;
    const fresh = (await site(w)).body;
    expect(queries(w)).toBeGreaterThan(q1);
    expect(fresh.computed_at).toBe("2026-03-14T13:00:00.000Z");
    expect(fresh.line).toMatchObject({ x: 30, window_days: 1 });
    expect(lineRow(w).computed_at).toBe("2026-03-14T13:00:00.000Z");
  });

  it("line is null when no window reaches 3, and that answer is cached too", async () => {
    let t = T0;
    const w = world({ clock: () => t });
    await seedSite(w, { 0: 1, 30: 1 }, 2);
    const r = (await site(w)).body;
    expect(r).toEqual({ total: 2, line: null, computed_at: "2026-03-14T12:00:00.000Z" });
    const q1 = queries(w);
    t = T0 + 30 * 60_000;
    expect((await site(w)).body.line).toBeNull();
    expect(queries(w)).toBe(q1);
    expect(lineRow(w).text).toBeUndefined();
  });

  it("an empty site: total 0, line null", async () => {
    const w = world({ clock: () => T0 });
    expect((await site(w)).body).toEqual({ total: 0, line: null, computed_at: "2026-03-14T12:00:00.000Z" });
  });

  it("keeps a neighbouring window within the UTC day (dwell) across a recompute", async () => {
    let t = T0;
    const w = world({ clock: () => t });
    await seedSite(w, { 0: 1, 1: 1, 5: 1 });
    expect((await site(w)).body.line).toMatchObject({ window_days: 6 });
    // an hour later a 7-day pick is not forced on it: the fresh pick is still 6 days, so it stays 6
    t = T0 + LINE_TTL_MS;
    expect((await site(w)).body.line).toMatchObject({ window_days: 6 });
    // a new contribution makes the fresh pick 5 days (one step from 6): the cached 6-day window is kept, with the current count
    await put(w, { PK: "CSTAT#site", SK: `D#${dayAgo(4, "2026-03-14")}`, n: 1 });
    t = T0 + 2 * LINE_TTL_MS;
    expect((await site(w)).body.line).toMatchObject({ window_days: 6, x: 4, text: "4 contributions in the past 6 days" });
  });

  it("reads month buckets for a multi-year window", async () => {
    const w = world({ clock: () => T0 });
    await put(w, { PK: "CSTAT#site", SK: "TOTAL", n: 9, first_at: "2024-01-01T00:00:00.000Z" });
    for (const m of ["2025-06", "2025-11", "2026-02"]) await put(w, { PK: "CSTAT#site", SK: `M#${m}`, n: 1 });
    expect((await site(w)).body.line).toEqual({ x: 3, y: 2, unit: "year", window_days: 730, text: "3 contributions in the past 2 years" });
  });
});

describe("contributions.site cache write failure", () => {
  it("serves the computed line even when the LINE row cannot be written", async () => {
    const errors = [];
    let failPuts = false;
    const w = makeApi({
      admins: [ADMIN], flags: { contribV1: true }, clock: () => Date.parse("2026-03-14T12:00:00.000Z"), log: { warn() {}, error: (m) => errors.push(m) },
      intercept: async (cmd) => { if (failPuts && cmd.constructor.name === "PutCommand") throw Object.assign(new Error("boom"), { name: "ProvisionedThroughputExceededException" }); },
    });
    await put(w, { PK: "CSTAT#site", SK: "TOTAL", n: 9, first_at: "2025-06-01T00:00:00.000Z" });
    await put(w, { PK: "CSTAT#site", SK: `D#${dayAgo(0, "2026-03-14")}`, n: 9 });
    failPuts = true;
    const r = await get(w, BEN, "contributions/stats");
    expect(r.status).toBe(200);
    expect(r.body.line).toMatchObject({ x: 9 });
    expect(errors).toHaveLength(1);
  });
});
