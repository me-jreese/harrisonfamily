// EditOp engine tests (HFY-TSK-234). Plain node:test: `node --test test/records/ops.node-test.js` needs no network,
// no AWS and no install. `npm test` runs it after vitest. Every fixture is synthetic: placeholder names, made-up handles.
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  applyOps, invertOps, rebaseOps, mintHandle, HANDLE_SHAPE, keyFor, keySegment, canonicalJson, sha256Hex, hashObject, hash12,
  contentHash, deepClone, mergeReducedDate, validateOps, parsePath, REASONS,
} from "../../src/records/ops.js";

const here = dirname(fileURLToPath(import.meta.url));
const OPS_SOURCE = resolve(here, "../../src/records/ops.js");

// ---- seeded randomness -----------------------------------------------------------------------------------------
function rng(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const int = (r, n) => Math.floor(r() * n);
const pick = (r, a) => a[int(r, a.length)];
const shuffle = (r, a) => {
  const o = a.slice();
  for (let i = o.length - 1; i > 0; i--) {
    const j = int(r, i + 1);
    [o[i], o[j]] = [o[j], o[i]];
  }
  return o;
};

// ---- synthetic fixtures ----------------------------------------------------------------------------------------
const H = (n) => `h${String(n).padStart(4, "0")}`; // made-up handles
let tokenCounter = 0;
const token = (r) => `t${(tokenCounter++).toString(36)}${int(r, 1000)}`;

const media = (ref, rect, extra = {}) => ({ _class: "MediaRef", ref, rect, private: false, note_list: [], citation_list: [], attribute_list: [], ...extra });
const eventRef = (ref, role = 1) => ({ _class: "EventRef", ref, role: { _class: "EventRoleType", value: role, string: "" }, private: false, note_list: [], attribute_list: [] });
const date = (y, m = 0, d = 0, text = "") => ({ _class: "Date", calendar: 0, modifier: 0, quality: 0, dateval: [d, m, y, false], text, sortval: 0, newyear: 0 });

function person(handle = H(1)) {
  return {
    _class: "Person",
    handle,
    gramps_id: "I9001",
    gender: 1,
    private: false,
    primary_name: { _class: "Name", first_name: "Alpha", nick: "", surname_list: [{ _class: "Surname", surname: "Testa", primary: true }], date: date(0) },
    alternate_names: [
      { _class: "Name", first_name: "Alfie", surname_list: [{ _class: "Surname", surname: "Testa", primary: true }] },
      { _class: "Name", first_name: "Al", surname_list: [{ _class: "Surname", surname: "Testb", primary: true }] },
    ],
    event_ref_list: [eventRef(H(11)), eventRef(H(12), 2), eventRef(H(13))],
    family_list: [H(21), H(22), H(23)],
    parent_family_list: [H(31)],
    media_list: [media(H(41), [10, 10, 20, 20]), media(H(42), [0, 0, 50, 50]), media(H(41), [60, 60, 90, 90])],
    attribute_list: [{ _class: "Attribute", type: { _class: "AttributeType", value: 1, string: "" }, value: "red" }, { _class: "Attribute", type: { _class: "AttributeType", value: 2, string: "" }, value: "blue" }],
    urls: [{ _class: "Url", path: "https://example.test/a", desc: "A" }, { _class: "Url", path: "https://example.test/b", desc: "B" }],
    note_list: [H(51), H(52)],
    citation_list: [H(61)],
    tag_list: [],
    change: 1700000000,
  };
}
const family = (handle) => ({ _class: "Family", handle, gramps_id: "F9001", father_handle: H(1), mother_handle: "", child_ref_list: [{ _class: "ChildRef", ref: H(2) }, { _class: "ChildRef", ref: H(3) }], event_ref_list: [], note_list: [], citation_list: [], media_list: [], attribute_list: [], tag_list: [], private: false });

const P = "Person:" + H(1);
const apply1 = (obj, ops, ctx) => applyOps({ [P]: obj }, ops, ctx);
const ok = (res) => assert.equal(res.ok, true, JSON.stringify(res.conflicts));
const only = (res) => res.objects[P];
const statuses = (res) => res.results.map((r) => r.status);

// ---- basics ----------------------------------------------------------------------------------------------------
describe("hashes and canonical JSON", () => {
  it("sha256Hex equals node:crypto for edge-length and non-ASCII inputs", () => {
    for (const s of ["", "abc", "a".repeat(55), "a".repeat(56), "a".repeat(63), "a".repeat(64), "é\u{1F600}".repeat(33), "x".repeat(5000)]) {
      assert.equal(sha256Hex(s), createHash("sha256").update(s).digest("hex"));
    }
  });
  it("canonicalJson sorts keys by code point with no spaces and keeps raw non-ASCII", () => {
    assert.equal(canonicalJson({ b: 1, a: [true, null, "é"], "\u{1F600}": 2, "～": 3 }), '{"a":[true,null,"é"],"b":1,"～":3,"\u{1F600}":2}');
    assert.throws(() => canonicalJson({ a: NaN }));
  });
  it("hashObject ignores the top-level change key, as the store's hash does", () => {
    const a = person();
    const b = { ...person(), change: 5 };
    assert.equal(hashObject(a), hashObject(b));
    assert.notEqual(hashObject(a), hashObject({ ...a, gender: 2 }));
  });
});

// ---- handle minting --------------------------------------------------------------------------------------------
describe("mintHandle", () => {
  it("produces lowercase hex in the Gramps create_id shape: time part then a 63-bit random part", () => {
    const h = mintHandle({ now: () => 1_760_000_000_000, random63: () => 0x1234n });
    assert.equal(h, (17_600_000_000_000).toString(16).padStart(8, "0") + "00001234");
    for (let i = 0; i < 1000; i++) assert.match(mintHandle(), HANDLE_SHAPE);
    assert.match(mintHandle({ random63: () => (1n << 63n) - 1n }), HANDLE_SHAPE);
    assert.equal(mintHandle({ random63: () => (1n << 63n) - 1n }).slice(-16), "7fffffffffffffff");
  });
  it("is unique across 100,000 mints", () => {
    const seen = new Set();
    for (let i = 0; i < 100_000; i++) seen.add(mintHandle());
    assert.equal(seen.size, 100_000);
  });
  it("create gives each new:n a distinct minted handle, written into the object and every reference to it", () => {
    const res = applyOps({}, [
      { id: "c1", op: "create", obj: "new:1", cls: "Person", value: { gramps_id: "", family_list: [] } },
      { id: "c2", op: "create", obj: "new:2", cls: "Family", value: { father_handle: "new:1", child_ref_list: [], note_list: [] } },
      { id: "s1", op: "add", obj: "new:1", path: "/family_list", value: "new:2" },
    ]);
    ok(res);
    const h1 = res.minted["new:1"];
    const h2 = res.minted["new:2"];
    assert.match(h1, HANDLE_SHAPE);
    assert.notEqual(h1, h2);
    assert.equal(res.objects[`Person:${h1}`].handle, h1);
    assert.equal(res.objects[`Person:${h1}`]._class, "Person");
    assert.deepEqual(res.objects[`Person:${h1}`].family_list, [h2]);
    assert.equal(res.objects[`Family:${h2}`].father_handle, h1);
  });
});

// ---- key segments ----------------------------------------------------------------------------------------------
describe("key segments resolve to the same element after the list is reordered", () => {
  const base = person();
  const reorder = (obj) => {
    const o = deepClone(obj);
    for (const f of ["event_ref_list", "family_list", "media_list", "alternate_names", "attribute_list", "urls"]) o[f].reverse();
    return o;
  };

  it("@ref= (event_ref_list)", () => {
    const key = keySegment("event_ref_list", base.event_ref_list, 1); // the second event ref, by ref only
    assert.equal(key, `@ref=${H(12)}`);
    const res = apply1(reorder(base), [{ id: "o", op: "set", obj: P, path: `/event_ref_list/${key}/role/value`, base: 2, value: 7 }]);
    ok(res);
    assert.equal(only(res).event_ref_list.find((e) => e.ref === H(12)).role.value, 7);
    assert.equal(only(res).event_ref_list.filter((e) => e.role.value === 7).length, 1);
  });

  it("@= (family_list) removes and moves by value", () => {
    const rev = reorder(base);
    const res = apply1(rev, [
      { id: "o1", op: "remove", obj: P, path: "/family_list/@=" + H(22), base: H(22) },
      { id: "o2", op: "move", obj: P, path: "/family_list/@=" + H(23), before: "@=" + H(21) },
    ]);
    ok(res);
    assert.deepEqual(only(res).family_list, [H(23), H(21)]);
  });

  it("@k= (alternate_names) finds the element by content hash wherever it sits", () => {
    const key = keySegment("alternate_names", base.alternate_names, 1);
    assert.match(key, /^@k=[0-9a-f]{12}$/);
    assert.equal(key, "@k=" + hash12(base.alternate_names[1]));
    const res = apply1(reorder(base), [{ id: "o", op: "set", obj: P, path: `/alternate_names/${key}/first_name`, base: "Al", value: "Ally" }]);
    ok(res);
    assert.deepEqual(only(res).alternate_names.map((n) => n.first_name).sort(), ["Alfie", "Ally"]);
  });

  it("a key built for any element of any list finds that element after a shuffle", () => {
    const r = rng(7);
    for (let t = 0; t < 50; t++) {
      const shuffled = deepClone(base);
      for (const f of ["event_ref_list", "family_list", "media_list", "alternate_names", "attribute_list", "urls", "note_list"]) shuffled[f] = shuffle(r, shuffled[f]);
      for (const f of ["event_ref_list", "media_list", "alternate_names", "attribute_list", "urls", "family_list", "note_list"]) {
        base[f].forEach((el, i) => {
          const key = keySegment(f, base[f], i);
          const res = apply1(shuffled, [{ id: "r", op: "remove", obj: P, path: `/${f}/${key}`, base: el }]);
          ok(res);
          const left = only(res)[f];
          assert.equal(left.length, base[f].length - 1);
          assert.equal(left.some((x) => canonicalJson(x) === canonicalJson(el)), false);
        });
      }
    }
  });

  it("a stale @k (the element's content changed) is a conflict and nothing else changes", () => {
    const key = keySegment("alternate_names", base.alternate_names, 1);
    const changed = deepClone(base);
    changed.alternate_names[1].first_name = "Someone else edited this";
    const before = deepClone(changed);
    const res = apply1(changed, [{ id: "o", op: "set", obj: P, path: `/alternate_names/${key}/first_name`, base: "Al", value: "Ally" }]);
    assert.equal(res.ok, false);
    assert.equal(res.conflicts[0].reason, REASONS.staleKey);
    assert.deepEqual(res.objects[P], before); // never a wrong element
    const rb = rebaseOps([{ id: "o", op: "set", obj: P, path: `/alternate_names/${key}/first_name`, base: "Al", value: "Ally" }], { [P]: changed });
    assert.equal(rb.status, "conflict");
    assert.equal(rb.conflicts[0].reason, REASONS.staleKey);
  });

  it("an @ref hash check on a changed element is a conflict, and a missing ref is key_not_found", () => {
    const key = keySegment("media_list", base.media_list, 1); // @ref=h0042#0:<hash>
    const changed = deepClone(base);
    changed.media_list[1].rect = [1, 2, 3, 4];
    const res = apply1(changed, [{ id: "o", op: "set", obj: P, path: `/media_list/${key}/private`, base: false, value: true }]);
    assert.equal(res.conflicts[0].reason, REASONS.staleKey);
    const res2 = apply1(base, [{ id: "o", op: "set", obj: P, path: `/media_list/@ref=${H(99)}#0:000000000000/private`, base: false, value: true }]);
    assert.equal(res2.conflicts[0].reason, REASONS.keyNotFound);
  });

  it("an ambiguous key is a conflict, never a guess", () => {
    const dup = deepClone(base);
    dup.family_list.push(H(21));
    const res = apply1(dup, [{ id: "o", op: "move", obj: P, path: "/family_list/@=" + H(21) }]);
    assert.equal(res.conflicts[0].reason, REASONS.ambiguousKey);
    const twice = deepClone(base);
    twice.event_ref_list.push(eventRef(H(11)));
    const res2 = apply1(twice, [{ id: "o", op: "set", obj: P, path: `/event_ref_list/@ref=${H(11)}/private`, base: false, value: true }]);
    assert.equal(res2.conflicts[0].reason, REASONS.ambiguousKey); // two refs of H(11): the plain ref names neither
  });

  it("a media_list key without :<hash12> is invalid_path, never a selection by occurrence", () => {
    const bare = [`@ref=${H(41)}`, `@ref=${H(41)}#0`, `@ref=${H(41)}#1`, `@ref=${H(42)}`];
    for (const seg of bare) {
      const op = { id: "o", op: "set", obj: P, path: `/media_list/${seg}/private`, base: false, value: true };
      assert.equal(validateOps([op])[0].reason, REASONS.invalidPath, seg);
      const res = apply1(base, [op]);
      assert.equal(res.ok, false);
      assert.equal(res.conflicts[0].reason, REASONS.invalidPath, seg);
      assert.deepEqual(res.objects[P], base);
    }
    // remove, move and the before anchor are held to the same rule
    const rm = { id: "r", op: "remove", obj: P, path: `/media_list/@ref=${H(42)}#0`, base: base.media_list[1] };
    assert.equal(validateOps([rm])[0].reason, REASONS.invalidPath);
    const mv = { id: "m", op: "move", obj: P, path: `/media_list/${keySegment("media_list", base.media_list, 0)}`, before: `@ref=${H(42)}#0` };
    assert.equal(validateOps([mv])[0].reason, REASONS.invalidPath);
    const ad = { id: "a", op: "add", obj: P, path: "/media_list", value: media(H(43), [1, 1, 2, 2]), before: `@ref=${H(42)}#0` };
    assert.equal(validateOps([ad])[0].reason, REASONS.invalidPath);
    // the other ref lists keep the plain form
    assert.equal(validateOps([{ id: "e", op: "set", obj: P, path: `/event_ref_list/@ref=${H(12)}/private`, base: false, value: true }]).length, 0);
  });

  it("parsePath keeps handles with a colon (new:1) and rejects malformed segments", () => {
    assert.deepEqual(parsePath("/a/@ref=new:1#2:0123456789ab/b")[1], { t: "ref", ref: "new:1", n: 2, hash: "0123456789ab" });
    assert.deepEqual(parsePath("/a/@ref=new:1")[1], { t: "ref", ref: "new:1", n: undefined, hash: undefined });
    assert.throws(() => parsePath("/a/@k=short"));
    assert.throws(() => parsePath("/a/@zz=1"));
    assert.throws(() => parsePath("no-slash"));
    assert.throws(() => parsePath("/__proto__"));
  });
});

// ---- MediaRef: ref#n plus a base content hash (SI-22) ----------------------------------------------------------
describe("MediaRef elements", () => {
  const photoKey = (obj, i) => keySegment("media_list", obj.media_list, i);

  it("two tags of one person in one photo are distinct keys that carry n and a content hash", () => {
    const p = person();
    const k0 = photoKey(p, 0);
    const k2 = photoKey(p, 2);
    assert.notEqual(k0, k2);
    assert.match(k0, new RegExp(`^@ref=${H(41)}#0:[0-9a-f]{12}$`));
    assert.match(k2, new RegExp(`^@ref=${H(41)}#1:[0-9a-f]{12}$`));
    assert.match(photoKey(p, 1), new RegExp(`^@ref=${H(42)}#0:[0-9a-f]{12}$`)); // MediaRef keys always carry both
  });

  it("two tags of one person in one photo: one moved and the other edited, in one batch", () => {
    const p = person();
    const k0 = photoKey(p, 0);
    const k2 = photoKey(p, 2);
    const ops = [
      { id: "move-first-tag", op: "move", obj: P, path: `/media_list/${k0}` }, // to the end: the second tag becomes first
      { id: "edit-second-tag", op: "set", obj: P, path: `/media_list/${k2}/rect`, base: [60, 60, 90, 90], value: [61, 61, 91, 91] },
      { id: "edit-first-tag-too", op: "set", obj: P, path: `/media_list/${k0}/rect`, base: [10, 10, 20, 20], value: [11, 11, 21, 21] },
    ];
    const res = apply1(p, ops);
    ok(res);
    assert.deepEqual(only(res).media_list.map((m) => [m.ref, m.rect]), [[H(42), [0, 0, 50, 50]], [H(41), [61, 61, 91, 91]], [H(41), [11, 11, 21, 21]]]);
    // the inverse restores both tags, in order
    const back = applyOps(res.objects, res.inverse);
    ok(back);
    assert.deepEqual(back.objects[P], p);
  });

  it("a stale key never selects the other tag of the same photo", () => {
    const p = person();
    const k0 = photoKey(p, 0);
    const edited = deepClone(p);
    edited.media_list[0].rect = [12, 12, 22, 22]; // someone moved the first tag meanwhile
    const op = { id: "o", op: "set", obj: P, path: `/media_list/${k0}/rect`, base: [10, 10, 20, 20], value: [13, 13, 23, 23] };
    const res = apply1(edited, [op]);
    assert.equal(res.ok, false);
    assert.equal(res.conflicts[0].reason, REASONS.staleKey);
    assert.deepEqual(res.objects[P].media_list[2].rect, [60, 60, 90, 90]);
    // the first tag was removed meanwhile: n=0 is now the other tag, whose hash differs
    const removed = deepClone(p);
    removed.media_list.splice(0, 1);
    const res2 = apply1(removed, [op]);
    assert.equal(res2.conflicts[0].reason, REASONS.staleKey);
    assert.deepEqual(res2.objects[P], removed);
  });

  it("equal refs that were swapped meanwhile still resolve to the same content", () => {
    const p = person();
    const k2 = photoKey(p, 2);
    const swapped = deepClone(p);
    [swapped.media_list[0], swapped.media_list[2]] = [swapped.media_list[2], swapped.media_list[0]];
    const res = apply1(swapped, [{ id: "o", op: "set", obj: P, path: `/media_list/${k2}/rect`, base: [60, 60, 90, 90], value: [1, 1, 2, 2] }]);
    ok(res);
    assert.deepEqual(only(res).media_list[0].rect, [1, 1, 2, 2]);
    assert.deepEqual(only(res).media_list[2].rect, [10, 10, 20, 20]);
  });

  it("add of a second tag of the same person and photo is clean; an identical tag is a no-op", () => {
    const p = person();
    const second = media(H(41), [30, 30, 40, 40]);
    const add = { id: "o", op: "add", obj: P, path: "/media_list", value: second };
    const res = apply1(p, [add]);
    ok(res);
    assert.deepEqual(statuses(res), ["clean"]);
    assert.equal(only(res).media_list.length, 4);
    assert.deepEqual(statuses(apply1(only(res), [add])), ["noop"]);
  });
});

// ---- reduced Date (publishView) --------------------------------------------------------------------------------
describe("a Date edited from a reduced view", () => {
  const ev = () => ({ _class: "Event", handle: H(70), gramps_id: "E9001", date: { ...date(1900, 5, 17, "about may 1900"), sortval: 123 }, place: "", description: "" });
  const EV = "Event:" + H(70);
  const reducedYearEdit = { id: "d", op: "set", obj: EV, path: "/date", base_version: 4, value: { _class: "Date", calendar: 0, modifier: 0, quality: 0, dateval: [0, 0, 1901, false], text: "", sortval: 0, newyear: 0 } };

  it("keeps the stored day, month and text; the op's base is base_version, not the value", () => {
    const res = applyOps({ [EV]: ev() }, [reducedYearEdit], { versions: { [EV]: 4 } });
    ok(res);
    const d = res.objects[EV].date;
    assert.deepEqual(d.dateval, [17, 5, 1901, false]);
    assert.equal(d.text, "about may 1900");
    assert.equal(d.sortval, 123);
    assert.equal("base" in reducedYearEdit, false);
  });

  it("rewrites day, month and text only when the op sets them explicitly", () => {
    const op = { ...reducedYearEdit, value: { ...reducedYearEdit.value, dateval: [0, 0, 1901, false], text: "" }, sets: ["month", "text"] };
    const res = applyOps({ [EV]: ev() }, [op], { versions: { [EV]: 4 } });
    ok(res);
    assert.deepEqual(res.objects[EV].date.dateval, [17, 0, 1901, false]); // month set to 0 on purpose, day kept
    assert.equal(res.objects[EV].date.text, "");
    const direct = applyOps({ [EV]: ev() }, [{ id: "d2", op: "set", obj: EV, path: "/date/dateval/2", base_version: 4, value: 1902 }], { versions: { [EV]: 4 } });
    ok(direct);
    assert.deepEqual(direct.objects[EV].date.dateval, [17, 5, 1902, false]); // a sub-path op touches only what it names
  });

  it("rebase compares the version: clean at the same version, conflict when the object moved on", () => {
    const rb = rebaseOps([reducedYearEdit], { [EV]: ev() }, { versions: { [EV]: 4 }, baseVersions: { [EV]: 4 } });
    assert.equal(rb.status, "current");
    const moved = rebaseOps([reducedYearEdit], { [EV]: ev() }, { versions: { [EV]: 5 }, baseVersions: { [EV]: 4 } });
    assert.equal(moved.status, "conflict");
    assert.equal(moved.conflicts[0].reason, REASONS.versionChanged);
    assert.deepEqual(moved.conflicts[0].base, { base_version: 4 });
    // already at the proposed year after the move: nothing to do
    const there = ev();
    there.date.dateval[2] = 1901;
    assert.equal(rebaseOps([reducedYearEdit], { [EV]: there }, { versions: { [EV]: 5 } }).results[0].status, "noop");
  });

  it("the inverse restores the full stored Date", () => {
    const res = applyOps({ [EV]: ev() }, [reducedYearEdit], { versions: { [EV]: 4 } });
    ok(res);
    const back = applyOps(res.objects, res.inverse);
    ok(back);
    assert.deepEqual(back.objects[EV], ev());
  });

  it("a reduced set with no version to check is a conflict, never a silent apply (apply and rebase)", () => {
    const stored = { [EV]: ev() };
    for (const ctx of [undefined, {}, { versions: {} }, { versions: { "Event:other": 4 } }]) {
      const a = applyOps(stored, [reducedYearEdit], ctx);
      assert.equal(a.ok, false);
      assert.equal(a.conflicts[0].reason, REASONS.missingVersion);
      assert.deepEqual(a.objects[EV], ev());
      const r = rebaseOps([reducedYearEdit], stored, ctx);
      assert.equal(r.status, "conflict");
      assert.equal(r.conflicts[0].reason, REASONS.missingVersion);
      assert.equal(r.objects, null);
    }
  });

  it("a reduced set outside a Date falls back to its value base; with no base it is invalid", () => {
    const thing = { ...ev(), description: "x" };
    const op = { id: "o", op: "set", obj: EV, path: "/description", base_version: 4, base: "x", value: "y" };
    const res = applyOps({ [EV]: thing }, [op]); // no versions needed: the value base is the guard
    ok(res);
    assert.equal(res.objects[EV].description, "y");
    assert.equal(applyOps({ [EV]: { ...thing, description: "z" } }, [op]).conflicts[0].reason, REASONS.baseMismatch);
    const { base, ...noBase } = op; // eslint-disable-line no-unused-vars
    assert.equal(applyOps({ [EV]: thing }, [noBase], { versions: { [EV]: 4 } }).conflicts[0].reason, REASONS.missingBase);
  });

  it("mergeReducedDate leaves RANGE tuples' second day and month alone too", () => {
    const stored = { dateval: [1, 2, 1900, false, 3, 4, 1901, false], text: "", sortval: 9 };
    const merged = mergeReducedDate(stored, { dateval: [0, 0, 1900, false, 0, 0, 1902, false], text: "", sortval: 0 });
    assert.deepEqual(merged.dateval, [1, 2, 1900, false, 3, 4, 1902, false]);
  });
});

// ---- rebase table (editing design section 7.5): one test per row ------------------------------------------------
describe("three-way rebase, one test per row of the section 7.5 table", () => {
  const rb = (ops, cur, ctx) => rebaseOps(ops, { [P]: cur }, ctx);

  describe("set", () => {
    const op = { id: "o", op: "set", obj: P, path: "/primary_name/first_name", base: "Alpha", value: "Beta" };
    it("is clean when the current value deep-equals base", () => {
      const r = rb([op], person());
      assert.equal(r.status, "clean");
      assert.deepEqual(statuses(r), ["clean"]);
      assert.equal(r.objects[P].primary_name.first_name, "Beta");
    });
    it("is a no-op when current already equals the proposed value", () => {
      const cur = person();
      cur.primary_name.first_name = "Beta";
      const r = rb([op], cur);
      assert.equal(r.status, "clean");
      assert.deepEqual(statuses(r), ["noop"]);
    });
    it("is a conflict when current differs from both, with the base, current and proposed in the row", () => {
      const cur = person();
      cur.primary_name.first_name = "Gamma";
      const r = rb([op], cur);
      assert.equal(r.status, "conflict");
      assert.deepEqual(r.conflicts[0], { opId: "o", obj: P, op: "set", path: "/primary_name/first_name", reason: REASONS.baseMismatch, base: "Alpha", current: "Gamma", proposed: "Beta" });
      assert.equal(r.objects, null);
    });
    it("compares whole values deeply (key order does not matter)", () => {
      const o = { id: "o", op: "set", obj: P, path: "/primary_name/surname_list/@k=" + hash12(person().primary_name.surname_list[0]), base: { primary: true, surname: "Testa", _class: "Surname" }, value: { _class: "Surname", surname: "Testz", primary: true } };
      assert.deepEqual(statuses(rb([o], person())), ["clean"]);
    });
  });

  describe("add", () => {
    const el = media(H(43), [1, 1, 2, 2]);
    const op = { id: "o", op: "add", obj: P, path: "/media_list", value: el };
    it("is clean when the list exists and the key is absent", () => {
      const r = rb([op], person());
      assert.deepEqual(statuses(r), ["clean"]);
      assert.equal(r.objects[P].media_list.at(-1).ref, H(43));
    });
    it("is a no-op when an identical element is present", () => {
      const cur = person();
      cur.media_list.push(deepClone(el));
      assert.deepEqual(statuses(rb([op], cur)), ["noop"]);
    });
    it("is a conflict when the list is not there", () => {
      const cur = person();
      delete cur.media_list;
      const r = rb([op], cur);
      assert.equal(r.status, "conflict");
      assert.equal(r.conflicts[0].reason, REASONS.noSuchPath);
      const r2 = rb([{ ...op, path: "/gender" }], person());
      assert.equal(r2.conflicts[0].reason, REASONS.notAList);
    });
    it("is a conflict when the key is taken by different content (one child per ref)", () => {
      const fam = family(H(80));
      const o = { id: "o", op: "add", obj: "Family:" + H(80), path: "/child_ref_list", value: { _class: "ChildRef", ref: H(2), frel: { value: 2 } } };
      const r = rebaseOps([o], { ["Family:" + H(80)]: fam });
      assert.equal(r.conflicts[0].reason, REASONS.keyExists);
    });
    it("places the element before a key, and appends when no key is given", () => {
      const r = rb([{ ...op, before: keySegment("media_list", person().media_list, 1) }], person());
      assert.equal(r.objects[P].media_list[1].ref, H(43));
    });
  });

  describe("remove", () => {
    const base = person();
    const op = { id: "o", op: "remove", obj: P, path: "/attribute_list/" + keySegment("attribute_list", base.attribute_list, 0), base: base.attribute_list[0] };
    it("is clean when the element is present with the same content hash", () => {
      const r = rb([op], person());
      assert.deepEqual(statuses(r), ["clean"]);
      assert.equal(r.objects[P].attribute_list.length, 1);
    });
    it("is a no-op when the element is already absent", () => {
      const cur = person();
      const gone = person();
      gone.family_list = [H(21), H(23)];
      assert.deepEqual(statuses(rb([{ id: "o", op: "remove", obj: P, path: "/family_list/@=" + H(22), base: H(22) }], gone)), ["noop"]);
    });
    it("is a conflict, never a no-op, when an @k element was edited since base (the old key is stale)", () => {
      const cur = person();
      cur.attribute_list[0].value = "green"; // someone edited the entry the proposer wants to remove
      const r = rb([op], cur);
      assert.equal(r.status, "conflict");
      assert.equal(r.conflicts[0].reason, REASONS.staleKey);
      assert.deepEqual(statuses(r), ["conflict"]);
      assert.equal(r.objects, null);
      // the same through apply: the element is still there
      const a = apply1(cur, [op]);
      assert.equal(a.ok, false);
      assert.equal(a.objects[P].attribute_list.length, 2);
      // an @ref remove of an edited element is a conflict too
      const edited = person();
      edited.event_ref_list[1].role.value = 9;
      const byRef = rb([{ id: "o", op: "remove", obj: P, path: "/event_ref_list/@ref=" + H(12), base: person().event_ref_list[1] }], edited);
      assert.equal(byRef.conflicts[0].reason, REASONS.contentChanged);
    });
    it("is a conflict when the element is there with different content", () => {
      const cur = person();
      cur.event_ref_list[1].role.value = 9;
      const o = { id: "o", op: "remove", obj: P, path: "/event_ref_list/@ref=" + H(12), base: person().event_ref_list[1] };
      const r = rb([o], cur);
      assert.equal(r.status, "conflict");
      assert.equal(r.conflicts[0].reason, REASONS.contentChanged);
      const viaHash = rb([{ ...o, path: o.path + "#0:" + hash12(person().event_ref_list[1]) }], cur);
      assert.equal(viaHash.conflicts[0].reason, REASONS.staleKey);
    });
    it("accepts base_hash instead of the value", () => {
      assert.deepEqual(statuses(rb([{ id: "o", op: "remove", obj: P, path: op.path, base_hash: contentHash(base.attribute_list[0]) }], person())), ["clean"]);
    });
  });

  describe("move", () => {
    const k = (i) => "@=" + person().family_list[i];
    it("is clean when both keys are present", () => {
      const r = rb([{ id: "o", op: "move", obj: P, path: "/family_list/" + k(2), before: k(0) }], person());
      assert.deepEqual(statuses(r), ["clean"]);
      assert.deepEqual(r.objects[P].family_list, [H(23), H(21), H(22)]);
      const end = rb([{ id: "o", op: "move", obj: P, path: "/family_list/" + k(0) }], person());
      assert.deepEqual(end.objects[P].family_list, [H(22), H(23), H(21)]);
    });
    it("is a conflict when the moved key is gone", () => {
      const cur = person();
      cur.family_list = [H(21), H(23)];
      const r = rb([{ id: "o", op: "move", obj: P, path: "/family_list/" + k(1), before: k(0) }], cur);
      assert.equal(r.status, "conflict");
      assert.equal(r.conflicts[0].reason, REASONS.keyNotFound);
    });
    it("is a conflict when the key it moves before is gone", () => {
      const cur = person();
      cur.family_list = [H(21), H(22)];
      const r = rb([{ id: "o", op: "move", obj: P, path: "/family_list/" + k(1), before: k(2) }], cur);
      assert.equal(r.status, "conflict");
      assert.equal(r.conflicts[0].reason, REASONS.keyNotFound);
    });
  });

  describe("create", () => {
    it("is always clean", () => {
      const r = rb([{ id: "o", op: "create", obj: "new:1", cls: "Note", value: { text: { string: "hello" } } }], person());
      assert.equal(r.status, "clean");
      assert.deepEqual(statuses(r), ["clean"]);
      assert.equal(Object.keys(r.objects).length, 2);
      // even when the rest of the page changed in the meantime
      const cur = person();
      cur.gender = 2;
      assert.equal(rb([{ id: "o", op: "create", obj: "new:1", cls: "Note", value: {} }], cur).status, "clean");
    });
  });

  describe("delete", () => {
    it("is clean when the object exists and its hash equals the base hash", () => {
      const r = rb([{ id: "o", op: "delete", obj: P, base: hashObject(person()) }], { ...person(), change: 1800000000 }); // a changed `change` stamp is not content
      assert.equal(r.status, "clean");
      assert.deepEqual(r.objects, {});
    });
    it("is a conflict when the hash differs or the object is gone", () => {
      const cur = person();
      cur.gender = 2;
      const r = rb([{ id: "o", op: "delete", obj: P, base: hashObject(person()) }], cur);
      assert.equal(r.status, "conflict");
      assert.equal(r.conflicts[0].reason, REASONS.hashMismatch);
      const gone = rebaseOps([{ id: "o", op: "delete", obj: P, base: hashObject(person()) }], {});
      assert.equal(gone.conflicts[0].reason, REASONS.missingObject);
    });
  });

  it("status is clean when every op is clean or a no-op, and conflict as soon as one is; non-overlapping paths do not conflict", () => {
    const cur = person();
    cur.gender = 2; // someone else changed another field
    const ops = [
      { id: "a", op: "set", obj: P, path: "/primary_name/nick", base: "", value: "Al" },
      { id: "b", op: "set", obj: P, path: "/gender", base: 1, value: 0 },
    ];
    const r = rb(ops, cur);
    assert.equal(r.status, "conflict");
    assert.deepEqual(statuses(r), ["clean", "conflict"]);
    assert.equal(rb([ops[0]], cur).status, "clean");
  });

  it("invalid ops are reported, not guessed", () => {
    assert.equal(validateOps([{ id: "x", op: "set", obj: P, path: "/gender", value: 1 }])[0].reason, REASONS.missingBase);
    assert.equal(validateOps([{ id: "x", op: "nope", obj: P }])[0].reason, REASONS.invalidOp);
    assert.equal(validateOps([{ id: "x", op: "remove", obj: P, path: "/family_list/@=a" }])[0].reason, REASONS.missingBase);
    const r = rb([{ id: "x", op: "move", obj: P, path: "/family_list", base: 0 }], person());
    assert.equal(r.status, "conflict");
    assert.equal(r.conflicts[0].reason, REASONS.invalidPath);
  });
});

// ---- review fixes: absent properties, values, anchors, missing objects ---------------------------------------------
describe("set creates an absent property; remove drops one", () => {
  it("set on a property the stored object lacks is clean when base is null, and its inverse removes it", () => {
    const p = person();
    delete p.private;
    {
      const res = apply1(p, [{ id: "o", op: "set", obj: P, path: "/private", value: true, base: null }]);
      ok(res);
      assert.equal(only(res).private, true);
      const back = applyOps(res.objects, res.inverse);
      ok(back);
      assert.deepEqual(back.objects[P], p);
      assert.equal(Object.prototype.hasOwnProperty.call(back.objects[P], "private"), false);
      // and the inverse of that inverse sets it again
      const again = applyOps(back.objects, back.inverse);
      ok(again);
      assert.deepEqual(again.objects[P], res.objects[P]);
    }
  });
  it("set on an absent property with a real base is a conflict; a missing parent stays a conflict; identity fields are never created", () => {
    const p = person();
    delete p.private;
    assert.equal(apply1(p, [{ id: "o", op: "set", obj: P, path: "/private", base: false, value: true }]).conflicts[0].reason, REASONS.noSuchPath);
    assert.equal(apply1(p, [{ id: "o", op: "set", obj: P, path: "/nothing/deeper", base: null, value: 1 }]).conflicts[0].reason, REASONS.noSuchPath);
    const noClass = person();
    delete noClass._class;
    assert.equal(apply1(noClass, [{ id: "o", op: "set", obj: P, path: "/_class", base: null, value: "X" }]).ok, false);
  });
  it("remove of an absent property is a no-op; of a present one needs its content; handle and _class cannot be removed", () => {
    const p = person();
    assert.deepEqual(statuses(apply1(p, [{ id: "o", op: "remove", obj: P, path: "/not_there", base: 1 }])), ["noop"]);
    const res = apply1(p, [{ id: "o", op: "remove", obj: P, path: "/gender", base: 1 }]);
    ok(res);
    assert.equal("gender" in only(res), false);
    assert.equal(apply1(p, [{ id: "o", op: "remove", obj: P, path: "/gender", base: 2 }]).conflicts[0].reason, REASONS.contentChanged);
    const back = applyOps(res.objects, res.inverse);
    ok(back);
    assert.deepEqual(back.objects[P], p);
    for (const f of ["handle", "_class"]) assert.equal(apply1(p, [{ id: "o", op: "remove", obj: P, path: `/${f}`, base: "x" }]).conflicts[0].reason, REASONS.invalidPath);
  });
});

describe("values that could confuse identity or hashing", () => {
  it("an own __proto__ key in a value is invalid_op, not a prototype swap", () => {
    const evil = JSON.parse('{"__proto__":{"ref":"zzz"},"first_name":"X"}');
    const add = { id: "o", op: "add", obj: P, path: "/alternate_names", value: evil };
    assert.equal(validateOps([add])[0].reason, REASONS.invalidOp);
    const res = apply1(person(), [add]);
    assert.equal(res.ok, false);
    assert.equal(res.conflicts[0].reason, REASONS.invalidOp);
    assert.equal(Object.getPrototypeOf(res.objects[P].alternate_names[0]), Object.prototype);
    assert.equal(validateOps([{ id: "n", op: "create", obj: "new:1", cls: "Note", value: JSON.parse('{"a":[{"__proto__":1}]}') }])[0].reason, REASONS.invalidOp);
    assert.equal(validateOps([{ id: "s", op: "set", obj: P, path: "/gender", base: JSON.parse('{"__proto__":1}'), value: 2 }])[0].reason, REASONS.invalidOp);
  });
  it("deepClone keeps an own __proto__ key as an own key (stored objects from JSON.parse hash as they read)", () => {
    const src = JSON.parse('{"__proto__":{"ref":"zzz"},"a":1}');
    const c = deepClone(src);
    assert.equal(Object.getPrototypeOf(c), Object.prototype);
    assert.equal(c.ref, undefined);
    assert.equal(canonicalJson(c), canonicalJson(src));
  });
});

describe("new:n is rewritten only where a handle lives", () => {
  it("free text that reads new:1 stays as typed; reference fields are rewritten", () => {
    const res = applyOps({}, [
      { id: "c1", op: "create", obj: "new:1", cls: "Person", value: { family_list: [] } },
      { id: "c2", op: "create", obj: "new:2", cls: "Note", value: { text: { string: "new:1" }, name: "new:1", ref_hint: "new:1", place: "new:1", father_handle: "new:1", event_ref_list: [{ ref: "new:1", description: "new:1" }], note_list: ["new:1"] } },
      { id: "s1", op: "add", obj: "new:1", path: "/family_list", value: "new:2" },
    ]);
    ok(res);
    const h1 = res.minted["new:1"];
    const n = res.objects[`Note:${res.minted["new:2"]}`];
    assert.deepEqual(n.text, { string: "new:1" });
    assert.equal(n.name, "new:1");
    assert.equal(n.ref_hint, "new:1");
    assert.equal(n.place, h1);
    assert.equal(n.father_handle, h1);
    assert.deepEqual(n.event_ref_list, [{ ref: h1, description: "new:1" }]);
    assert.deepEqual(n.note_list, [h1]);
    assert.deepEqual(res.objects[`Person:${h1}`].family_list, [res.minted["new:2"]]);
  });
  it("a set of a reference field to new:n is rewritten, a set of free text is not", () => {
    const res = applyOps({ [P]: { ...person(), place: "", title: "" } }, [
      { id: "c", op: "create", obj: "new:1", cls: "Place", value: {} },
      { id: "a", op: "set", obj: P, path: "/place", base: "", value: "new:1" },
      { id: "b", op: "set", obj: P, path: "/title", base: "", value: "new:1" },
    ]);
    ok(res);
    assert.equal(res.objects[P].place, res.minted["new:1"]);
    assert.equal(res.objects[P].title, "new:1");
  });
});

describe("a position whose anchor is gone", () => {
  it("add with a before key that no longer exists is a conflict, like move, not an append", () => {
    const cur = person();
    const gone = `@ref=${H(99)}#0:000000000000`;
    const add = { id: "o", op: "add", obj: P, path: "/media_list", value: media(H(43), [1, 1, 2, 2]), before: gone };
    const r = rebaseOps([add], { [P]: cur });
    assert.equal(r.status, "conflict");
    assert.equal(r.conflicts[0].reason, REASONS.keyNotFound);
    assert.equal(r.objects, null);
    const mv = { id: "m", op: "move", obj: P, path: `/media_list/${keySegment("media_list", cur.media_list, 0)}`, before: gone };
    assert.equal(rebaseOps([mv], { [P]: cur }).conflicts[0].reason, REASONS.keyNotFound);
    const fam = { id: "f", op: "add", obj: P, path: "/family_list", value: H(24), before: "@=" + H(99) };
    assert.equal(rebaseOps([fam], { [P]: cur }).conflicts[0].reason, REASONS.keyNotFound);
  });
});

describe("objects that are already gone, or already there", () => {
  it("delete and remove of an object that is not in the store are missing_object conflicts (the superseded flow decides)", () => {
    const del = rebaseOps([{ id: "d", op: "delete", obj: "Person:" + H(7), base: "0".repeat(64) }], {});
    assert.equal(del.status, "conflict");
    assert.equal(del.conflicts[0].reason, REASONS.missingObject);
    const rm = rebaseOps([{ id: "r", op: "remove", obj: "Person:" + H(7), path: "/family_list/@=x", base: "x" }], {});
    assert.equal(rm.conflicts[0].reason, REASONS.missingObject);
  });
  it("create of a key already in the store is object_exists, except an identical object, which is a no-op", () => {
    const stored = person();
    const clash = rebaseOps([{ id: "c", op: "create", obj: P, cls: "Person", value: { gramps_id: "other" } }], { [P]: stored });
    assert.equal(clash.status, "conflict");
    assert.equal(clash.conflicts[0].reason, REASONS.objectExists);
    const same = rebaseOps([{ id: "c", op: "create", obj: P, cls: "Person", value: stored }], { [P]: stored });
    assert.equal(same.status, "clean");
    assert.deepEqual(statuses(same), ["noop"]);
    assert.deepEqual(same.objects[P], stored);
  });
});

// ---- inverse ---------------------------------------------------------------------------------------------------
describe("inverse", () => {
  it("restores a deleted object with its handle, and undoes a create", () => {
    const p = person();
    const del = applyOps({ [P]: p }, [{ id: "d", op: "delete", obj: P, base: hashObject(p) }]);
    ok(del);
    assert.deepEqual(applyOps(del.objects, del.inverse).objects, { [P]: p });
    const cr = applyOps({ [P]: p }, [{ id: "c", op: "create", obj: "new:1", cls: "Note", value: { text: "x" } }]);
    const undone = applyOps(cr.objects, cr.inverse);
    ok(undone);
    assert.deepEqual(undone.objects, { [P]: p });
  });
  it("invertOps returns the undo ops and throws when the ops do not apply", () => {
    const p = person();
    const inv = invertOps({ [P]: p }, [{ id: "s", op: "set", obj: P, path: "/gender", base: 1, value: 2 }]);
    assert.deepEqual(inv.map((o) => o.op), ["set"]);
    assert.equal(inv[0].seq, true);
    assert.throws(() => invertOps({ [P]: p }, [{ id: "s", op: "set", obj: P, path: "/gender", base: 5, value: 2 }]), /base_mismatch/);
  });
  it("does not mutate its input", () => {
    const p = person();
    const frozen = deepClone(p);
    applyOps({ [P]: p }, [{ id: "s", op: "set", obj: P, path: "/gender", base: 1, value: 2 }, { id: "r", op: "remove", obj: P, path: "/family_list/@=" + H(21), base: H(21) }]);
    assert.deepEqual(p, frozen);
  });
});

// ---- property tests --------------------------------------------------------------------------------------------
const LISTS = ["event_ref_list", "family_list", "parent_family_list", "media_list", "alternate_names", "attribute_list", "urls", "note_list", "citation_list"];
const STRING_FIELDS = new Set(["family_list", "parent_family_list", "note_list", "citation_list"]);

function randomPerson(r) {
  const p = person();
  for (const f of LISTS) {
    const n = int(r, 5);
    const list = [];
    for (let i = 0; i < n; i++) list.push(randomElement(r, f));
    p[f] = list;
  }
  p.gender = int(r, 3);
  p.primary_name.first_name = token(r);
  return p;
}
function randomElement(r, f) {
  if (STRING_FIELDS.has(f)) return "h" + token(r);
  if (f === "media_list") return media(pick(r, [H(41), H(42), H(43)]), [int(r, 50), int(r, 50), 50 + int(r, 50), 50 + int(r, 50)], { note_list: [token(r)] });
  if (f === "event_ref_list") return { ...eventRef("h" + token(r), int(r, 5)), attribute_list: [] };
  if (f === "alternate_names") return { _class: "Name", first_name: token(r), surname_list: [{ _class: "Surname", surname: token(r), primary: true }] };
  if (f === "attribute_list") return { _class: "Attribute", type: { _class: "AttributeType", value: int(r, 4), string: "" }, value: token(r) };
  return { _class: "Url", path: "https://example.test/" + token(r), desc: token(r) };
}

// every scalar leaf of an object, with a keyed path computed from the object's present state
function leaves(obj) {
  const out = [];
  const walk = (node, path, listName) => {
    if (Array.isArray(node)) {
      node.forEach((el, i) => {
        if (el !== null && typeof el === "object" && !Array.isArray(el)) walk(el, path + "/" + keySegment(listName, node, i), undefined);
      });
      return;
    }
    for (const [k, v] of Object.entries(node)) {
      if (k === "handle" || k === "_class" || k === "change") continue;
      if (Array.isArray(v)) walk(v, path + "/" + k, k);
      else if (v !== null && typeof v === "object") walk(v, path + "/" + k, undefined);
      else out.push({ path: path + "/" + k, value: v });
    }
  };
  walk(obj, "", undefined);
  return out;
}
const newLeaf = (r, v) => (typeof v === "string" ? token(r) : typeof v === "number" ? v + 1 + int(r, 9) : !v);

describe("property: applying ops and then their inverses restores the original object", () => {
  const SEQUENCES = 1500;

  it(`${SEQUENCES} random op sequences, applied one op at a time and undone in reverse`, () => {
    let applied = 0;
    for (let seed = 1; seed <= SEQUENCES; seed++) {
      const r = rng(seed);
      const original = randomPerson(r);
      let state = { [P]: deepClone(original) };
      const undo = [];
      const steps = 1 + int(r, 8);
      for (let s = 0; s < steps; s++) {
        const obj = state[P];
        const kind = pick(r, ["set", "set", "add", "remove", "move"]);
        let op = null;
        const f = pick(r, LISTS);
        const arr = obj[f];
        if (kind === "set") {
          const ls = leaves(obj);
          const leaf = pick(r, ls);
          op = { id: `o${s}`, op: "set", obj: P, path: leaf.path, base: leaf.value, value: newLeaf(r, leaf.value) };
        } else if (kind === "add") {
          op = { id: `o${s}`, op: "add", obj: P, path: "/" + f, value: randomElement(r, f) };
          if (arr.length && r() < 0.5) op.before = keySegment(f, arr, int(r, arr.length));
        } else if (kind === "remove" && arr.length) {
          const i = int(r, arr.length);
          op = { id: `o${s}`, op: "remove", obj: P, path: `/${f}/${keySegment(f, arr, i)}`, base: arr[i] };
        } else if (kind === "move" && arr.length > 1) {
          const i = int(r, arr.length);
          op = { id: `o${s}`, op: "move", obj: P, path: `/${f}/${keySegment(f, arr, i)}` };
          if (r() < 0.7) {
            const j = int(r, arr.length);
            if (j !== i) op.before = keySegment(f, arr, j);
          }
        }
        if (!op) continue;
        const res = applyOps(state, [op]);
        assert.equal(res.ok, true, `seed ${seed} step ${s}: ${JSON.stringify(res.conflicts)} op ${JSON.stringify(op)}`);
        if (res.results[0].status === "noop") continue;
        undo.push(res.inverse);
        state = res.objects;
        applied++;
      }
      for (const inv of undo.reverse()) {
        const res = applyOps(state, inv);
        assert.equal(res.ok, true, `seed ${seed}: inverse failed ${JSON.stringify(res.conflicts)}`);
        state = res.objects;
      }
      assert.deepEqual(state[P], original, `seed ${seed}`);
    }
    assert.ok(applied > SEQUENCES * 2, "the generator produced real work");
  });

  it(`${SEQUENCES} random batches whose keys all come from the base, undone by one inverse batch`, () => {
    let sets = 0;
    let structural = 0;
    for (let seed = 10_001; seed < 10_001 + SEQUENCES; seed++) {
      const r = rng(seed);
      const base = randomPerson(r);
      const ops = [];
      // phase 1: edits inside elements, at distinct leaves, by base key
      const ls = shuffle(r, leaves(base));
      const nSets = int(r, 5);
      for (let i = 0; i < nSets && i < ls.length; i++) {
        ops.push({ id: `s${i}`, op: "set", obj: P, path: ls[i].path, base: ls[i].value, value: newLeaf(r, ls[i].value) });
        sets++;
      }
      // phase 2: remove, move or add on distinct elements, even ones edited in phase 1
      const claimed = new Map(); // list -> Set of indexes that are a subject or an anchor
      const nStruct = int(r, 5);
      for (let i = 0; i < nStruct; i++) {
        const f = pick(r, LISTS);
        const arr = base[f];
        const taken = claimed.get(f) || new Set();
        claimed.set(f, taken);
        const free = arr.map((_, k) => k).filter((k) => !taken.has(k));
        const kind = pick(r, ["remove", "move", "add"]);
        if (kind === "add") {
          const op = { id: `a${i}`, op: "add", obj: P, path: "/" + f, value: randomElement(r, f) };
          if (free.length && r() < 0.5) {
            const k = pick(r, free);
            taken.add(k);
            op.before = keySegment(f, arr, k);
          }
          ops.push(op);
        } else if (free.length) {
          const k = pick(r, free);
          taken.add(k);
          if (kind === "remove") ops.push({ id: `r${i}`, op: "remove", obj: P, path: `/${f}/${keySegment(f, arr, k)}`, base: arr[k] });
          else {
            const op = { id: `m${i}`, op: "move", obj: P, path: `/${f}/${keySegment(f, arr, k)}` };
            const anchors = free.filter((x) => x !== k);
            if (anchors.length && r() < 0.7) {
              const a = pick(r, anchors);
              taken.add(a);
              op.before = keySegment(f, arr, a);
            }
            ops.push(op);
          }
        } else continue;
        structural++;
      }
      if (!ops.length) continue;
      const res = applyOps({ [P]: base }, ops);
      assert.equal(res.ok, true, `seed ${seed}: ${JSON.stringify(res.conflicts)}`);
      const back = applyOps(res.objects, res.inverse);
      assert.equal(back.ok, true, `seed ${seed}: inverse batch ${JSON.stringify(back.conflicts)}`);
      assert.deepEqual(back.objects[P], base, `seed ${seed}`);
      // and the same batch rebased onto the unchanged base is clean and gives the same result
      const rb = rebaseOps(ops, { [P]: base });
      assert.equal(rb.status, "clean", `seed ${seed}`);
      assert.deepEqual(rb.objects[P], res.objects[P], `seed ${seed}`);
    }
    assert.ok(sets > 500 && structural > 500, "the generator produced real work");
  });

  it("creates and deletes of whole objects invert too", () => {
    for (let seed = 1; seed <= 200; seed++) {
      const r = rng(seed);
      const original = { [P]: randomPerson(r), ["Family:" + H(80)]: family(H(80)) };
      const ops = [
        { id: "c", op: "create", obj: "new:1", cls: "Family", value: family("x") },
        { id: "a", op: "add", obj: "new:1", path: "/child_ref_list", value: { _class: "ChildRef", ref: "new:1" } },
        { id: "d", op: "delete", obj: "Family:" + H(80), base: hashObject(original["Family:" + H(80)]) },
      ];
      const res = applyOps(original, ops);
      assert.equal(res.ok, true, JSON.stringify(res.conflicts));
      assert.equal(Object.keys(res.objects).length, 2);
      assert.deepEqual(applyOps(res.objects, res.inverse).objects, original);
    }
  });
});

// ---- purity ----------------------------------------------------------------------------------------------------
describe("purity", () => {
  it("imports nothing: no AWS SDK, no node: module, no network or filesystem access", () => {
    const src = readFileSync(OPS_SOURCE, "utf8");
    assert.equal(/^\s*import\s/m.test(src), false, "no static import");
    assert.equal(/\bimport\s*\(/.test(src), false, "no dynamic import");
    assert.equal(/\brequire\s*\(/.test(src), false, "no require");
    for (const banned of ["@aws-sdk", "node:", "fetch(", "XMLHttpRequest", "process.env", "fs."]) assert.equal(src.includes(banned), false, `source mentions ${banned}`);
  });
  it("loads with the global network functions removed", async () => {
    const saved = globalThis.fetch;
    globalThis.fetch = () => { throw new Error("network"); };
    try {
      const m = await import("../../src/records/ops.js?pure");
      assert.equal(m.applyOps({}, []).ok, true);
    } finally {
      globalThis.fetch = saved;
    }
  });
});
