// HFY-TSK-282 (edit-e2e-d11-audit): the editing scenarios end to end through the real API over the fake store (edit-e2e-world.js).
// The same five scenarios run through the real pages in islands/tests/edit-e2e.spec.mjs; this file is the contract those pages rely on.
// Synthetic ids, placeholder names and years only.
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ADMIN, ADMIN2, ME, P, createEditWorld, key } from "./edit-e2e-world.js";

const set = (o, path, base, value, id) => ({ id, op: "set", obj: key(o), path, base, value });
const stub = (given, surname, extra = {}) => ({ given, surname, gender: "male", birthYear: null, living: "unknown", deathYear: null, ...extra });
const PHONE = "212-555-0143";

let w;
let worlds = [];
beforeEach(async () => { w = await createEditWorld(); worlds.push(w); });
afterEach(() => { for (const x of worlds) x.dispose(); worlds = []; });

const bundle = async (who, ref = ME) => {
  const r = await w.call("GET", `/api/edit/Person/${ref}`, who);
  expect(r.status, JSON.stringify(r.body)).toBe(200);
  return r.body;
};
const post = (who, body, idem) => w.call("POST", "/api/changes", who, { body, headers: idem ? { "idempotency-key": idem } : {} });
const decide = (who, p, body, idem) => w.call("POST", `/api/proposals/${p.id}/decision`, who, { body, headers: { "if-match": `"${p.etag}"`, "idempotency-key": idem } });
const err = (r) => ({ status: r.status, error: r.body?.error });

describe("scenario 1: my own nickname saves now, then undo", () => {
  it("saves directly, the bundle shows it at version +1, and the undo the API handed back restores it", async () => {
    const before = await bundle(ME);
    expect(before.version).toBe(1);
    expect(before.obj.primary_name.nick).toBe("");
    const saved = await post(ME, { target: key(w.me), base_versions: { [key(w.me)]: 1 }, ops: [set(w.me, "/primary_name/nick", "", "Ally", "nick")] }, "own-nick");
    expect(saved.status, JSON.stringify(saved.body)).toBe(201);
    expect(saved.body.proposal).toBeNull();
    expect(saved.body.applied.versions).toEqual({ [key(w.me)]: 2 });
    const after = await bundle(ME);
    expect(after.version).toBe(2);
    expect(after.obj.primary_name.nick).toBe("Ally");
    expect(w.rows("PROP#")).toEqual([]); // nothing waits for review

    const { undo } = saved.body.applied;
    const undone = await post(ME, { target: key(w.me), base_versions: undo.base_versions, ops: undo.ops }, "own-nick-undo");
    expect(undone.status, JSON.stringify(undone.body)).toBe(201);
    const restored = await bundle(ME);
    expect(restored.obj.primary_name.nick).toBe("");
    expect(restored.version).toBe(3); // an undo is an ordinary audited change, not a rewind
    expect(w.rows("AUDIT#records:").length).toBeGreaterThanOrEqual(2);
  });
});

describe("scenario 2: a given-name change becomes a proposal and an admin approves it", () => {
  it("leaves the page alone until approval, then the bundle shows version +1 and the proposer's credit", async () => {
    const r = await post(ME, { target: key(w.me), base_versions: { [key(w.me)]: 1 }, note: "the spelling on my certificate", ops: [set(w.me, "/primary_name/first_name", "Alder", "Aldric", "first")] }, "given-1");
    expect(r.status, JSON.stringify(r.body)).toBe(201);
    expect(r.body.applied).toBeNull();
    expect(r.body.proposal).toMatchObject({ state: "pending", proposer: { id: ME } });
    expect((await bundle(ME)).obj.primary_name.first_name).toBe("Alder");
    expect((await bundle(ME)).version).toBe(1);
    expect((await bundle(ME)).pending).toHaveLength(1);

    const queue = await w.call("GET", "/api/proposals", ADMIN, { query: { view: "queue" } });
    expect(queue.body.items.map((p) => p.id)).toEqual([r.body.proposal.id]);
    expect(err(await w.call("GET", "/api/proposals", OTHER_MEMBER, { query: { view: "queue" } })).status).toBe(403);

    const done = await decide(ADMIN, r.body.proposal, { verdict: "approve" }, "decide-1");
    expect(done.status, JSON.stringify(done.body)).toBe(200);
    expect(done.body.proposal.state).toBe("approved");
    const after = await bundle(ME);
    expect(after.version).toBe(2);
    expect(after.obj.primary_name.first_name).toBe("Aldric");
    expect(after.pending).toEqual([]);
    expect(done.body.proposal.proposer).toMatchObject({ id: ME }); // the proposer stays credited after the admin decides
    const audit = w.rows(`AUDIT#proposal:${r.body.proposal.id}`);
    expect(audit.find((x) => x.op === "proposal.create").principal).toBe(ME); // the audit row names the proposer
    expect(audit.map((x) => x.op)).toContain("proposal.decide");
  });
});
const OTHER_MEMBER = "I0002";

