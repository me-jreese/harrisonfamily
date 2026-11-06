// HFY-TSK-387-0F (HFY-PLN-004 L1): POST /api/life-dates, fixtures L-1..L-8 of the BRD (DOC-B2485262A8C7), table driven. In-memory DynamoDB fake;
// synthetic ids, names and handles only.
import { describe, expect, it } from "vitest";
import { cmds, TABLE } from "./world.js";
import { ulidFloor, LIFE_DATES_RATE_LIMIT, PROPOSAL_RATE_LIMIT, rateLimitFor, proposalBucketOf } from "../src/records/proposals.js";
import { ADMIN, ME, OTHER, h, withEditWorld } from "./edit-e2e-world.js";
import { applyBatch } from "../src/sync/apply.js";
import { SOURCE_TITLE, classifyDate, yearDate } from "../src/records/life-dates.js";

const NOW_YEAR = new Date().getUTCFullYear();
const typ = (cls, value) => ({ _class: cls, string: "", value });
const dt = (dateval = [0, 0, 0, false], extra = {}) => ({ _class: "Date", calendar: 0, dateval, format: null, modifier: 0, newyear: 0, quality: 0, sortval: 0, text: "", ...extra });
const eref = (ev) => ({ _class: "EventRef", attribute_list: [], citation_list: [], note_list: [], private: false, ref: ev.handle, role: typ("EventRoleType", 1) });
const ev = (n, type, date) => ({
  _class: "Event", handle: h(3000 + n), gramps_id: `E${String(n).padStart(4, "0")}`, attribute_list: [], change: 0, citation_list: [], date, description: "", media_list: [], note_list: [], place: "", private: false, tag_list: [], type: typ("EventType", type),
});
const person = (n, events = []) => ({
  _class: "Person", handle: h(n), gramps_id: `I${String(n).padStart(4, "0")}`, address_list: [], alternate_names: [], attribute_list: [], change: 0, citation_list: [], family_list: [], gender: 2,
  lds_ord_list: [], media_list: [], note_list: [], parent_family_list: [], person_ref_list: [], private: false, tag_list: [], urls: [],
  primary_name: {
    _class: "Name", call: "", citation_list: [], date: dt(), display_as: 0, famnick: "", first_name: `Fixture${n}`, group_as: "", nick: "", note_list: [], private: false, sort_as: 0, suffix: "", title: "",
    surname_list: [{ _class: "Surname", connector: "", origintype: typ("NameOriginType", 1), prefix: "", primary: true, surname: "Testwood" }], type: typ("NameType", 2),
  },
  event_ref_list: events.map(eref),
  birth_ref_index: events.findIndex((e) => e.type.value === 12),
  death_ref_index: events.findIndex((e) => e.type.value === 13),
});

async function seed(w, objs) {
  let t = Date.parse("2026-10-20T00:00:00Z");
  let u = 0;
  const sctx = { ddb: w.ddb, cmds, table: TABLE, now: () => (t += 1000), uid: () => `ld${++u}`, unsafeNoValidate: true, log: { warn() {}, error() {}, info() {} }, txnOpts: { sleep: async () => {} } };
  await applyBatch(sctx, { principal: "svc-seed", origin: "desktop", idempotencyKey: `ld-seed-${objs[0].handle}`, ops: objs.map((o) => ({ op: "create", class: o._class, handle: o.handle, base_version: null, obj: o })) });
}

let idem = 0;
const suggest = (w, who, n, body, extra = {}) => w.call("POST", "/api/life-dates", who, { body: { target: `Person:${h(n)}`, ...body, ...extra.body }, headers: extra.noKey ? {} : { "idempotency-key": extra.key ?? `ld-${++idem}` } });
const approve = (w, p) => w.call("POST", `/api/proposals/${p.id}/decision`, ADMIN, { body: { verdict: "approve" }, headers: { "if-match": `"${p.etag}"`, "idempotency-key": `ld-ap-${++idem}` } });
const events = (w, n) => w.stored("Person", h(n)).event_ref_list.map((r) => ({ ref: r, ev: w.stored("Event", r.ref) }));
const sources = (w) => w.rows("REC#Source#").filter((r) => r.SK === "HEAD");
const citationOf = (w, e) => w.stored("Citation", e.citation_list[0]);

