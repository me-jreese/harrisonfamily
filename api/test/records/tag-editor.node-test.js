// HFY-TSK-260 (tag-editor-ui): the ops the site's photo tag editor builds (islands/src/lib/photo-tag-edit.js), judged by the API's own
// field policy and dry-run plan. Plain node:test: `node --test test/records/tag-editor.node-test.js`. Synthetic people, handles and ids only.
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { classifyOps } from "../../src/records/field-policy.js";
import { planOps } from "../../src/records/edit-plan.js";
import { buildTagOps } from "../../../islands/src/lib/photo-tag-edit.js";

const MEDIA = "hm0001";
const mref = (rect, extra = {}) => ({ _class: "MediaRef", private: false, citation_list: [], note_list: [], attribute_list: [], ref: MEDIA, rect, ...extra });
const person = (n, media = []) => ({ _class: "Person", handle: `hp000${n}`, gramps_id: `I900${n}`, private: false, gender: 2, media_list: media, event_ref_list: [], family_list: [], parent_family_list: [], note_list: [], urls: [] });
const keyOf = (p) => `Person:${p.handle}`;
const bundleOf = (p) => ({ key: keyOf(p), version: 3, obj: p });

describe("the field policy splits a tag by whose record it is on", () => {
  const me = person(1, [mref([5, 5, 9, 9], { ref: "hm0002" })]);
  const other = person(2, [mref([10, 10, 30, 30])]);
  const objects = { [keyOf(me)]: me, [keyOf(other)]: other };
  const view = {
    get: async (cls, h) => objects[`${cls}:${h}`] ?? null,
    byGrampsId: async (cls, gid) => Object.values(objects).filter((o) => o._class === cls && o.gramps_id === gid),
    referrers: async () => []
  };
  const classify = (ops, actor) => classifyOps(ops, { actor, view, objects });
  const changes = {
    add: (p) => buildTagOps(bundleOf(p), { kind: "add", mediaHandle: MEDIA, rect: [40, 40, 60, 60] }).ops,
    move: (p) => buildTagOps(bundleOf(p), { kind: "move", mediaHandle: p === other ? MEDIA : "hm0002", from: p === other ? [10, 10, 30, 30] : [5, 5, 9, 9], rect: [11, 11, 31, 31] }).ops,
    remove: (p) => buildTagOps(bundleOf(p), { kind: "remove", mediaHandle: p === other ? MEDIA : "hm0002", from: p === other ? [10, 10, 30, 30] : [5, 5, 9, 9] }).ops
  };

  for (const kind of ["add", "move", "remove"]) {
    it(`${kind}: direct on your own record, a proposal on someone else's, direct for an admin`, async () => {
      assert.deepEqual((await classify(changes[kind](me), { id: "I9001", admin: false })).map((c) => c.code), ["direct"]);
      assert.deepEqual((await classify(changes[kind](other), { id: "I9001", admin: false })).map((c) => c.code), ["proposal"]);
      assert.deepEqual((await classify(changes[kind](other), { id: "I9099", admin: true })).map((c) => c.code), ["direct"]);
    });
  }

  it("the dry-run plan puts them in the two groups the sheet shows", async () => {
    const ops = [...changes.add(me), ...changes.move(other)].map((o, i) => ({ ...o, id: `${o.id}.${i}` }));
    const plan = planOps(ops, await classify(ops, { id: "I9001", admin: false }), { objects });
    assert.equal(plan.direct.length, 1);
    assert.equal(plan.review.length, 1);
    assert.equal(plan.refused.length, 0);
    assert.deepEqual(plan.direct[0].opIds, ["tag.add.0"]);
    assert.deepEqual(plan.review[0].opIds, ["tag.rect.1"]);
  });
});

