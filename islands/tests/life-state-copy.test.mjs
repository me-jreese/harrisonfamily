// HFY-TSK-427 (lifeStateV1, display only): the copy, the client loader and the models that say "status unknown". Synthetic data only.
import { test } from "node:test";
import assert from "node:assert/strict";
import { FLAG, HELP_FILL_IN_COPY, HELP_FILL_IN_HREF, NO_BIRTH_YEAR_COPY, STATUS_UNKNOWN_COPY, isStatusUnknown, unknownLine } from "../src/lib/life-state-copy.js";
import { EMPTY, forgetLifeState, loadLifeState, readLifeState } from "../src/lib/life-state-client.js";
import { parseGraph } from "../src/lib/family-graph.js";
import { loadGraph, yearsLabel } from "../src/lib/tree-data.js";
import { markLifeState } from "../src/lib/life-state-graph.js";
import { markOf, tableOf } from "../src/lib/lifelines-model.js";
import { lineText } from "../src/lib/life-dates-model.js";
import { mapPerson } from "../src/lib/people-corpus.js";

const NOW = new Date("2026-11-27T12:00:00Z");
const on = (evidence = [], confirmed = []) => readLifeState({ asOf: "2026-11-27", evidence, confirmed }, NOW);

test("the copy constants", () => {
  assert.equal(FLAG, "lifeStateV1");
  assert.equal(STATUS_UNKNOWN_COPY, "status unknown");
  assert.equal(NO_BIRTH_YEAR_COPY, "birth year unknown");
  assert.equal(HELP_FILL_IN_COPY, "help fill in");
  assert.equal(HELP_FILL_IN_HREF, "/me/dates/");
  assert.equal(unknownLine(1920), "born 1920 · status unknown");
  assert.equal(unknownLine("1920", { about: true }), "born about 1920 · status unknown");
  assert.equal(unknownLine(null), "birth year unknown");
  assert.equal(unknownLine(0, { extra: ["Riverton"] }), "birth year unknown · Riverton");
  assert.equal(unknownLine(1920, { extra: ["Riverton"] }), "born 1920 · Riverton · status unknown");
  assert.ok(!/\b(event|role|record)\b/.test([STATUS_UNKNOWN_COPY, NO_BIRTH_YEAR_COPY, HELP_FILL_IN_COPY].join(" ")), "house voice");
});

test("isStatusUnknown: the rule, and never for flag off or a person the data does not call living", () => {
  const old = { id: "I9001", living: true, birthYear: 1920 };
  assert.equal(isStatusUnknown(on(), old), true);
  assert.equal(isStatusUnknown(on(), { id: "I9002", living: true, birthYear: 1990 }), false, "under 85");
  assert.equal(isStatusUnknown(on(), { id: "I9003", living: true, birthYear: null }), true, "no birth year, no evidence");
  assert.equal(isStatusUnknown(on([{ person: "I9001", at: "2026-06-01" }]), old), false, "an active member over 85 is living");
  assert.equal(isStatusUnknown(on([], [{ person: "I9001", at: "2026-06-01" }]), old), false, "confirmed living");
  assert.equal(isStatusUnknown(on([{ person: "I9001", at: "2020-01-01" }]), old), true, "evidence older than 24 months is not evidence");
  assert.equal(isStatusUnknown({ enabled: false }, old), false, "flag off");
  assert.equal(isStatusUnknown(null, old), false);
  assert.equal(isStatusUnknown(on(), { ...old, living: false }), false, "deceased by the published data");
  assert.equal(isStatusUnknown(on(), { ...old, living: undefined }), false);
});

test("readLifeState: newest day per person, malformed entries dropped, a bad body is no evidence", () => {
  const r = readLifeState({ evidence: [{ person: "I1", at: "2026-01-01" }, { person: "I1", at: "2026-03-01" }, { person: 7, at: "2026-03-01" }, { person: "I2", at: "soon" }], confirmed: "no" }, NOW);
  assert.deepEqual(r.evidence, { I1: "2026-03-01" });
  assert.deepEqual(r.confirmed, {});
  assert.equal(r.enabled, true);
  for (const bad of [null, undefined, [], "x", 3]) assert.deepEqual(readLifeState(bad, NOW).evidence, {});
  assert.ok(Object.isFrozen(EMPTY));
});

test("loadLifeState: flag off asks for nothing; on asks once; an error fails closed", async () => {
  let calls = 0;
  const off = await loadLifeState({ shared: false, flagOn: async () => false, get: async () => { calls += 1; return {}; } });
  assert.deepEqual(off, { enabled: false });
  assert.equal(calls, 0);
  forgetLifeState();
  const get = async (path) => { calls += 1; assert.equal(path, "/life-state"); return { evidence: [{ person: "I1", at: "2026-05-05" }], confirmed: [] }; };
  const a = loadLifeState({ flagOn: async () => true, get, now: () => NOW });
  const b = loadLifeState({ flagOn: async () => true, get, now: () => NOW });
  assert.equal(a, b, "memoised");
  assert.deepEqual((await a).evidence, { I1: "2026-05-05" });
  assert.equal(calls, 1);
  forgetLifeState();
  const failed = await loadLifeState({ flagOn: async () => true, get: async () => { throw new Error("401"); }, now: () => NOW });
  assert.equal(failed.enabled, true);
  assert.deepEqual(failed.evidence, {});
  assert.equal(isStatusUnknown(failed, { id: "I1", living: true, birthYear: 1920 }), true, "fail closed: over the threshold reads unknown");
  assert.equal(isStatusUnknown(failed, { id: "I1", living: true, birthYear: 2001 }), false);
  forgetLifeState();
});

