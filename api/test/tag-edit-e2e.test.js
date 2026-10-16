// HFY-TSK-283 (tag-edit-e2e): the photo tagging scenarios end to end through the real API over the fake store (edit-e2e-world.js, `{ photo: true }`).
// The same three scenarios run through the real lightbox in islands/tests/tag-edit-e2e.spec.mjs; this file is the contract that page relies on.
// The ops are the ones the island builds (buildTagOps). Synthetic ids, placeholder names only.
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ADMIN, ME, createEditWorld, key } from "./edit-e2e-world.js";
import { buildTagOps } from "../../islands/src/lib/photo-tag-edit.js";

let w;
beforeEach(async () => { w = await createEditWorld({ photo: true }); });
afterEach(() => w.dispose());

const bundle = async (who, obj) => {
  const r = await w.call("GET", `/api/edit/Person/${obj.gramps_id}`, who);
  expect(r.status, JSON.stringify(r.body)).toBe(200);
  return r.body;
};
const post = (who, body, idem) => w.call("POST", "/api/changes", who, { body, headers: idem ? { "idempotency-key": idem } : {} });
const decide = (who, p, body, idem) => w.call("POST", `/api/proposals/${p.id}/decision`, who, { body, headers: { "if-match": `"${p.etag}"`, "idempotency-key": idem } });
const refs = (obj) => (w.stored("Person", obj.handle).media_list || []).filter((m) => m.ref === w.pic.handle);
const bodyOf = (b, built) => ({ target: b.key, base_versions: { [b.key]: b.version }, ops: built.ops });

describe("scenario 1: a tag on another person is a proposal; once approved it is on their record", () => {
  it("stores a proposal only, an admin approves it, and the edit bundle then carries the tag", async () => {
    const b = await bundle(ME, w.kid);
    const built = buildTagOps(b, { kind: "add", mediaHandle: w.pic.handle, rect: [50.2, 50, 80, 80.4] });
    expect(built.ok).toBe(true);
    const dry = await post(ME, { ...bodyOf(b, built), dry_run: true });
    expect(dry.body.plan.direct).toEqual([]);
    expect(dry.body.plan.review.map((g) => g.opIds)).toEqual([["tag.add"]]);
    const sent = await post(ME, bodyOf(b, built), "tag-other");
    expect(sent.status, JSON.stringify(sent.body)).toBe(201);
    expect(sent.body.applied ?? null).toBeNull();
    expect(sent.body.proposal).toMatchObject({ state: "pending", proposer: { id: ME } });
    expect(refs(w.kid)).toEqual([]); // not a tag yet
    expect(w.version("Person", w.kid.handle)).toBe(1);

    const done = await decide(ADMIN, sent.body.proposal, { verdict: "approve" }, "tag-other-d");
    expect(done.status, JSON.stringify(done.body)).toBe(200);
    expect(done.body.proposal.state).toBe("approved");
    expect(refs(w.kid)).toHaveLength(1);
    expect(refs(w.kid)[0].rect).toEqual(built.rect);
    const after = await bundle(ME, w.kid);
    expect(after.version).toBe(2);
    expect(after.obj.media_list.map((m) => m.rect)).toEqual([built.rect]);
  });
});

describe("scenario 2: a tag on my own record saves now, and the undo takes it off", () => {
  it("saves directly with no proposal, and the inverse the API handed back removes it", async () => {
    const b = await bundle(ME, w.me);
    const built = buildTagOps(b, { kind: "add", mediaHandle: w.pic.handle, rect: [50, 50, 80, 80] });
    const saved = await post(ME, bodyOf(b, built), "tag-own");
    expect(saved.status, JSON.stringify(saved.body)).toBe(201);
    expect(saved.body.proposal ?? null).toBeNull();
    expect(refs(w.me)).toHaveLength(1);
    expect(w.rows("PROP#")).toEqual([]);
    const { undo } = saved.body.applied;
    const undone = await post(ME, { target: key(w.me), base_versions: undo.base_versions, ops: undo.ops }, "tag-own-undo");
    expect(undone.status, JSON.stringify(undone.body)).toBe(201);
    expect(refs(w.me)).toEqual([]);
    expect(w.version("Person", w.me.handle)).toBe(3);
  });
});

describe("scenario 3: a stale tag key is a conflict and never moves another rectangle", () => {
  it("a move aimed at a tag that has since changed is refused, and nothing is stored or proposed", async () => {
    const b = await bundle(ME, w.mother);
    const built = buildTagOps(b, { kind: "move", mediaHandle: w.pic.handle, from: [10, 10, 40, 40], rect: [12, 10, 42, 40] });
    expect(built.ok).toBe(true);
    // the tag moves after the editor read it (a Gramps sync)
    const moved = JSON.parse(JSON.stringify(w.stored("Person", w.mother.handle)));
    moved.media_list[0].rect = [20, 20, 50, 50];
    await w.bump(moved, w.version("Person", w.mother.handle));
    const r = await post(ME, bodyOf(b, built), "tag-stale"); // the old version
    expect(r.status).toBe(409);
    expect(r.body.error).toBe("version_conflict");
    // even with the version refreshed, the old key's hash no longer names the stored element
    const fresh = await bundle(ME, w.mother);
    const retry = await post(ME, { target: fresh.key, base_versions: { [fresh.key]: fresh.version }, ops: built.ops }, "tag-stale-2");
    expect(retry.status).toBe(409);
    expect(refs(w.mother)[0].rect).toEqual([20, 20, 50, 50]);
    expect(w.rows("PROP#")).toEqual([]);
    // and the editor's own planning on the fresh bundle reports it stale without sending anything
    expect(buildTagOps(fresh, { kind: "move", mediaHandle: w.pic.handle, from: [10, 10, 40, 40], rect: [12, 10, 42, 40] })).toMatchObject({ ok: false, reason: "stale" });
  });
});
