// HFY-TSK-388-0G (pass 1): the tag ports of the HFY adapter over a fake HFY API that runs the real ops engine. Part 1 runs the kit's own conformance fixtures
// (@io-kit/media/testing TAG_FIXTURES, shared with the repo suite in tests/tagging) against the adapter; part 2 pins what HFY policy changes (D-13) and the
// adapter's own behaviour: names, the picker rule, self-untag, the offline queue. Synthetic ids and names only.
import assert from "node:assert/strict";
import { test } from "node:test";
import { FIXTURE_WORLD, TAG_FIXTURES } from "@io-kit/media/testing";
import { createHfyMediaSource } from "../src/lib/hfy-media-source.js";
import { createTagQueue, createTagStore, memoryStore } from "../src/lib/tag-store.js";
import { createFakeApi, fakeIndexedDB } from "./support/fake-hfy-api.mjs";

function harness(seed = FIXTURE_WORLD, { admin = false, store = memoryStore() } = {}) {
  const world = createFakeApi(seed, { admin });
  const source = createHfyMediaSource({ fetch: world.fetch, viewer: async () => world.viewer, store, people: world.people, now: () => "2026-11-06T00:00:00.000Z" });
  return { world, source, store, actAs: (p) => { world.viewer = p; }, audit: () => source.auditLog() };
}
const ADA = "fx-ada";
const BO = "fx-bo";
const add = async (src, personId, mediaId, rect) => src.putTags([{ op: "add", personId, mediaId, rect, baseVersion: (await src.getMedia(mediaId)).version }]);

// ---- part 1: the kit's fixtures. The harness acts with admin rights, because the fixtures tag other people and expect it to save now; the proposal route is pinned below.
// T-13 (portrait) is the adapter's 0A suite; T-15, T-17 and T-18 are consent rows the kit's reference policy enforces and HFY policy relaxes (D-13): see part 2.
// T-9 is a known fail: its second step adds an IDENTICAL rect and expects an append (D-04), but the ops engine's `add` is idempotent for a byte-identical MediaRef (api/src/records/ops.js,
// "an identical element is present"), so the wire cannot append it (docs/reference/BASELINE.md). The test asserts it still fails, so a fix on the API side must update this list.
const KNOWN_FAIL = new Set(["T-9"]);
for (const fx of TAG_FIXTURES) {
  if (["T-13", "T-15", "T-17", "T-18"].includes(fx.id)) continue;
  test(`kit conformance ${fx.id}: ${fx.title}${KNOWN_FAIL.has(fx.id) ? " [known-fail]" : ""}`, async () => {
    const h = harness(FIXTURE_WORLD, { admin: true });
    if (KNOWN_FAIL.has(fx.id)) {
      await assert.rejects(fx.run(h), undefined, `${fx.id} now passes: remove it from KNOWN_FAIL and update docs/reference/BASELINE.md`);
      return;
    }
    const r = await fx.run(h);
    assert.ok(r.status === "pass" || r.status === "todo", `${fx.id} ${r.status}`);
  });
}

test("T-9 on the wire: a new tag lands at index 2 and a different rect appends; an identical one writes nothing and says so", async () => {
  const h = harness(FIXTURE_WORLD, { admin: true });
  assert.equal((await add(h.source, BO, "fx-m3", [30, 30, 40, 40])).applied[0].index, 2);
  assert.equal((await add(h.source, BO, "fx-m3", [31, 30, 41, 40])).applied[0].index, 3);
  const before = h.world.calls.filter((c) => c.method === "POST").length;
  const again = await add(h.source, BO, "fx-m3", [30, 30, 40, 40]);
  assert.equal(again.identical.length, 1);
  assert.equal(again.applied[0].index, 2, "the tag that is already there");
  assert.equal(h.world.calls.filter((c) => c.method === "POST").length, before, "no request");
  assert.equal(h.world.refs(BO).filter((r) => r.ref === h.world.handleOf("fx-m3")).length, 2);
});

// ---- part 2: HFY policy and the adapter's own rules
test("T-15 under HFY policy: everyone visible is taggable and listed (D-13)", async () => {
  const h = harness(FIXTURE_WORLD, { admin: true });
  assert.deepEqual((await h.source.resolvePeople("")).map((p) => p.personId).sort(), ["fx-ada", "fx-bo", "fx-cy"]);
  assert.equal((await add(h.source, "fx-cy", "fx-m1", [10, 10, 20, 20])).applied.length, 1);
});