describe("life dates: compile and approve (L-1, L-2, L-3, L-5)", () => {
  it("L-1: Born about 1890 makes one Birth event, estimated, Primary, with the member Citation on the shared Source", async () => {
    await withEditWorld(async (w) => {
      await seed(w, [person(40)]);
      const r = await suggest(w, ME, 40, { birth: { year: 1890, about: true } });
      expect(r.status).toBe(201);
      expect(r.body.applied).toBeNull();
      expect(r.body.proposal.state).toBe("pending");
      expect(r.body.rows.birth).toMatchObject({ status: "proposed", action: "create" });
      expect(r.body.marks_deceased).toBe(false);
      expect(r.body.proposal.intent).toMatchObject({ type: "life_dates", marks_deceased: false, birth: { year: 1890, about: true } });
      expect((await approve(w, r.body.proposal)).status).toBe(200);
      const list = events(w, 40);
      expect(list).toHaveLength(1);
      expect(list[0].ref.role.value).toBe(1);
      expect(list[0].ev.type.value).toBe(12);
      expect(list[0].ev.date).toMatchObject({ dateval: [0, 0, 1890, false], quality: 1, modifier: 0, text: "" });
      expect(w.stored("Person", h(40))).toMatchObject({ birth_ref_index: 0, death_ref_index: -1 });
      expect(sources(w)).toHaveLength(1);
      const cit = citationOf(w, list[0].ev);
      expect(w.stored("Source", cit.source_handle).title).toBe(SOURCE_TITLE);
      expect(cit.page).toMatch(/^Family knowledge: .+, via harrisonfamily\.us, \d{4}-\d{2}-\d{2}$/);
    });
  });

  it("L-2: Died 1962 makes one Death event, marks the suggestion, and the person is no longer living after approval; the Source is reused", async () => {
    await withEditWorld(async (w) => {
      await seed(w, [person(41), person(42)]);
      const r = await suggest(w, OTHER, 41, { death: { year: 1962 } });
      expect(r.status).toBe(201);
      expect(r.body.marks_deceased).toBe(true);
      expect(r.body.proposal.intent.marks_deceased).toBe(true);
      expect(r.body.summary.map((s) => s.text)).toContain("this will mark them as deceased");
      expect(w.stored("Person", h(41)).death_ref_index).toBe(-1); // nothing is marked without an approval (P4-R20)
      expect((await approve(w, r.body.proposal)).status).toBe(200);
      const list = events(w, 41);
      expect(list).toHaveLength(1);
      expect(list[0].ev.type.value).toBe(13);
      expect(list[0].ev.date).toMatchObject({ dateval: [0, 0, 1962, false], quality: 0 });
      expect(w.stored("Person", h(41)).death_ref_index).toBe(0);
      // a second submission reuses the Source: no Source create op, one Source in the store
      const r2 = await suggest(w, OTHER, 42, { birth: { year: 1900 } });
      expect(r2.body.proposal.ops.filter((o) => o.op === "create").map((o) => o.cls).sort()).toEqual(["Citation", "Event"]);
      expect((await approve(w, r2.body.proposal)).status).toBe(200);
      expect(sources(w)).toHaveLength(1);
    });
  });

  it("an admin's own submission is a suggestion too (D-24, P4-R24)", async () => {
    await withEditWorld(async (w) => {
      await seed(w, [person(43)]);
      const r = await suggest(w, ADMIN, 43, { birth: { year: 1950 }, death: { year: 2001 } });
      expect(r.status).toBe(201);
      expect(r.body.applied).toBeNull();
      expect(r.body.proposal.state).toBe("pending");
      expect(w.stored("Person", h(43)).event_ref_list).toHaveLength(0);
      expect((await approve(w, r.body.proposal)).status).toBe(200);
      expect(w.stored("Person", h(43))).toMatchObject({ birth_ref_index: 0, death_ref_index: 1 });
      expect(events(w, 43).map((x) => x.ev.type.value)).toEqual([12, 13]);
    });
  });

  it("L-3: an existing date-less Birth event gains the year and the event count stays 1; the primary of two Birth events is the one updated", async () => {
    await withEditWorld(async (w) => {
      const b1 = ev(1, 12, dt());
      const b2 = ev(2, 12, dt([0, 0, 1851, false]));
      const solo = ev(3, 12, dt([0, 0, 1851, false]));
      await seed(w, [b1, b2, solo, person(44, [b1]), person(45, [b1, b2].map((e, i) => ({ ...e, handle: e.handle }))), person(46, [solo])]);
      const r = await suggest(w, ME, 44, { birth: { year: 1850 } });
      expect(r.body.rows.birth).toMatchObject({ status: "shared_event" }); // b1 is referenced by persons 44 and 45: never edited in place
    });
    await withEditWorld(async (w) => {
      const b1 = ev(1, 12, dt());
      const b2 = ev(2, 12, dt([0, 0, 1851, false]));
      const solo = ev(3, 12, dt([0, 0, 1851, false]));
      await seed(w, [b1, b2, solo, person(44, [b1, b2]), person(46, [solo])]);
      const r = await suggest(w, ME, 44, { birth: { year: 1850 } });
      expect(r.body.rows.birth).toMatchObject({ status: "proposed", action: "update" });
      expect(r.body.proposal.ops.some((o) => o.op === "create" && o.cls === "Event")).toBe(false);
      expect((await approve(w, r.body.proposal)).status).toBe(200);
      const list = events(w, 44);
      expect(list).toHaveLength(2); // none added, the second Birth left as it was
      expect(list[0].ev.date.dateval).toEqual([0, 0, 1850, false]);
      expect(list[1].ev.date.dateval).toEqual([0, 0, 1851, false]);
      expect(citationOf(w, list[0].ev).source_handle).toBeTruthy();
      // a plain year changes in place too, and the same year is no change at all
      const r2 = await suggest(w, ME, 46, { birth: { year: 1852 } });
      expect(r2.body.rows.birth).toMatchObject({ status: "proposed", action: "update", current: { year: 1851 } });
      const r3 = await suggest(w, ME, 46, { birth: { year: 1851 } });
      expect(r3.status).toBe(200);
      expect(r3.body).toMatchObject({ proposal: null, unchanged: true, rows: { birth: { status: "unchanged" } } });
    });
  });

  it("L-5: Died, year unknown makes a date-less Death event with the Citation, and the person is deceased after approval", async () => {
    await withEditWorld(async (w) => {
      await seed(w, [person(47)]);
      const r = await suggest(w, ME, 47, { death: { unknown: true } });
      expect(r.status).toBe(201);
      expect(r.body.marks_deceased).toBe(true);
      expect((await approve(w, r.body.proposal)).status).toBe(200);
      const list = events(w, 47);
      expect(list).toHaveLength(1);
      expect(list[0].ev.type.value).toBe(13);
      expect(list[0].ev.date).toMatchObject({ dateval: [0, 0, 0, false], text: "", modifier: 0, sortval: 0 });
      expect(list[0].ev.citation_list).toHaveLength(1);
      expect(w.stored("Person", h(47)).death_ref_index).toBe(0);
      // asking again changes nothing: a Death event is already there
      const again = await suggest(w, ME, 47, { death: { unknown: true } });
      expect(again.body).toMatchObject({ proposal: null, unchanged: true, rows: { death: { status: "unchanged" } } });
    });
  });
});