describe("scenario 3: a stale proposal is updated by its proposer and then approved", () => {
  it("goes stale when the page moves on, comes back to pending when the proposer re-bases it, and applies", async () => {
    const r = await post(ME, { target: key(w.me), base_versions: { [key(w.me)]: 1 }, ops: [set(w.me, "/primary_name/first_name", "Alder", "Aldric", "first")] }, "stale-1");
    const p = r.body.proposal;
    await w.bump({ ...w.stored("Person", w.me.handle), primary_name: { ...w.me.primary_name, first_name: "Alden" } }, 1); // a Gramps sync renames the same field
    const refused = await decide(ADMIN, p, { verdict: "approve" }, "stale-d1");
    expect(err(refused)).toEqual({ status: 409, error: "rebase_conflict" });
    const stale = refused.body.details.proposal;
    expect(stale.state).toBe("stale");
    expect(w.stored("Person", w.me.handle).primary_name.first_name).toBe("Alden"); // nothing was written to the page

    // the proposer opens it, sees the conflict, and sends the same change on top of what is there now
    const mine = await w.call("GET", `/api/proposals/${p.id}`, ME);
    expect(mine.body.rebase.status).toBe("conflict");
    const amended = await w.call("PATCH", `/api/proposals/${p.id}`, ME, {
      body: { base_versions: { [key(w.me)]: 2 }, ops: [set(w.me, "/primary_name/first_name", "Alden", "Aldric", "first")] },
      headers: { "if-match": `"${stale.etag}"` },
    });
    expect(amended.status, JSON.stringify(amended.body)).toBe(200);
    expect(amended.body).toMatchObject({ state: "pending", rev: 2 });

    const done = await decide(ADMIN2, amended.body, { verdict: "approve" }, "stale-d2");
    expect(done.status, JSON.stringify(done.body)).toBe(200);
    const after = await bundle(ME);
    expect(after.obj.primary_name.first_name).toBe("Aldric");
    expect(after.version).toBe(3);
  });
});

describe("scenario 4: the parents wizard is approved and both sides of every link are present", () => {
  it("files a relationship proposal, and the approval writes the family, its parents, its child and the new person's side", async () => {
    const intent = { type: "parents", person: P(1), parents: [{ who: { ref: P(3) }, rel: "birth" }, { who: { new: stub("Moss", "Testwood", { birthYear: 1960 }) }, rel: "birth" }] };
    const preview = await w.call("POST", "/api/relationships/preview", ME, { body: { intent } });
    expect(preview.status, JSON.stringify(preview.body)).toBe(200);
    expect(preview.body.route).toBe("proposal");
    const sent = await w.call("POST", "/api/relationships", ME, { body: { intent, confirmDistinct: [] }, headers: { "idempotency-key": "wiz-1" } });
    expect(sent.status, JSON.stringify(sent.body)).toBe(201);
    expect(sent.body.proposal).toMatchObject({ kind: "relationship", state: "pending" });
    expect(w.stored("Person", w.me.handle).parent_family_list).toEqual([]); // nothing yet

    const done = await decide(ADMIN, sent.body.proposal, { verdict: "approve" }, "wiz-d1");
    expect(done.status, JSON.stringify(done.body)).toBe(200);
    const created = Object.entries(done.body.applied.versions).filter(([, v]) => v === 1).map(([k]) => k);
    const famKey = created.find((k) => k.startsWith("Family:"));
    const fatherKey = created.find((k) => k.startsWith("Person:"));
    expect(famKey && fatherKey).toBeTruthy();
    const famObj = w.stored("Family", famKey.split(":")[1]);
    const fatherHandle = fatherKey.split(":")[1];
    const kidSide = w.stored("Person", w.me.handle);
    const motherSide = w.stored("Person", w.mother.handle);
    const fatherSide = w.stored("Person", fatherHandle);
    // the family names both parents and the child ...
    expect([famObj.father_handle, famObj.mother_handle].sort()).toEqual([fatherHandle, w.mother.handle].sort());
    expect(famObj.child_ref_list.map((c) => c.ref)).toEqual([w.me.handle]);
    // ... and each of them names the family back
    expect(kidSide.parent_family_list).toContain(famObj.handle);
    expect(motherSide.family_list).toContain(famObj.handle);
    expect(fatherSide.family_list).toContain(famObj.handle);
    // the proposal and its decision are in the audit trail
    expect(w.rows(`AUDIT#proposal:${sent.body.proposal.id}`).map((x) => x.op)).toContain("proposal.decide");
  });
});

describe("scenario 5: a phone number in a note is refused until it is removed", () => {
  it("refuses the dry run and the save with the guard's code and writes nothing, then accepts the same note without it", async () => {
    const edit = (value) => ({ target: key(w.n1), base_versions: { [key(w.n1)]: 1 }, ops: [set(w.n1, "/text/string", "A synthetic note about the family.", value, "note")] });
    const text = `A synthetic note about the family. Call ${PHONE}.`;
    const dry = await post(ME, { ...edit(text), dry_run: true });
    expect(err(dry)).toEqual({ status: 422, error: "contact_info" });
    const rowsBefore = w.ddb.all().length;
    const refused = await post(ME, edit(text), "note-1");
    expect(err(refused)).toEqual({ status: 422, error: "contact_info" });
    expect(JSON.stringify(refused.body)).not.toContain("555");
    expect(w.ddb.all().length).toBe(rowsBefore);
    expect(w.rows("PROP#")).toEqual([]);

    const ok = await post(ME, edit("A synthetic note about the family, edited."), "note-2");
    expect(ok.status, JSON.stringify(ok.body)).toBe(201);
    expect(ok.body.proposal).toBeNull(); // a member's own note saves directly
    expect(ok.body.applied.versions).toEqual({ [key(w.n1)]: 2 });
    expect(w.stored("Note", w.n1.handle).text.string).toBe("A synthetic note about the family, edited.");
    expect(w.rows("PROP#")).toEqual([]);
  });
});
