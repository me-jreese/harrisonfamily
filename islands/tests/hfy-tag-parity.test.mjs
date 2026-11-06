// HFY-TSK-388-0G (pass 1): wire parity of the new tag adapter with the shipped tag editor (HFY-TSK-260). The three scenarios of HFY-TSK-283 (api/test/tag-edit-e2e.test.js,
// islands/tests/tag-edit-e2e.spec.mjs) are replayed through the adapter over a fake API that runs the real ops engine, and the POST /api/changes the adapter sends
// is compared with the one the shipped editor builds (buildTagOps + changesBody) for the same user action. Two differences are ruled and pinned at the end.
// The shipped editor also sends a dry run first, for its confirmation sheet; the adapter does not (pass 2 decides where the sheet goes).
import assert from "node:assert/strict";
import { test } from "node:test";
import { createHfyMediaSource } from "../src/lib/hfy-media-source.js";
import { memoryStore } from "../src/lib/tag-store.js";
import { emitRect } from "../src/lib/hfy-tag-wire.js";
import { buildTagOps, toGrampsRect } from "../src/lib/photo-tag-edit.js";
import { baseVersionsFor, changesBody, undoBody } from "../src/lib/editor-save.js";
import { createFakeApi } from "./support/fake-hfy-api.mjs";

const ME = "I0001";
const MOTHER = "I0003";
const KID = "I0006";
const MEDIA = "O0001";

function setup() {
  const w = createFakeApi({
    viewerPersonId: ME, media: [{ id: MEDIA }],
    people: [{ id: ME, name: "Alder Testwood" }, { id: MOTHER, name: "Hazel Birchwell" }, { id: KID, name: "Briar Testwood" }],
    tags: [[MOTHER, MEDIA, [10, 10, 40, 40]]],
  });
  const source = createHfyMediaSource({ fetch: w.fetch, viewer: async () => w.viewer, store: memoryStore(), people: w.people });
  const bundle = async (gid) => (await w.fetch(`/api/edit/Person/${gid}`)).json();
  const base = async () => (await source.getMedia(MEDIA)).version;
  const posts = () => w.calls.filter((c) => c.method === "POST");
  return { w, source, bundle, base, posts };
}
const shippedBody = (b, built) => changesBody({ target: b.key, version: b.version, ops: built.ops, baseVersions: baseVersionsFor(b, built.ops) });

test("scenario 1: a tag on another person's page is a proposal, the same request as the shipped editor's", async () => {
  const { w, source, bundle, base, posts } = setup();
  const b = await bundle(KID);
  const built = buildTagOps(b, { kind: "add", mediaHandle: w.handleOf(MEDIA), rect: [50, 50, 80, 80] });
  assert.equal(built.ok, true);
  const r = await source.putTags([{ op: "add", personId: KID, mediaId: MEDIA, rect: [50, 50, 80, 80], baseVersion: await base() }]);
  assert.deepEqual(posts().map((c) => c.body), [shippedBody(b, built)]);
  assert.match(posts()[0].headers["Idempotency-Key"], /^[0-9a-f]{36}$/);
  assert.deepEqual(r.applied, []);
  assert.deepEqual(r.proposed, [{ personId: KID, mediaId: MEDIA, rect: [50, 50, 80, 80], index: 0, state: "pending-proposal" }]);
  assert.deepEqual(w.refs(KID), [], "not a tag yet");
  assert.equal(w.proposals.length, 1);
});

test("scenario 2: a tag on my own page saves now, and the undo the API handed back removes it (same bodies)", async () => {
  const { w, source, bundle, base, posts } = setup();
  const b = await bundle(ME);
  const built = buildTagOps(b, { kind: "add", mediaHandle: w.handleOf(MEDIA), rect: [50, 50, 80, 80] });
  const r = await source.putTags([{ op: "add", personId: ME, mediaId: MEDIA, rect: [50, 50, 80, 80], baseVersion: await base() }]);
  assert.deepEqual(posts()[0].body, shippedBody(b, built));
  assert.deepEqual(r.applied, [{ personId: ME, mediaId: MEDIA, rect: [50, 50, 80, 80], index: 0, state: "applied" }]);
  assert.equal(w.proposals.length, 0);
  assert.deepEqual(w.refs(ME).map((x) => x.rect), [[50, 50, 80, 80]]);
  const receipt = r.receipts[0];
  await source.undoReceipt(receipt);
  assert.deepEqual(posts()[1].body, undoBody({ target: b.key, undo: receipt.undo }));
  assert.deepEqual(w.refs(ME), []);
  assert.equal(w.person(ME).version, 3);
});