test("T-17 under HFY policy: the re-add lock is audit-only; the subject's own re-add succeeds", async () => {
  const h = harness();
  const tag = (await add(h.source, ADA, "fx-m1", [30, 47, 34, 54])).applied[0];
  await h.source.consent.selfUntag(ADA, "fx-m1", tag.index);
  h.actAs(BO);
  const other = await add(h.source, ADA, "fx-m1", [30, 47, 34, 54]);
  assert.equal(other.proposed.length, 1, "not blocked: another member's tag on ADA's page is a proposal like any other");
  assert.equal(h.audit().some((a) => a.action === "re-add-lock-audit" && a.personId === ADA), true);
  h.actAs(ADA);
  assert.equal((await add(h.source, ADA, "fx-m1", [30, 47, 34, 54])).applied.length, 1);
});

test("T-18 under HFY policy: hideAll is a no-op", async () => {
  const h = harness();
  await h.source.consent.hideAll(BO);
  assert.equal((await h.source.getTags("fx-m1")).some((t) => t.personId === BO), true);
});

test("a tag carries exactly personId, mediaId, rect, index and state; names (living or deceased) come from readTags", async () => {
  const h = harness({ ...FIXTURE_WORLD, people: [...FIXTURE_WORLD.people, { id: "fx-lv", name: "Real Living Name", living: true }], tags: [...FIXTURE_WORLD.tags, ["fx-lv", "fx-m1", [40, 40, 60, 60]]] });
  const tags = await h.source.getTags("fx-m1");
  for (const t of tags) assert.deepEqual(Object.keys(t).sort(), ["index", "mediaId", "personId", "rect", "state"]);
  const { names, version } = await h.source.readTags("fx-m1");
  assert.deepEqual(names["fx-lv"], { displayName: "Real Living Name" }, "a living person is named like any other (P4-R37)");
  assert.deepEqual(names["fx-bo"], { displayName: "Bo Fixture" });
  assert.equal(typeof version, "string");
  assert.equal(JSON.stringify(tags).includes("Real Living Name"), false);
});

test("the picker offers every member, living or deceased, 'you' first, with a photo URL when there is one (P4-R37)", async () => {
  const seed = { viewerPersonId: "I0003", media: [{ id: "O0001" }], people: [
    { id: "I0001", name: "Alder Testwood", living: true }, { id: "I0002", name: "Alma Testwood", living: true },
    { id: "I0003", name: "Hazel Birchwell", photo: "/img/hazel.jpg" }, { id: "I0004", name: "Ash Birchwell" },
  ] };
  const h = harness(seed);
  const all = await h.source.resolvePeople("");
  assert.deepEqual(all.map((p) => p.personId), ["I0003", "I0001", "I0002", "I0004"], "the viewer first, then everyone else, living or not");
  assert.equal(all.find((p) => p.personId === "I0003").thumbUrl, "/img/hazel.jpg");
  assert.equal("thumbUrl" in all.find((p) => p.personId === "I0004"), false, "no photo, no thumbUrl");
  assert.deepEqual((await h.source.resolvePeople("alder")).map((p) => p.personId), ["I0001"]);
  assert.deepEqual((await h.source.resolvePeople("alma")).map((p) => p.personId), ["I0002"], "a living member who is not you is offered when searched by name");
  assert.deepEqual((await h.source.resolvePeople("hazel")).map((p) => p.personId), ["I0003"]);
  assert.deepEqual((await h.source.resolvePeople("", { limit: 2 })).map((p) => p.personId), ["I0003", "I0001"]);
});

test("errors: an unknown media is NOT_FOUND, a bad rect is INVALID_RECT before anything is sent", async () => {
  const h = harness();
  await assert.rejects(h.source.getTags("nope"), (e) => e.code === "NOT_FOUND");
  h.world.calls.length = 0;
  await assert.rejects(h.source.putTags([{ op: "add", personId: ADA, mediaId: "fx-m1", rect: [10, 10, 11, 11], baseVersion: "x" }]), (e) => e.code === "INVALID_RECT");
  assert.equal(h.world.calls.length, 0);
});

