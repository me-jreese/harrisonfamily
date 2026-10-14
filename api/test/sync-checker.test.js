// HFY-TSK-245: the server privacy checker (src/sync/checker.js) against the redaction golden vectors, and the cross-object
// rules against the batch vectors (test/vectors/validator-batches.json). Synthetic objects only.
import { describe, expect, it } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { createFakeDdb, cmds } from "./world.js";
import { batchViolations, privacyVerdict } from "../src/sync/checker.js";
import { loadPolicy } from "../src/records/guard.js";
import { headItem, objectJson } from "../src/sync/store.js";
import { createStoreView } from "../src/sync/view.js";
import { rectViolations, schemaViolations } from "../src/sync/schema.js";

const policy = loadPolicy();
const redaction = new URL("../../gramps/redaction/", import.meta.url);
const vectors = readdirSync(new URL("vectors/", redaction)).filter((f) => f.endsWith(".json")).sort()
  .flatMap((f) => JSON.parse(readFileSync(new URL(`vectors/${f}`, redaction), "utf8")).vectors);
const batches = JSON.parse(readFileSync(new URL("./vectors/validator-batches.json", import.meta.url), "utf8")).vectors;

describe("redaction golden vectors: the server verdict", () => {
  it("runs every vector", () => {
    expect(vectors.length).toBeGreaterThanOrEqual(90);
    expect(new Set(vectors.map((v) => v.id)).size).toBe(vectors.length);
  });
  for (const v of vectors) {
    it(`${v.id}: expected.server, with RFC 6901 pointers`, () => {
      const got = privacyVerdict(v.input, policy);
      expect(got).toEqual(v.expected.server);
      for (const x of got.violations) expect(x.pointer === "" || x.pointer.startsWith("/")).toBe(true);
    });
  }
  it("every server-detect rule of the policy is exercised by a vector with a violation", () => {
    const fired = new Set(vectors.flatMap((v) => v.expected.server.violations.map((x) => x.rule)));
    const detect = policy.rules.filter((r) => r.server === "detect").map((r) => r.id);
    expect(detect.filter((id) => !fired.has(id))).toEqual([]);
  });
  it("a projection (expected.projection) of every vector passes the server", () => {
    for (const v of vectors) {
      const projected = Object.values(v.expected.projection).filter((o) => o && typeof o === "object");
      expect(privacyVerdict(projected, policy), v.id).toEqual({ ok: true, violations: [] });
    }
  });
});

// ---- cross-object vectors ----------------------------------------------------------------------------------------------

/** A store view over a list of objects, in memory. */
function memoryStore(objects) {
  const live = objects.map((o) => ({ class: o._class, handle: o.handle, obj: o }));
  const get = async (cls, handle) => {
    const hit = live.find((r) => r.class === cls && r.handle === handle);
    return hit ? { class: cls, handle, deleted: false, obj: hit.obj } : null;
  };
  const cited = (o, h) => (o.citation_list ?? []).includes(h) || (o.event_ref_list ?? []).some((r) => (r.citation_list ?? []).includes(h));
  const referrers = async (cls, handle) => live.filter((r) => (cls === "Event" ? (r.class === "Person" || r.class === "Family") && (r.obj.event_ref_list ?? []).some((e) => e.ref === handle) : cls === "Citation" ? ["Event", "Person", "Family"].includes(r.class) && cited(r.obj, handle) : false));
  return { get, referrers };
}

/** The same store, as head items in the fake table behind the real store view. */
function ddbStore(objects) {
  const ddb = createFakeDdb();
  objects.forEach((o, i) => {
    const item = headItem({ class: o._class, handle: o.handle, gramps_id: o.gramps_id, version: 1, seq: i + 1, deleted: false, objJson: objectJson(o), at: "2026-10-14T00:00:00.000Z", by: "svc-test", origin: "desktop" });
    ddb.rows.set(`${item.PK}\u0000${item.SK}`, item);
  });
  return createStoreView({ ddb, cmds, table: "hfy-app" });
}