describe("life dates: precise dates on file (L-4)", () => {
  const PRECISE = [
    ["a full date", dt([12, 3, 1850, false])],
    ["a month and year", dt([0, 3, 1850, false])],
    ["a range", dt([1, 1, 1850, false, 1, 1, 1851, false], { modifier: 4 })],
    ["before a year", dt([0, 0, 1850, false], { modifier: 1 })],
    ["a text date", dt([0, 0, 0, false], { modifier: 6, text: "spring of the flood" })],
  ];
  it.each(PRECISE)("%s is read-only: the row answers precise_on_file, nothing is saved, and only the year is returned", async (_name, date) => {
    await withEditWorld(async (w) => {
      const b = ev(1, 12, date);
      await seed(w, [b, person(50, [b])]);
      const before = w.version("Person", h(50));
      const r = await suggest(w, ME, 50, { birth: { year: 1851 } });
      expect(r.status).toBe(200);
      expect(r.body.proposal).toBeNull();
      expect(r.body.rows.birth.status).toBe("precise_on_file");
      expect(Object.keys(r.body.rows.birth.current)).toEqual(["year"]);
      expect(JSON.stringify(r.body)).not.toMatch(/dateval/);
      expect(w.stored("Event", b.handle).date).toEqual(date);
      expect(w.version("Person", h(50))).toBe(before);
    });
  });

  it("the other row still goes through when only one is precise (a desk-entered death date; a precise birth never reaches the cloud, R-18)", async () => {
    await withEditWorld(async (w) => {
      const d = ev(1, 13, dt([12, 3, 1950, false]));
      await seed(w, [d, person(51, [d])]);
      const r = await suggest(w, ME, 51, { birth: { year: 1900 }, death: { year: 1951 } });
      expect(r.status, JSON.stringify(r.body)).toBe(201);
      expect(r.body.rows.death).toMatchObject({ status: "precise_on_file", current: { year: 1950 } });
      expect(r.body.rows.birth).toMatchObject({ status: "proposed", action: "create" });
      expect(r.body.marks_deceased).toBe(false); // the Death event already there is untouched
      expect(r.body.proposal.ops.filter((o) => o.op === "create" && o.cls === "Event")).toHaveLength(1);
      expect((await approve(w, r.body.proposal)).status).toBe(200);
      expect(w.stored("Event", d.handle).date.dateval).toEqual([12, 3, 1950, false]);
    });
  });
});