test("a stale base version is a conflict and nothing is written", async () => {
  const h = harness(FIXTURE_WORLD, { admin: true });
  const before = JSON.stringify(h.world.refs(ADA));
  const r = await h.source.putTags([{ op: "add", personId: ADA, mediaId: "fx-m1", rect: [10, 10, 20, 20], baseVersion: "old" }]);
  assert.equal(r.conflicts.length, 1);
  assert.equal(JSON.stringify(h.world.refs(ADA)), before);
  assert.equal(h.world.calls.some((c) => c.method === "POST"), false);
});

test("selfUntag: only the subject, an audit record that can be undone, a lock, a note on the change", async () => {
  const h = harness();
  const tag = (await add(h.source, ADA, "fx-m1", [30, 47, 34, 54])).applied[0];
  h.actAs(BO);
  await assert.rejects(h.source.consent.selfUntag(ADA, "fx-m1", tag.index), (e) => e.code === "FORBIDDEN");
  h.actAs(ADA);
  await h.source.consent.selfUntag(ADA, "fx-m1", tag.index);
  assert.equal(h.world.refs(ADA).length, 0);
  assert.equal(h.world.calls.filter((c) => c.method === "POST").pop().body.note.length > 0, true);
  const [entry] = await h.source.selfUntags();
  assert.deepEqual([entry.action, entry.personId, entry.mediaId, entry.index, entry.reversible], ["self-untag", ADA, "fx-m1", tag.index, true]);
  assert.deepEqual(entry.rect, [30, 47, 34, 54]);
  assert.equal(entry.lock, `${ADA}|fx-m1`);
  await h.source.undoSelfUntag(entry);
  assert.deepEqual(h.world.refs(ADA).map((r) => r.rect), [[30, 47, 34, 54]]);
  assert.deepEqual(await h.source.selfUntags(), []);
});

test("selfUntag falls back to a fresh add when the server's undo no longer applies", async () => {
  const h = harness();
  const tag = (await add(h.source, ADA, "fx-m1", [30, 47, 34, 54])).applied[0];
  await h.source.consent.selfUntag(ADA, "fx-m1", tag.index);
  h.world.bump(ADA, () => {}); // the record moved on: the stored undo has an old base version
  const [entry] = await h.source.selfUntags();
  await h.source.undoSelfUntag(entry);
  assert.deepEqual(h.world.refs(ADA).map((r) => r.rect), [[30, 47, 34, 54]]);
});

test("the offline queue persists in IndexedDB, survives a new store, and flushes in order", async () => {
  const idb = fakeIndexedDB();
  const q1 = createTagQueue({ store: createTagStore({ indexedDB: idb, name: "t" }) });
  const h = harness(FIXTURE_WORLD, { admin: true });
  const version = (await h.source.getMedia("fx-m6")).version;
  const op = { op: "add", personId: ADA, mediaId: "fx-m6", rect: [50, 50, 60, 60], baseVersion: version };
  await q1.onQueueChange([op]);
  const q2 = createTagQueue({ store: createTagStore({ indexedDB: idb, name: "t" }) });
  assert.deepEqual(await q2.load(), [op]);
  const seen = [];
  q2.subscribe((p) => seen.push(p.length));
  const out = await q2.flush(h.source);
  assert.equal(out.applied.length, 1);
  assert.deepEqual(q2.pending(), []);
  assert.deepEqual(seen, [0]);
});

test("the queue keeps ops on a network failure and drops a stale op as a conflict", async () => {
  const h = harness(FIXTURE_WORLD, { admin: true });
  const q = createTagQueue({ store: memoryStore() });
  await q.onQueueChange([{ op: "add", personId: ADA, mediaId: "fx-m6", rect: [50, 50, 60, 60], baseVersion: "stale" }]);
  const offline = createHfyMediaSource({ fetch: async () => { throw new Error("offline"); }, viewer: async () => ADA, store: memoryStore() });
  assert.equal((await q.flush(offline)).kept, 1);
  assert.equal(q.pending().length, 1);
  const out = await q.flush(h.source);
  assert.equal(out.conflicts.length, 1);
  assert.deepEqual(q.pending(), []);
});

test("with no IndexedDB the store falls back to memory and never throws", async () => {
  const s = createTagStore({ indexedDB: null });
  assert.equal(s.kind, "memory");
  await s.set("k", [1]);
  assert.deepEqual(await s.get("k"), [1]);
});