test("scenario 3: a stale tag is a conflict and never moves another rectangle", async () => {
  const { w, source, bundle, base, posts } = setup();
  const move = (baseVersion) => ({ op: "move", personId: MOTHER, mediaId: MEDIA, index: 0, from: [10, 10, 40, 40], to: [12, 10, 42, 40], baseVersion });
  const old = await base();
  w.bump(MOTHER, (o) => { o.media_list[0].rect = [20, 20, 50, 50]; }); // a Gramps sync moves it after the editor read it
  assert.deepEqual((await source.putTags([move(old)])).conflicts.length, 1, "stale base version");
  const fresh = await base();
  assert.deepEqual((await source.putTags([move(fresh)])).conflicts.length, 1, "the version is current, the tag at that index is not the one that was drawn");
  assert.equal(posts().length, 0, "nothing was sent");
  assert.deepEqual(w.refs(MOTHER)[0].rect, [20, 20, 50, 50]);
  assert.equal(w.proposals.length, 0);
  assert.deepEqual(buildTagOps(await bundle(MOTHER), { kind: "move", mediaHandle: w.handleOf(MEDIA), from: [10, 10, 40, 40], rect: [12, 10, 42, 40] }), { ok: false, reason: "stale" });
});

test("scenario 3b: the record changes between the read and the post: the server's 409 is a conflict in the result", async () => {
  const { w, source, base, posts } = setup();
  const baseVersion = await base();
  w.hooks.beforeChanges = (p) => w.bump(p.gid, () => {});
  const r = await source.putTags([{ op: "move", personId: MOTHER, mediaId: MEDIA, index: 0, from: [10, 10, 40, 40], to: [12, 10, 42, 40], baseVersion }]);
  assert.equal(r.conflicts.length, 1);
  assert.equal(posts().length, 1);
  assert.deepEqual(w.refs(MOTHER)[0].rect, [10, 10, 40, 40]);
});

test("move and remove are the shipped editor's requests too", async () => {
  const { w, source, bundle, base, posts } = setup();
  const b = await bundle(MOTHER);
  const mv = buildTagOps(b, { kind: "move", mediaHandle: w.handleOf(MEDIA), from: [10, 10, 40, 40], rect: [12, 10, 42, 40] });
  const rm = buildTagOps(b, { kind: "remove", mediaHandle: w.handleOf(MEDIA), from: [10, 10, 40, 40] });
  const baseVersion = await base();
  const r1 = await source.putTags([{ op: "move", personId: MOTHER, mediaId: MEDIA, index: 0, from: [10, 10, 40, 40], to: [12, 10, 42, 40], baseVersion }]);
  const r2 = await source.putTags([{ op: "remove", personId: MOTHER, mediaId: MEDIA, index: 0, rect: [10, 10, 40, 40], baseVersion }]);
  assert.deepEqual(posts().map((c) => c.body), [shippedBody(b, mv), shippedBody(b, rm)]);
  assert.equal(r1.proposed[0].state, "pending-proposal");
  assert.equal(r2.proposed[0].index, 0, "a proposed removal names the tag it would remove");
});

test("RULED DIFFERENCE 1: a rect is rounded to the nearest whole percent, half up (P4-R16); the shipped editor rounds outward", () => {
  assert.deepEqual(toGrampsRect([12.5, 7.5, 58.5, 93.5]), [12, 7, 59, 94]);
  assert.deepEqual(emitRect([12.5, 7.5, 58.5, 93.5]), [13, 8, 59, 94]);
  assert.deepEqual(emitRect([10.6, 10, 40.4, 40]), [11, 10, 40, 40]);
  assert.deepEqual(toGrampsRect([10.6, 10, 40.4, 40]), [10, 10, 41, 40]);
});

test("RULED DIFFERENCE 2: add appends; the shipped editor refuses a second tag with an identical rect (D-04, T-9)", async () => {
  const { w, source, bundle, base, posts } = setup();
  const same = { kind: "add", mediaHandle: w.handleOf(MEDIA), rect: [10, 10, 40, 40] };
  assert.deepEqual(buildTagOps(await bundle(MOTHER), same), { ok: false, reason: "exists" });
  // A rect that differs appends where the shipped editor would also have added it.
  const r = await source.putTags([{ op: "add", personId: MOTHER, mediaId: MEDIA, rect: [11, 10, 40, 40], baseVersion: await base() }]);
  assert.equal(r.proposed[0].index, 1);
  // Byte-identical: the adapter does not refuse it as the editor does, but the ops engine's add is idempotent, so nothing is sent (BASELINE row T-9 stays a known fail).
  const before = posts().length;
  const twin = await source.putTags([{ op: "add", personId: MOTHER, mediaId: MEDIA, rect: [10, 10, 40, 40], baseVersion: await base() }]);
  assert.equal(twin.identical.length, 1);
  assert.equal(posts().length, before);
});