describe("life dates: validation (L-6, L-8)", () => {
  const BAD = [
    ["a year before 1600", { birth: { year: 1599 } }, "year_range"],
    ["a year after this year", { birth: { year: NOW_YEAR + 1 } }, "year_range"],
    ["a death after this year", { death: { year: NOW_YEAR + 1 } }, "year_range"],
    ["a text year", { birth: { year: "1890" } }, "year"],
    ["a fractional year", { birth: { year: 1890.5 } }, "year"],
    ["died before born", { birth: { year: 1950 }, death: { year: 1940 } }, "death_before_birth"],
    ["a day (L-8)", { birth: { year: 1890, day: 5 } }, "unknown_field"],
    ["a month (L-8)", { death: { year: 1890, month: 3 } }, "unknown_field"],
    ["a full date (L-8)", { birth: { date: "1890-03-05" } }, "unknown_field"],
    ["a year and unknown together", { death: { year: 1900, unknown: true } }, "unknown"],
    ["an empty request", {}, "empty"],
  ];
  it.each(BAD)("%s is refused with 400 and nothing is saved", async (_name, body, code) => {
    await withEditWorld(async (w) => {
      await seed(w, [person(52)]);
      const r = await suggest(w, ME, 52, body);
      expect(r.status).toBe(400);
      expect(r.body.errors.map((e) => e.code)).toContain(code);
      expect(w.rows("PROP#")).toHaveLength(0);
    });
  });

  it("died before the birth year already on file is refused", async () => {
    await withEditWorld(async (w) => {
      const b = ev(1, 12, dt([0, 0, 1900, false]));
      await seed(w, [b, person(53, [b])]);
      const r = await suggest(w, ME, 53, { death: { year: 1890 } });
      expect(r.status).toBe(400);
      expect(r.body.errors.map((e) => e.code)).toContain("death_before_birth");
    });
  });

  it("a lifespan over 120 years asks for confirmation, saves nothing, and goes through with confirm", async () => {
    await withEditWorld(async (w) => {
      await seed(w, [person(54)]);
      const asked = await suggest(w, ME, 54, { birth: { year: 1800 }, death: { year: 1925 } });
      expect(asked.status).toBe(200);
      expect(asked.body).toMatchObject({ confirm_needed: true, reason: "lifespan_over_120", lifespan: 125, proposal: null });
      expect(w.rows("PROP#")).toHaveLength(0);
      const exact = await suggest(w, ME, 54, { birth: { year: 1800 }, death: { year: 1920 } });
      expect(exact.status).toBe(201); // 120 years exactly is allowed
      const sure = await suggest(w, ME, 54, { birth: { year: 1800 }, death: { year: 1925 }, confirm: true });
      expect(sure.status).toBe(201);
    });
  });

  it("no stored value or op carries a day or month (L-8)", async () => {
    await withEditWorld(async (w) => {
      await seed(w, [person(55)]);
      const r = await suggest(w, ME, 55, { birth: { year: 1890, about: true }, death: { year: 1960 } });
      expect(r.status).toBe(201);
      const dates = r.body.proposal.ops.flatMap((o) => (o.cls === "Event" ? [o.value.date] : o.path === "/date" ? [o.value] : []));
      expect(dates).toHaveLength(2);
      for (const d of dates) expect([d.dateval[0], d.dateval[1], d.text]).toEqual([0, 0, ""]);
      await approve(w, r.body.proposal);
      for (const { ev: e } of events(w, 55)) expect([e.date.dateval[0], e.date.dateval[1]]).toEqual([0, 0]);
    });
  });
});