describe("cross-object vectors: the batch against the store view", () => {
  it("has at least 10 vectors, with unique ids", () => {
    expect(batches.length).toBeGreaterThanOrEqual(10);
    expect(new Set(batches.map((v) => v.id)).size).toBe(batches.length);
    expect(batches.filter((v) => v.expected.length > 0).length).toBeGreaterThanOrEqual(10);
  });
  for (const [label, makeStore] of [["in-memory store", memoryStore], ["store view over the table", ddbStore]]) {
    for (const v of batches) {
      it(`${v.id} (${label}): ${v.title}`, async () => {
        const got = await batchViolations({ ops: v.ops, store: makeStore(v.store), policy });
        expect(got.map(({ rule, handle, pointer }) => ({ rule, handle, pointer }))).toEqual(v.expected);
        for (const x of got) expect(x.op_id).toBeTypeOf("string"); // every finding names the op that caused the check
      });
    }
  }
});

// ---- the synthetic fixture tree ----------------------------------------------------------------------------------------------

describe("the synthetic fixture tree (gramps/tests/fixtures)", () => {
  const fixture = new URL("../../gramps/tests/fixtures/", import.meta.url);
  const objects = readFileSync(new URL("synthetic-tree.jsonl", fixture), "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l));
  const census = JSON.parse(readFileSync(new URL("synthetic-tree.census.json", fixture), "utf8"));
  const verdict = privacyVerdict(objects, policy);
  const idOf = new Map(objects.map((o) => [o.handle, o.gramps_id]));
  const idsWith = (rule) => new Set(verdict.violations.filter((v) => v.rule === rule).map((v) => idOf.get(v.handle)));

  it("is refused as a whole, and a rule fires on the object the census names for it", () => {
    expect(verdict.ok).toBe(false);
    const pairs = [
      ["note_with_email", "scan.email"], ["note_with_phone", "scan.phone"], ["note_with_po_box", "scan.po_box"], ["note_with_street_address", "scan.street_address"],
      ["note_with_dob_prose", "scan.dob_heuristic"], ["building_place", "place.exclude.type"], ["farm_place", "place.exclude.type"], ["number_place", "place.exclude.type"],
      ["custom_home_place", "place.exclude.custom_home_like"], ["place_six_decimal_coordinates", "place.coordinates.round"], ["private_person", "private.object.exclude"],
      ["private_family", "private.object.exclude"], ["private_primary_name", "private.name.hold_person"], ["url_email_type", "contact.url.email_type"],
      ["url_contact_channel", "contact.url.channel"], ["lds_ordinance", "birth.lds_ord"], ["person_address", "contact.address_list"], ["repository_address", "contact.address_list"],
      ["attribute_ssn", "contact.attribute.government_id"], ["attribute_age", "birth.attribute.age_time"], ["private_url", "private.element.urls"],
      ["private_alternate_name", "private.element.alternate_names"], ["street_place_with_alt_loc_fields", "contact.alt_loc.fields"],
    ];
    for (const [key, rule] of pairs) for (const id of census[key]) expect(idsWith(rule), `${key} ${id} ${rule}`).toContain(id);
  });

  it("the schema accepts every object but the two with a bad rect, and the rect rule names exactly those", () => {
    const badSchema = objects.filter((o) => schemaViolations(o).length > 0).map((o) => o.gramps_id).sort();
    expect(badSchema).toEqual([...census.rect_float].sort());
    const rect = objects.flatMap((o) => rectViolations(o, policy).map((v) => [o.gramps_id, v.rule]));
    expect(rect.sort()).toEqual([[census.rect_float[0], "media.rect.degenerate_or_float"], [census.rect_full_frame_0_0_100_100[0], "media.rect.full_frame"]].sort());
  });
});