const GRAPH = () => parseGraph({
  schemaVersion: 1, minor: 0, people: [
    { id: "I1", name: "Old Example", living: true, birthYear: 1920, deathYear: null, birthPlace: null, deathPlace: null },
    { id: "I2", name: "Nobirth Example", living: true, birthYear: null, deathYear: null, birthPlace: null, deathPlace: null },
    { id: "I3", name: "Active Example", living: true, birthYear: 1920, deathYear: null, birthPlace: null, deathPlace: null },
    { id: "I4", name: "Young Example", living: true, birthYear: 2000, deathYear: null, birthPlace: null, deathPlace: null },
    { id: "I5", name: "Gone Example", living: false, birthYear: 1900, deathYear: 1970, birthPlace: null, deathPlace: null }
  ], unions: []
});

test("markLifeState and the tree labels", async () => {
  const g = GRAPH();
  const before = JSON.stringify(g.people());
  await markLifeState(g, async () => ({ enabled: false }));
  assert.equal(JSON.stringify(g.people()), before, "flag off: nothing changes");
  assert.equal(yearsLabel(g.person("I1")), "born 1920");
  await markLifeState(g, async () => on([{ person: "I3", at: "2026-09-01" }]));
  assert.equal(g.person("I1").lifeUnknown, true);
  assert.equal(g.person("I2").lifeUnknown, true);
  for (const id of ["I3", "I4", "I5"]) assert.equal(g.person(id).lifeUnknown, undefined, id);
  assert.equal(g.person("I1").living, true, "the published flag is untouched");
  assert.equal(yearsLabel(g.person("I1")), "born 1920 · status unknown");
  assert.equal(yearsLabel(g.person("I2")), "birth year unknown");
  assert.equal(yearsLabel(g.person("I3")), "born 1920");
  assert.equal(yearsLabel(g.person("I5")), "1900 to 1970");
  await markLifeState(GRAPH(), async () => { throw new Error("boom"); }); // never rejects the load
});

test("lifelines: no open line to today and no 'living' word for an unknown person", async () => {
  const g = GRAPH();
  await markLifeState(g, async () => on([{ person: "I3", at: "2026-09-01" }]));
  assert.equal(markOf(g.person("I1"), 2026).kind, "dot");
  assert.equal(markOf(g.person("I1"), 2026).ongoing, false);
  assert.equal(markOf(g.person("I2"), 2026).kind, "none");
  assert.equal(markOf(g.person("I3"), 2026).ongoing, true, "an active member still runs to today");
  const rows = tableOf(g, { rows: ["I1", "I2", "I3"].map((id) => ({ type: "line", id, name: g.person(id).name, person: g.person(id) })) });
  assert.deepEqual(rows.map((r) => r.died), ["status unknown", "status unknown", "living"]);
});

test("life dates line", () => {
  const shown = { birth: { year: 1920, about: false, locked: false }, death: null };
  assert.equal(lineText(shown), "born 1920 · date of death unknown", "unchanged by default");
  assert.equal(lineText(shown, { unknown: true }), "born 1920 · status unknown");
  assert.equal(lineText({ birth: { year: 1920, about: true }, death: null }, { unknown: true }), "born about 1920 · status unknown");
  assert.equal(lineText({ birth: null, death: null }, { unknown: true }), "birth year unknown");
});

test("search: an unknown person is not 'living' to the filter and carries the unknown flag", () => {
  const raw = { grampsId: "I1", displayName: "Old Example", isLiving: true, lifespanSummary: "b. 1920" };
  assert.equal(mapPerson(raw).fields.living, true);
  assert.equal(mapPerson(raw).fields.life_unknown, false);
  const u = mapPerson({ ...raw, lifeUnknown: true });
  assert.equal(u.fields.living, false);
  assert.equal(u.fields.life_unknown, true);
  assert.equal(u.fields.birth_year, 1920);
  assert.equal(u.fields.death_year, null);
});

test("loadGraph marks only when asked, and the navigator-facing modules import no shared/ module", async () => {
  const body = JSON.stringify({ schemaVersion: 1, minor: 0, people: [{ id: "I1", name: "Old Example", living: true, birthYear: 1920, deathYear: null }], unions: [] });
  const fetcher = async () => new Response(body, { status: 200 });
  const plain = await loadGraph(fetcher);
  assert.equal(plain.graph.person("I1").lifeUnknown, undefined);
  const marked = await loadGraph(fetcher, { mark: (g) => markLifeState(g, async () => on()) });
  assert.equal(marked.graph.person("I1").lifeUnknown, true);
  const { readFileSync } = await import("node:fs");
  for (const f of ["tree-data.js", "life-state-words.js", "lifelines-model.js", "life-dates-model.js"]) {
    assert.ok(!/from "[^"]*shared\//.test(readFileSync(new URL(`../src/lib/${f}`, import.meta.url), "utf8")), `${f} stays out of shared/`);
  }
});