describe("life dates: pending, concurrency, replay (L-7)", () => {
  it("L-7: two members' different death years sit side by side, and only one death is ever recorded", async () => {
    await withEditWorld(async (w) => {
      await seed(w, [person(56)]);
      const a = await suggest(w, ME, 56, { death: { year: 1961 } });
      const b = await suggest(w, OTHER, 56, { death: { year: 1962 } });
      expect([a.status, b.status]).toEqual([201, 201]);
      const bundle = await w.call("GET", `/api/edit/Person/h:${h(56)}`, ADMIN);
      expect(bundle.body.pending.map((p) => p.proposalId).sort()).toEqual([a.body.proposal.id, b.body.proposal.id].sort());
      expect((await approve(w, a.body.proposal)).status).toBe(200);
      const second = await approve(w, b.body.proposal);
      expect(second.status).toBe(409); // the page moved: the other suggestion is stale, not a second Death event
      expect(events(w, 56).filter((x) => x.ev.type.value === 13)).toHaveLength(1);
    });
  });

  it("dry_run writes nothing and returns the plan; a repeated Idempotency-Key replays; a stale base version is 409", async () => {
    await withEditWorld(async (w) => {
      await seed(w, [person(57)]);
      const dry = await suggest(w, ME, 57, { birth: { year: 1888 }, dry_run: true }, { noKey: true });
      expect(dry.status).toBe(200);
      expect(dry.body.plan.review.length).toBeGreaterThan(0);
      expect(dry.body.rows.birth.status).toBe("proposed");
      expect(w.rows("PROP#")).toHaveLength(0);
      const first = await suggest(w, ME, 57, { birth: { year: 1888 } }, { key: "ld-same" });
      const again = await suggest(w, ME, 57, { birth: { year: 1888 } }, { key: "ld-same" });
      expect(again.status).toBe(201);
      expect(again.body.proposal.id).toBe(first.body.proposal.id);
      expect(again.body.rows.birth.status).toBe("proposed");
      const other = await suggest(w, ME, 57, { birth: { year: 1889 } }, { key: "ld-same" });
      expect(other.status).toBe(422);
      const stale = await suggest(w, ME, 57, { birth: { year: 1890 }, base_versions: { [`Person:${h(57)}`]: 999 } });
      expect(stale.status).toBe(409);
      expect((await suggest(w, ME, 57, { birth: { year: 1890 } }, { noKey: true })).status).toBe(400);
      expect((await w.call("POST", "/api/life-dates", ME, { body: { target: `Person:${h(999)}`, birth: { year: 1890 } }, headers: { "idempotency-key": "ld-none" } })).status).toBe(404);
    });
  });
});

describe("classifyDate", () => {
  it.each([
    [dt(), { kind: "empty" }],
    [undefined, { kind: "empty" }],
    [dt([0, 0, 1890, false]), { kind: "year", year: 1890, about: false }],
    [yearDate(1890, true), { kind: "year", year: 1890, about: true }],
    [dt([0, 0, 1890, false], { modifier: 3 }), { kind: "year", year: 1890, about: true }],
    [dt([5, 0, 1890, false]), { kind: "precise", year: 1890 }],
    [dt([0, 0, 1890, false], { calendar: 1 }), { kind: "precise", year: 1890 }],
    [dt([0, 0, 0, false], { modifier: 6, text: "unknown" }), { kind: "precise", year: 0 }],
  ])("%j", (date, want) => {
    expect(classifyDate(date)).toEqual(want);
  });
});

// ---- GET /api/life-dates (HFY-TSK-388-0D, ruling P4-R29): coarse precision classes only ---------------------------------------------------
describe("GET /api/life-dates: the coarse classes", () => {
  const read = (w, who, n, target) => w.call("GET", "/api/life-dates", who, { query: { target: target ?? `Person:${h(n)}` } });
  const BIRTH = 12;
  const DEATH = 13;
  const CASES = [
    ["no event on file", null, { class: "none", year: null }],
    ["an event with no date", dt(), { class: "none", year: null }],
    ["a plain year", dt([0, 0, 1890, false]), { class: "year", year: 1890 }],
    ["an estimated year", yearDate(1890, true), { class: "about", year: 1890 }],
    ["a year with the about modifier", dt([0, 0, 1890, false], { modifier: 3 }), { class: "about", year: 1890 }],
    ["a day and a month", dt([4, 3, 1890, false]), { class: "precise", year: 1890 }],
    ["a month only", dt([0, 3, 1890, false]), { class: "precise", year: 1890 }],
    ["a range", dt([4, 3, 1890, false, 9, 8, 1895, false], { modifier: 4 }), { class: "precise", year: 1890 }],
    ["another calendar", dt([0, 0, 1890, false], { calendar: 1 }), { class: "precise", year: 1890 }],
    ["a text date with no year", dt([0, 0, 0, false], { modifier: 6, text: "spring of the flood" }), { class: "precise", year: null }],
  ];

  it.each(CASES)("birth, %s", async (_name, date, want) => {
    await withEditWorld(async (w) => {
      const e = date ? ev(1, BIRTH, date) : null;
      await seed(w, [...(e ? [e] : []), person(60, e ? [e] : [])]);
      const r = await read(w, ME, 60);
      expect(r.status).toBe(200);
      expect(r.body.birth).toEqual(want);
      expect(r.body.death).toEqual({ class: "none", year: null });
      expect(r.body.sharedEvent).toEqual({ birth: false, death: false });
    });
  });

  it.each(CASES)("death, %s", async (_name, date, want) => {
    await withEditWorld(async (w) => {
      const e = date ? ev(2, DEATH, date) : null;
      await seed(w, [...(e ? [e] : []), person(61, e ? [e] : [])]);
      const r = await read(w, OTHER, 61);
      expect(r.status).toBe(200);
      expect(r.body.death).toEqual(want);
      expect(r.body.birth).toEqual({ class: "none", year: null });
      expect(r.body.livingByRule).toBe(!e);
    });
  });

  it("the reply is exactly the coarse fields, and a precise date leaks no month, day, range, text or calendar: no digits but the year", async () => {
    await withEditWorld(async (w) => {
      const b = ev(1, BIRTH, dt([4, 3, 1890, false, 9, 8, 1895, false], { modifier: 4, calendar: 1, text: "4 March 1890 to 9 August 1895" }));
      const d = ev(2, DEATH, dt([17, 11, 1962, false]));
      await seed(w, [b, d, person(62, [b, d])]);
      const r = await read(w, ME, 62);
      expect(r.status).toBe(200);
      expect(Object.keys(r.body).sort()).toEqual(["birth", "death", "livingByRule", "sharedEvent"]);
      expect(Object.keys(r.body.birth).sort()).toEqual(["class", "year"]);
      expect(r.body).toMatchObject({ birth: { class: "precise", year: 1890 }, death: { class: "precise", year: 1962 }, livingByRule: false });
      expect(JSON.stringify(r.body).replace(/1890|1962/g, "")).not.toMatch(/\d/);
      expect(JSON.stringify(r.body)).not.toMatch(/month|day|range|text|calendar|modifier|quality/i);
      expect(String(r.headers?.["cache-control"] ?? r.headers?.["Cache-Control"])).toMatch(/private/);
      expect(String(r.headers?.["cache-control"] ?? r.headers?.["Cache-Control"])).toMatch(/no-store/);
    });
  });

  it("the living rule is no death reference: a death event with no date still says they died, and none says living", async () => {
    await withEditWorld(async (w) => {
      const born = ev(1, BIRTH, dt([0, 0, 1925, false]));
      const deadNoYear = ev(2, DEATH, dt());
      await seed(w, [born, deadNoYear, person(63, [born]), person(64, [born, deadNoYear].map((e) => ({ ...e, handle: e.handle })))]);
      const living = await read(w, ME, 63);
      expect(living.body.livingByRule).toBe(true);
      const dead = await read(w, ME, 64);
      expect(dead.body.livingByRule).toBe(false);
      expect(dead.body.death).toEqual({ class: "none", year: null });
    });
  });

  it("an event another person also references is flagged sharedEvent for that row only", async () => {
    await withEditWorld(async (w) => {
      const b1 = ev(1, BIRTH, dt([0, 0, 1851, false]));
      const d1 = ev(2, DEATH, dt([0, 0, 1900, false]));
      await seed(w, [b1, d1, person(65, [b1, d1]), person(66, [b1])]);
      const r = await read(w, ME, 65);
      expect(r.body.sharedEvent).toEqual({ birth: true, death: false });
      expect(r.body.birth).toEqual({ class: "year", year: 1851 });
    });
  });

  it("only the primary-role Birth is read (the rule POST uses)", async () => {
    await withEditWorld(async (w) => {
      const b1 = ev(1, BIRTH, dt());
      const b2 = ev(2, BIRTH, dt([0, 0, 1851, false]));
      await seed(w, [b1, b2, person(67, [b1, b2])]);
      expect((await read(w, ME, 67)).body.birth).toEqual({ class: "none", year: null });
    });
  });

  it.each([
    ["no target", undefined],
    ["a record of another class", "Event:abc"],
    ["a bad handle", "Person:a b"],
    ["an empty handle", "Person:"],
    ["a gramps id", "I0001"],
  ])("%s is 400 validation", async (_name, target) => {
    await withEditWorld(async (w) => {
      const r = await w.call("GET", "/api/life-dates", ME, target === undefined ? {} : { query: { target } });
      expect(r.status).toBe(400);
      expect(r.body.errors?.[0]?.pointer ?? r.body.error?.errors?.[0]?.pointer ?? "/target").toBe("/target");
    });
  });

  it("a person that does not exist is 404, and a request with no sign-in is 401", async () => {
    await withEditWorld(async (w) => {
      await seed(w, [person(68)]);
      expect((await read(w, ME, 0, "Person:nosuchperson")).status).toBe(404);
      expect((await w.rawCall("GET", "/api/life-dates", { query: { target: `Person:${h(68)}` } })).status).toBe(401);
    });
  });

  it("it is read-only: nothing is written and no proposal is made", async () => {
    await withEditWorld(async (w) => {
      const b = ev(1, BIRTH, dt([0, 0, 1890, false]));
      await seed(w, [b, person(69, [b])]);
      const before = w.ddb.all().length;
      await read(w, ME, 69);
      expect(w.ddb.all().length).toBe(before);
    });
  });
});

// ---- P4-R28: the life_dates proposal bucket (HFY-TSK-388-0E) -----------------------------------------------------------------------
describe("P4-R28: life_dates proposals have their own rate bucket", () => {
  const fill = (w, who, count, type, tag) => {
    const nowMs = Date.now();
    for (let i = 0; i < count; i += 1) {
      const id = `${ulidFloor(nowMs - 3_600_000).slice(0, 10)}${tag}${String(i).padStart(15, "0")}`;
      w.ddb.rows.set(`PROP#${id}\u0000IDX#BY`, { PK: `PROP#${id}`, SK: "IDX#BY", GSI1PK: `PROPBY#${who}`, GSI1SK: id, proposal: type ? { intent: { type } } : {} });
    }
  };
  it("the limits and the bucket of an intent", () => {
    expect([PROPOSAL_RATE_LIMIT, LIFE_DATES_RATE_LIMIT]).toEqual([50, 300]);
    expect([proposalBucketOf({ type: "life_dates" }), proposalBucketOf({ type: "relationship" }), proposalBucketOf(undefined)]).toEqual(["life_dates", "general", "general"]);
    expect([rateLimitFor("life_dates"), rateLimitFor("general")]).toEqual([300, 50]);
  });
  it.each([
    ["the 51st life_dates suggestion is accepted after 50 ordinary ones", 50, undefined, 201],
    ["60 ordinary suggestions do not touch the life_dates bucket", 60, undefined, 201],
    ["the 51st life_dates suggestion is accepted after 50 life_dates ones", 50, "life_dates", 201],
    ["the 300th life_dates suggestion is accepted", 299, "life_dates", 201],
    ["the 301st life_dates suggestion is refused", 300, "life_dates", 429],
  ])("%s", async (_name, count, type, status) => {
    await withEditWorld(async (w) => {
      await seed(w, [person(60)]);
      fill(w, ME, count, type, "A");
      fill(w, OTHER, 300, "life_dates", "B"); // another member's rows never count for this one
      const r = await suggest(w, ME, 60, { birth: { year: 1850 } });
      expect(r.status).toBe(status);
      if (status === 429) expect(r.body.error).toBe("rate_limited");
    });
  });
});
