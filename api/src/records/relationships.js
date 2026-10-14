// Relationship intent compiler (HFY-TSK-251, relationship-compiler): turns what an older, non-technical member says
// ("these are my parents", "this is my child", "this is my spouse", "something's wrong") into the EditOps that
// make Gramps' Family and ChildRef objects say it. Editing design section 8 (R-24).
//
//   intent -> ops   parents | children | spouse | unlink (design 8.2). The client sends INTENTS, never ops.
//   reuse           an existing family with the same parents is reused before a new one is made (Gramps' own warning,
//                   "it is possible to accidentally create multiple families with the same parents", in reverse).
//   single parent   a parent's single-parent family is reused. A second parent fills its empty slot only when the
//                   family has no children; with children the slot stays empty, a new family is made and the result
//                   carries the warning `single_parent_family_has_children` (filling it would give those children a
//                   new parent without anyone saying so).
//   slots           male -> father_handle, female -> mother_handle (Gramps' partner1/partner2); otherwise the
//                   first person chosen is partner1 and the second partner2. A lone parent: female -> mother_handle,
//                   anyone else -> father_handle.
//   order           a new family is appended to each parent's `family_list` and to the child's `parent_family_list`,
//                   after the families already there, so the main (first) parents do not change.
//   stubs           a new person: a Birth Name primary name, the chosen gender, a year-only Birth event (when a year
//                   was given), a Death event when `living` is "no" and a death year was given, and an EMPTY
//                   gramps_id. The id is minted at approval from the reserved block (Q2-03, `store-id-policy`) or
//                   assigned later by the desktop; the compiler never decides it. Every created object (Person,
//                   Family, Event, Place) has an empty gramps_id.
//   limits          more than 10 children -> `too_many_children`; an approval transaction of more than 100
//                   actions -> `proposal_too_large` (decision D2-30), counted by `approvalActionCount`.
//   checks          the compiled ops are applied to the objects, and `checkSemantics` (edit-gramps-semantics) runs
//                   on the result: two-sided links, family sense, no ancestry cycle (code `cycle`), dates. A
//                   compile that fails any of them returns no ops.
//
// NOT HERE: the R-18/R-19 privacy guard over the stub fields and the note (the record API runs `checkObjects()`
// on the whole resulting state, `edit-guard-wiring`), the 64 KB / 50 op / 10 new object caps of a proposal document
// (`proposal-store-api`; `stats` reports the numbers), and the routes (`relationship-api`).
//
// PURE. Imports are the EditOp engine, the Gramps semantics and the duplicate matcher; no AWS, no clock beyond the
// `today` the caller passes (or the default of `checkSemantics`). No route calls it yet (its first caller is
// `relationship-api`), so it ships in the `hfy-api` zip unreachable.
//
//   compileRelationship({ intent, get, version?, people?, confirmDistinct?, mint?, admin?, today?, maxActions? })
//     intent   a RelationshipIntent (design 8.2). Persons are "Person:<handle>", places "Place:<handle>", families
//              "Family:<handle>"; a new person is { new: Stub }.
//     get      (key) => Gramps JSON object | undefined | null. Persons, Families, Events (for the existing marriage
//              and the birth years) and Places.
//     version  (key) => int | undefined: the stored version of an existing object, for `base_versions`.
//     people   an iterable of matcher summaries (duplicates.js `summarizePerson`): the people the VIEWER may see.
//              Without it `duplicates` is [].
//     confirmDistinct  the `new:n` stubs the member confirmed are different people. Given (even as []), an
//              unconfirmed duplicate fails with `unconfirmed_duplicate`; absent (a preview), duplicates are reported.
//     mint     () => handle, for the throwaway handles of the validation pass and for tests. The returned ops keep
//              their `new:n` temporaries; the commit mints the real handles.
//     admin, today   passed to checkSemantics.
//     maxActions     the approval transaction budget (default 100).
//   -> { ok: true, alreadyRecorded, destructive, subject, ops, base_versions, summary, warnings, duplicates,
//        followUps, stats: { ops, created, touched, actions }, preview: { objects, minted, created, touched } }
//   -> { ok: false, errors: [{ code, message, ... }] }
//
// `ops` use `new:n` temporaries. Numbering: the stub people first (`new:1`, `new:2`, ... in the order they appear in
// the intent, which is what `duplicates[].for` and `confirmDistinct` name), then each stub's Birth and Death event,
// then a new Place, the Marriage and Divorce events, and last the Family. The `create` ops come first, in that
// order, then the changes to existing objects.
//
// `alreadyRecorded: true` means the tree already says it (ops is []); the API answers 409 `already_recorded`, which
// is informational. `destructive: true` (unlink) needs the admin's fresh sign-in at approval. `followUps` are
// offers for the wizard, e.g. `{ code: "offer_death_year", person: "Person:<h>" | "new:2" }` after "widowed".

import { applyOps, deepClone } from "./ops.js";
import { checkSemantics, computeSortval, CODES as SEM } from "./semantics.js";
import { findDuplicates, unconfirmedDuplicates } from "./duplicates.js";

export const MAX_CHILDREN = 10;
export const MAX_TXN_ACTIONS = 100;
export const MIN_GENERATION_YEARS = 13; // Gramps' `min-generation-years` default

export const ERROR = Object.freeze({
  badIntent: "bad_intent",
  unknownObject: "unknown_object",
  badStub: "bad_stub",
  tooManyChildren: "too_many_children",
  cycle: "cycle",
  proposalTooLarge: "proposal_too_large",
  unconfirmedDuplicate: "unconfirmed_duplicate",
  conflict: "compile_conflict",
});

export const WARNING = Object.freeze({
  singleParentFamilyHasChildren: "single_parent_family_has_children",
  childHasBirthParents: "child_has_birth_parents",
  parentTooYoung: "parent_too_young",
  marriageAlreadyRecorded: "marriage_already_recorded",
  divorceAlreadyRecorded: "divorce_already_recorded",
  familyHasNoParents: "family_has_no_parents",
});

// Gramps 6.0.6 values (the goldens prove them).
const GENDER = Object.freeze({ female: 0, male: 1, unknown: 2 });
const FEMALE = 0;
const MALE = 1;
const CHILD_REL = Object.freeze({ none: 0, birth: 1, adopted: 2, step: 3, sponsored: 4, foster: 5, unknown: 6 });
const BIRTH = 1;
const FAMILY_REL = Object.freeze({ married: 0, unmarried: 1, civil_union: 2, unknown: 3 });
const FAMILY_REL_NAME = Object.freeze({ 0: "married", 1: "unmarried", 2: "civil union", 3: "unknown", 4: "custom" });
const EVENT = Object.freeze({ MARRIAGE: 1, DIVORCE: 7, BIRTH: 12, DEATH: 13 });
const ROLE = Object.freeze({ PRIMARY: 1, FAMILY: 8 });
const NAME_TYPE_BIRTH = 2;
// Place types a member may name. Street (7), Building (19) and Number (20) never go in the cloud (field policy).
const PLACE_TYPES = Object.freeze({
  Country: 1, State: 2, County: 3, City: 4, Parish: 5, Locality: 6, Province: 8, Region: 9, Department: 10,
  Neighborhood: 11, District: 12, Borough: 13, Municipality: 14, Town: 15, Village: 16, Hamlet: 17, Farm: 18,
});

// The approval transaction (sync design 4.1, editing design 5.2; decision D2-30): the batch's fixed items, two per
// object (head and log), one more per created object (the GID guard that mints its id), and the proposal's own
// items (META, the by-proposer copy, the audit) plus one per-record copy for every target.
export const TXN_COST = Object.freeze({ batchFixed: 3, perObject: 2, perCreate: 1, proposalFixed: 3, perTarget: 1 });

export function approvalActionCount({ touched = 0, created = 0, extra = 0 }) {
  const objects = touched + created;
  return TXN_COST.batchFixed + TXN_COST.perObject * objects + TXN_COST.perCreate * created + TXN_COST.proposalFixed + TXN_COST.perTarget * objects + extra;
}

class RelError extends Error {
  constructor(code, message, extra = {}) {
    super(message);
    this.code = code;
    this.extra = extra;
  }
}
const fail = (code, message, extra) => {
  throw new RelError(code, message, extra);
};
const bad = (message, extra) => fail(ERROR.badIntent, message, extra);

const isPlain = (v) => v !== null && typeof v === "object" && !Array.isArray(v);
const asList = (v) => (Array.isArray(v) ? v : []);
const classOf = (key) => key.slice(0, key.indexOf(":"));
const handleOf = (key) => key.slice(key.indexOf(":") + 1);
const TEMP = /^new:\d+$/;

// ---------------------------------------------------------------------------------------------------------------
// Gramps JSON builders (the shapes Gramps 6.0.6 itself stores; the goldens compare them object by object)
// ---------------------------------------------------------------------------------------------------------------
const typed = (cls, value) => ({ _class: cls, string: "", value });
const blankDate = () => ({ _class: "Date", calendar: 0, dateval: [0, 0, 0, false], format: null, modifier: 0, newyear: 0, quality: 0, sortval: 0, text: "" });

function yearDate(year, about = false) {
  const d = { _class: "Date", calendar: 0, dateval: [0, 0, year, false], format: null, modifier: about ? 3 : 0, newyear: 0, quality: 0, sortval: 0, text: "" };
  d.sortval = computeSortval(d);
  return d;
}

const childRef = (ref, frel, mrel) => ({ _class: "ChildRef", citation_list: [], frel: typed("ChildRefType", frel), mrel: typed("ChildRefType", mrel), note_list: [], private: false, ref });
const eventRef = (ref, role) => ({ _class: "EventRef", attribute_list: [], citation_list: [], note_list: [], private: false, ref, role: typed("EventRoleType", role) });

function personValue(stub, { events, family_list, parent_family_list }) {
  const surnames = stub.surname ? [{ _class: "Surname", connector: "", origintype: typed("NameOriginType", 1), prefix: "", primary: true, surname: stub.surname }] : [];
  return {
    _class: "Person",
    address_list: [],
    alternate_names: [],
    attribute_list: [],
    birth_ref_index: events.birth === null ? -1 : 0,
    change: 0,
    citation_list: [],
    death_ref_index: events.death === null ? -1 : events.birth === null ? 0 : 1,
    event_ref_list: [events.birth, events.death].filter((e) => e !== null).map((e) => eventRef(e, ROLE.PRIMARY)),
    family_list,
    gender: GENDER[stub.gender],
    gramps_id: "",
    lds_ord_list: [],
    media_list: [],
    note_list: [],
    parent_family_list,
    person_ref_list: [],
    primary_name: {
      _class: "Name",
      call: "",
      citation_list: [],
      date: blankDate(),
      display_as: 0,
      famnick: "",
      first_name: stub.given,
      group_as: "",
      nick: "",
      note_list: [],
      private: false,
      sort_as: 0,
      suffix: "",
      surname_list: surnames,
      title: "",
      type: typed("NameType", NAME_TYPE_BIRTH),
    },
    private: false,
    tag_list: [],
    urls: [],
  };
}

const eventValue = (type, date, place) => ({
  _class: "Event", attribute_list: [], change: 0, citation_list: [], date, description: "", gramps_id: "", media_list: [], note_list: [], place: place || "", private: false, tag_list: [], type: typed("EventType", type),
});

const familyValue = ({ father, mother, children, events, type }) => ({
  _class: "Family",
  attribute_list: [],
  change: 0,
  child_ref_list: children,
  citation_list: [],
  complete: 0,
  event_ref_list: events,
  father_handle: father,
  gramps_id: "",
  lds_ord_list: [],
  media_list: [],
  mother_handle: mother,
  note_list: [],
  private: false,
  tag_list: [],
  type: typed("FamilyRelType", type),
});

const placeValue = (name, type, enclosedBy) => ({
  _class: "Place",
  alt_loc: [],
  alt_names: [],
  change: 0,
  citation_list: [],
  code: "",
  gramps_id: "",
  lat: "",
  long: "",
  media_list: [],
  name: { _class: "PlaceName", date: blankDate(), lang: "", value: name },
  note_list: [],
  place_type: typed("PlaceType", type),
  placeref_list: enclosedBy ? [{ _class: "PlaceRef", date: blankDate(), ref: enclosedBy }] : [],
  private: false,
  tag_list: [],
  title: "",
  urls: [],
});

// ---------------------------------------------------------------------------------------------------------------
// Slots
// ---------------------------------------------------------------------------------------------------------------

// Where the people chosen go in a new family. `a` and `b` are in selection order and carry a Gramps `gender`.
export function assignSlots(a, b) {
  if (!b) return a.gender === FEMALE ? { father: null, mother: a } : { father: a, mother: null };
  const male = (e) => e.gender === MALE;
  const female = (e) => e.gender === FEMALE;
  if (male(a) && !male(b)) return { father: a, mother: b };
  if (male(b) && !male(a)) return { father: b, mother: a };
  if (female(a) && !female(b)) return { father: b, mother: a };
  if (female(b) && !female(a)) return { father: a, mother: b };
  return { father: a, mother: b };
}

// ---------------------------------------------------------------------------------------------------------------
// The working draft
// ---------------------------------------------------------------------------------------------------------------
class Draft {
  constructor(get) {
    this.rawGet = get;
    this.cache = new Map();
    this.temp = 0;
    this.stubs = []; // stub entries, in order
    this.creates = []; // { n, temp, cls, value, tag }
    this.changes = []; // { op, tag }
    this.warnings = [];
    this.summary = [];
    this.followUps = [];
    this.destructive = false;
  }

  load(key, cls) {
    if (typeof key !== "string" || !key.includes(":")) bad("a reference must look like Class:handle", { ref: String(key) });
    if (cls && classOf(key) !== cls) bad(`expected a ${cls} reference`, { ref: key });
    if (!this.cache.has(key)) {
      const o = this.rawGet(key);
      this.cache.set(key, o ? deepClone(o) : null);
    }
    const o = this.cache.get(key);
    if (!o) fail(ERROR.unknownObject, "no such " + classOf(key).toLowerCase(), { ref: key });
    return o;
  }

  peek(key) {
    if (!this.cache.has(key)) {
      const o = this.rawGet(key);
      this.cache.set(key, o ? deepClone(o) : null);
    }
    return this.cache.get(key);
  }

  alloc() {
    return `new:${++this.temp}`;
  }

  create(temp, cls, value, tag) {
    this.creates.push({ n: Number(temp.slice(4)), temp, cls, value, tag });
  }

  change(op, tag) {
    const { id, ...rest } = op; // eslint-disable-line no-unused-vars
    this.changes.push({ op: rest, tag });
  }

  say(text, tag) {
    this.summary.push({ text, tag });
  }

  warn(w) {
    this.warnings.push(w);
  }

  personName(handle) {
    const p = this.peek(`Person:${handle}`);
    return p ? nameOfPerson(p) : "someone";
  }
}

const cleanPart = (s) => String(s).normalize("NFC").trim();

function nameOfPerson(p) {
  const n = p.primary_name || {};
  const sn = asList(n.surname_list).map((s) => s && s.surname).filter(Boolean)[0] || "";
  return [n.first_name, sn].map((s) => String(s || "").trim()).filter(Boolean).join(" ") || "someone";
}

// ---------------------------------------------------------------------------------------------------------------
// Entries: the people an intent names
// ---------------------------------------------------------------------------------------------------------------
function normalizeStub(stub, where) {
  if (!isPlain(stub)) bad("a new person needs a name", { where });
  const given = typeof stub.given === "string" ? cleanPart(stub.given) : "";
  const surname = typeof stub.surname === "string" ? cleanPart(stub.surname) : "";
  if (!given && !surname) fail(ERROR.badStub, "a new person needs a given name or a surname", { where });
  if (given.length > 100 || surname.length > 100) fail(ERROR.badStub, "a name part is longer than 100 characters", { where });
  const gender = stub.gender === undefined || stub.gender === null ? "unknown" : stub.gender;
  if (!Object.prototype.hasOwnProperty.call(GENDER, gender)) fail(ERROR.badStub, "gender must be female, male or unknown", { where });
  const year = (v, field) => {
    if (v === undefined || v === null) return null;
    if (!Number.isInteger(v)) fail(ERROR.badStub, `${field} must be a whole year`, { where });
    return v;
  };
  const living = stub.living === undefined || stub.living === null ? "unknown" : stub.living;
  if (!["yes", "no", "unknown"].includes(living)) fail(ERROR.badStub, "living must be yes, no or unknown", { where });
  return { given, surname, gender, birthYear: year(stub.birthYear, "birthYear"), living, deathYear: year(stub.deathYear, "deathYear") };
}

// Every `who` of an intent, in numbering order.
function whosOf(intent) {
  switch (intent.type) {
    case "parents":
      return asList(intent.parents).map((p) => p && p.who);
    case "children": {
      const other = intent.otherParent;
      const list = other && (other.ref || other.new) ? [other] : [];
      return list.concat(asList(intent.children).map((c) => c && c.who));
    }
    case "spouse":
      return [intent.spouse];
    default:
      return [];
  }
}

// Reserve `new:n` for each stub person, then a Birth and a Death event for each stub that has them, and return the
// entries by `who` object.
function buildEntries(d, whos) {
  const map = new Map();
  whos.forEach((who, i) => {
    if (!isPlain(who) || (who.ref === undefined) === (who.new === undefined)) bad("a person must be { ref } or { new }", { index: i });
    if (who.ref !== undefined) {
      const person = d.load(who.ref, "Person");
      map.set(who, { existing: true, key: who.ref, handle: handleOf(who.ref), person, gender: person.gender });
    } else {
      const stub = normalizeStub(who.new, `new person ${i + 1}`);
      const temp = d.alloc();
      const entry = { existing: false, key: temp, handle: temp, temp, stub, gender: GENDER[stub.gender], birth: null, death: null, family_list: [], parent_family_list: [] };
      d.stubs.push(entry);
      map.set(who, entry);
    }
  });
  for (const e of d.stubs) {
    if (e.stub.birthYear !== null) e.birth = d.alloc();
    if (e.stub.living === "no" && e.stub.deathYear !== null) e.death = d.alloc();
  }
  return map;
}

const entryName = (d, e) => (e.existing ? nameOfPerson(e.person) : [e.stub.given, e.stub.surname].filter(Boolean).join(" "));

function birthYearOf(d, e) {
  if (!e.existing) return e.stub.birthYear;
  const idx = e.person.birth_ref_index;
  const ref = Number.isInteger(idx) && idx >= 0 ? asList(e.person.event_ref_list)[idx] : null;
  const ev = ref ? d.peek(`Event:${ref.ref}`) : null;
  const y = ev && ev.date && Array.isArray(ev.date.dateval) ? ev.date.dateval[2] : 0;
  return y > 0 ? y : null;
}

// ---------------------------------------------------------------------------------------------------------------
// Families
// ---------------------------------------------------------------------------------------------------------------
const parentHandles = (f) => [f.father_handle, f.mother_handle].filter(Boolean);
const familyKey = (fh) => `Family:${fh}`;

function familiesOf(d, entry) {
  const out = [];
  for (const fh of asList(entry.person.family_list)) {
    const f = d.peek(familyKey(fh));
    if (f) out.push({ fh, f });
  }
  return out;
}

function familyLabel(d, f) {
  const names = parentHandles(f).map((h) => d.personName(h));
  return names.length ? names.join(" and ") : "an empty family";
}

const hasChild = (f, handle) => asList(f.child_ref_list).some((r) => r && r.ref === handle);

// Existing families whose parents are exactly the people chosen (all must already exist).
function findReuse(d, chosen, kidHandles) {
  if (chosen.some((e) => !e.existing)) return null;
  const want = chosen.map((e) => e.handle);
  const hits = familiesOf(d, chosen[0]).filter(({ f }) => {
    const have = parentHandles(f);
    return have.length === want.length && want.every((h) => have.includes(h));
  });
  if (!hits.length) return null;
  return hits.find(({ f }) => kidHandles.some((k) => hasChild(f, k))) || hits[0];
}

// Fill the empty slot of a single-parent family that has no children, or report the one that has children.
function findFill(d, chosen) {
  if (chosen.length !== 2) return {};
  let blocked = null;
  for (let i = 0; i < 2; i++) {
    const e = chosen[i];
    if (!e.existing) continue;
    for (const { fh, f } of familiesOf(d, e)) {
      const have = parentHandles(f);
      if (have.length !== 1 || have[0] !== e.handle) continue;
      if (asList(f.child_ref_list).length) {
        blocked = blocked || { fh, f, entry: e };
        continue;
      }
      return { fill: { fh, f, entry: chosen[1 - i], slot: f.father_handle ? "mother" : "father" } };
    }
  }
  return { blocked };
}

// Decide the family for `chosen` (selection order). Returns
//   { kind: "reuse", fh, f, slots } | { kind: "fill", fh, f, slots, slot, entry } | { kind: "new", temp, slots }
function resolveFamily(d, chosen, kidHandles) {
  const reuse = findReuse(d, chosen, kidHandles);
  if (reuse) return { kind: "reuse", fh: reuse.fh, f: reuse.f, slots: slotsOfFamily(reuse.f, chosen) };
  const { fill, blocked } = findFill(d, chosen);
  if (fill) {
    const slots = { father: null, mother: null };
    const other = chosen.find((e) => e !== fill.entry);
    slots[fill.f.father_handle ? "father" : "mother"] = other;
    slots[fill.slot] = fill.entry;
    return { kind: "fill", fh: fill.fh, f: fill.f, slots, slot: fill.slot, entry: fill.entry };
  }
  if (blocked) {
    d.warn({
      code: WARNING.singleParentFamilyHasChildren,
      family: familyKey(blocked.fh),
      detail: `${nameOfPerson(blocked.entry.person)} already has a family with no second parent and with children. A new family was made instead of adding a second parent to it; consider merging the families in Gramps.`,
    });
  }
  return { kind: "new", slots: assignSlots(chosen[0], chosen[1]) };
}

function slotsOfFamily(f, chosen) {
  const slots = { father: null, mother: null };
  for (const e of chosen) {
    if (f.father_handle === e.handle) slots.father = e;
    else if (f.mother_handle === e.handle) slots.mother = e;
  }
  return slots;
}

const slotOf = (plan, entry) => (plan.slots.father === entry ? "father" : plan.slots.mother === entry ? "mother" : null);

const REL_PHRASE = { 0: "no relationship", 1: "birth parent", 2: "adoptive parent", 3: "step-parent", 4: "sponsor", 5: "foster parent", 6: "relationship not known" };

// Put kids into the family `plan` names. kids: [{ entry, rels: [relation value per chosen entry] }].
// A new family is created here, and its `new:n` is allocated here: the family is the last numbered object, so the
// callers number everything else (stubs, their events) before they call this.
function placeKids(d, plan, chosen, kids) {
  if (plan.kind === "new") plan.temp = d.alloc();
  const fh = plan.kind === "new" ? plan.temp : plan.fh;
  const tag = `fam:${fh}`;
  const relsOf = (kid) => {
    let frel = BIRTH;
    let mrel = BIRTH;
    chosen.forEach((e, i) => {
      const slot = slotOf(plan, e);
      if (slot === "father") frel = kid.rels[i];
      else if (slot === "mother") mrel = kid.rels[i];
    });
    return { frel, mrel };
  };

  const added = []; // kids that are new to this family
  if (plan.kind === "new") {
    const children = kids.map((kid) => {
      const { frel, mrel } = relsOf(kid);
      added.push({ kid, frel, mrel });
      return childRef(kid.entry.handle, frel, mrel);
    });
    d.create(
      fh,
      "Family",
      familyValue({
        father: plan.slots.father ? plan.slots.father.handle : null,
        mother: plan.slots.mother ? plan.slots.mother.handle : null,
        children,
        events: [],
        type: FAMILY_REL.unknown,
      }),
      tag,
    );
    for (const { kid } of added) linkChild(d, kid.entry, fh, tag);
  } else {
    for (const kid of kids) {
      const { frel, mrel } = relsOf(kid);
      const e = kid.entry;
      const inFamily = hasChild(plan.f, e.handle);
      const listed = e.existing && asList(e.person.parent_family_list).includes(fh);
      if (!inFamily) d.change({ op: "add", obj: familyKey(fh), path: "/child_ref_list", value: childRef(e.handle, frel, mrel) }, tag);
      if (!listed) linkChild(d, e, fh, tag);
      if (!inFamily || !listed) added.push({ kid, frel, mrel });
    }
  }
  return { fh, added, relsOf };
}

// The child's side of the link: the family in its parent_family_list.
function linkChild(d, entry, fh, tag) {
  if (entry.existing) d.change({ op: "add", obj: entry.key, path: "/parent_family_list", value: fh }, tag);
  else entry.parent_family_list.push(fh);
}

// Warnings about the kids placed: a second set of birth parents, and a parent too young.
function kidWarnings(d, plan, added) {
  for (const { kid, frel, mrel } of added) {
    const e = kid.entry;
    const bornInto = (plan.slots.father && frel === BIRTH) || (plan.slots.mother && mrel === BIRTH);
    if (e.existing && bornInto) {
      const fhTarget = plan.fh || plan.temp;
      for (const fh of asList(e.person.parent_family_list)) {
        if (fh === fhTarget) continue;
        const f = d.peek(familyKey(fh));
        const ref = f && asList(f.child_ref_list).find((r) => r && r.ref === e.handle);
        if (ref && ref.frel && ref.mrel && ref.frel.value === BIRTH && ref.mrel.value === BIRTH) {
          d.warn({ code: WARNING.childHasBirthParents, person: e.key, detail: `${entryName(d, e)} already has birth parents recorded.` });
          break;
        }
      }
    }
    const cy = birthYearOf(d, e);
    if (cy) {
      for (const slot of ["father", "mother"]) {
        const pe = plan.slots[slot];
        const py = pe && birthYearOf(d, pe);
        if (py && cy - py < MIN_GENERATION_YEARS) {
          d.warn({ code: WARNING.parentTooYoung, person: e.key, parent: pe.key, years: cy - py, detail: `${entryName(d, pe)} would be born ${cy - py} years before ${entryName(d, e)}.` });
        }
      }
    }
  }
}

// ---------------------------------------------------------------------------------------------------------------
// Making a family happen: the shared tail of parents / children
// ---------------------------------------------------------------------------------------------------------------
function linkParents(d, plan, chosen) {
  const fh = plan.kind === "new" ? plan.temp : plan.fh;
  const tag = `fam:${fh}`;
  if (plan.kind === "new") {
    for (const e of chosen) {
      if (e.existing) d.change({ op: "add", obj: e.key, path: "/family_list", value: fh }, tag);
      else e.family_list.push(fh);
    }
  } else if (plan.kind === "fill") {
    const q = plan.entry;
    d.change({ op: "set", obj: `Family:${fh}`, path: `/${plan.slot}_handle`, base: null, value: q.handle }, tag);
    if (q.existing) d.change({ op: "add", obj: q.key, path: "/family_list", value: fh }, tag);
    else q.family_list.push(fh);
  }
}

function describeNewPeople(d) {
  for (const e of d.stubs) d.say(`adds ${entryName(d, e)} to the tree as a new person`, `stub:${e.temp}`);
}

function relWords(d, plan, chosen, rels) {
  if (rels.every((r) => r === BIRTH)) return "";
  const bits = chosen.map((e, i) => `${REL_PHRASE[rels[i]] || "parent"}: ${entryName(d, e)}`);
  return ` (${bits.join(", ")})`;
}

function listNames(d, entries) {
  const names = entries.map((e) => entryName(d, e));
  return names.length > 1 ? `${names.slice(0, -1).join(", ")} and ${names[names.length - 1]}` : names[0];
}

// ---------------------------------------------------------------------------------------------------------------
// parents
// ---------------------------------------------------------------------------------------------------------------
function planParents(d, intent) {
  const person = d.load(intent.person, "Person");
  const parents = asList(intent.parents);
  if (parents.length < 1 || parents.length > 2) bad("choose one or two parents", { count: parents.length });
  const relOf = (p) => {
    const r = p.rel === undefined || p.rel === null ? "birth" : p.rel;
    if (!Object.prototype.hasOwnProperty.call(CHILD_REL, r)) bad("unknown relationship to a parent", { rel: String(r) });
    return CHILD_REL[r];
  };
  const rels = parents.map(relOf);
  const entries = buildEntries(d, whosOf(intent));
  const chosen = parents.map((p) => entries.get(p.who));
  const me = { existing: true, key: intent.person, handle: handleOf(intent.person), person, gender: person.gender };
  const chosenHandles = chosen.map((e) => e.handle);
  if (chosenHandles.includes(me.handle)) bad("a person cannot be their own parent");
  if (chosen.length === 2 && chosenHandles[0] === chosenHandles[1]) bad("the same person was chosen twice");

  describeNewPeople(d);
  const plan = resolveFamily(d, chosen, [me.handle]);
  const kids = [{ entry: me, rels }];
  const placed = placeKids(d, plan, chosen, kids);
  linkParents(d, plan, chosen);
  kidWarnings(d, plan, placed.added);

  const rw = relWords(d, plan, chosen, rels);
  if (plan.kind === "new") {
    d.say(`makes a new family for ${listNames(d, chosen)}`, `fam:${plan.temp}`);
    d.say(`adds ${nameOfPerson(person)} as a child of ${listNames(d, chosen)}${rw}`, `fam:${plan.temp}`);
  } else if (plan.kind === "fill") {
    d.say(`adds ${entryName(d, plan.entry)} as a parent in the family of ${listNames(d, chosen.filter((e) => e !== plan.entry))}`, `fam:${plan.fh}`);
    d.say(`adds ${nameOfPerson(person)} as a child of ${listNames(d, chosen)}${rw}`, `fam:${plan.fh}`);
  } else if (placed.added.length) {
    d.say(`adds ${nameOfPerson(person)} as a child of ${listNames(d, chosen)}${rw}`, `fam:${plan.fh}`);
  }
  return { subject: intent.person };
}

// ---------------------------------------------------------------------------------------------------------------
// children
// ---------------------------------------------------------------------------------------------------------------
function planChildren(d, intent) {
  const person = d.load(intent.person, "Person");
  const kidsIn = asList(intent.children);
  if (kidsIn.length < 1) bad("choose at least one child");
  if (kidsIn.length > MAX_CHILDREN) fail(ERROR.tooManyChildren, `at most ${MAX_CHILDREN} children at a time; please send these in smaller batches`, { limit: MAX_CHILDREN, count: kidsIn.length });
  const other = intent.otherParent === undefined || intent.otherParent === null ? { unknown: true } : intent.otherParent;
  if (!isPlain(other) || (!other.unknown && other.ref === undefined && other.new === undefined)) bad("otherParent must be { ref }, { new } or { unknown: true }");
  const relOf = (r, field) => {
    const v = r === undefined || r === null ? "birth" : r;
    if (!Object.prototype.hasOwnProperty.call(CHILD_REL, v)) bad(`unknown relationship in ${field}`, { rel: String(v) });
    return CHILD_REL[v];
  };
  const entries = buildEntries(d, whosOf({ ...intent, otherParent: other }));
  const me = { existing: true, key: intent.person, handle: handleOf(intent.person), person, gender: person.gender };
  const otherEntry = other.unknown ? null : entries.get(other);
  const chosen = otherEntry ? [me, otherEntry] : [me];
  const kids = kidsIn.map((k, i) => {
    if (!isPlain(k)) bad("a child must be an object", { index: i });
    const entry = entries.get(k.who);
    return { entry, rels: otherEntry ? [relOf(k.relToMe, "relToMe"), relOf(k.relToOther, "relToOther")] : [relOf(k.relToMe, "relToMe")] };
  });
  const handles = new Set([me.handle]);
  if (otherEntry) {
    if (otherEntry.handle === me.handle) bad("the other parent cannot be the same person");
    handles.add(otherEntry.handle);
  }
  const seen = new Set();
  for (const k of kids) {
    if (handles.has(k.entry.handle)) bad("a parent cannot be their own child");
    if (seen.has(k.entry.handle)) bad("the same child was listed twice");
    seen.add(k.entry.handle);
  }

  describeNewPeople(d);
  const plan = resolveFamily(d, chosen, kids.map((k) => k.entry.handle));
  const placed = placeKids(d, plan, chosen, kids);
  linkParents(d, plan, chosen);
  kidWarnings(d, plan, placed.added);

  const tag = `fam:${plan.kind === "new" ? plan.temp : plan.fh}`;
  if (plan.kind === "new") d.say(`makes a new family for ${listNames(d, chosen)}`, tag);
  if (plan.kind === "fill") d.say(`adds ${entryName(d, plan.entry)} as a parent in the family of ${listNames(d, chosen.filter((e) => e !== plan.entry))}`, tag);
  for (const { kid } of placed.added) {
    const rw = relWords(d, plan, chosen, kid.rels);
    d.say(`adds ${entryName(d, kid.entry)} as a child of ${listNames(d, chosen)}${rw}`, tag);
  }
  return { subject: intent.person };
}

// ---------------------------------------------------------------------------------------------------------------
// spouse
// ---------------------------------------------------------------------------------------------------------------
function resolvePlace(d, place) {
  if (place === undefined || place === null) return "";
  if (!isPlain(place) || (place.ref === undefined) === (place.new === undefined)) bad("a place must be { ref } or { new }");
  if (place.ref !== undefined) {
    d.load(place.ref, "Place");
    return handleOf(place.ref);
  }
  const np = place.new;
  if (!isPlain(np) || typeof np.name !== "string" || !cleanPart(np.name)) fail(ERROR.badIntent, "a new place needs a name");
  const name = cleanPart(np.name);
  if (name.length > 100) bad("a place name is longer than 100 characters");
  const type = np.type === undefined ? "City" : np.type;
  if (!Object.prototype.hasOwnProperty.call(PLACE_TYPES, type)) bad("that kind of place cannot be added here", { type: String(type) });
  if (np.enclosedBy !== undefined && np.enclosedBy !== null) d.load(np.enclosedBy, "Place");
  const temp = d.alloc();
  d.create(temp, "Place", placeValue(name, PLACE_TYPES[type], np.enclosedBy ? handleOf(np.enclosedBy) : ""), `place:${temp}`);
  d.say(`adds the place ${name}`, `place:${temp}`);
  return temp;
}

function eventsOf(d, f, type) {
  return asList(f.event_ref_list).filter((r) => {
    const ev = r && d.peek(`Event:${r.ref}`);
    return ev && ev.type && ev.type.value === type && r.role && r.role.value === ROLE.FAMILY;
  });
}

function planSpouse(d, intent) {
  const person = d.load(intent.person, "Person");
  const relName = intent.relType === undefined || intent.relType === null ? "unknown" : intent.relType;
  if (!Object.prototype.hasOwnProperty.call(FAMILY_REL, relName)) bad("unknown kind of partnership", { relType: String(relName) });
  const wantType = FAMILY_REL[relName];
  const married = intent.married === undefined ? null : intent.married;
  if (married !== null) {
    if (!isPlain(married) || !Number.isInteger(married.year)) bad("a marriage needs a year");
  }
  const ended = intent.ended === undefined ? null : intent.ended;
  if (ended !== null) {
    if (!isPlain(ended) || !["divorced", "widowed"].includes(ended.how)) bad("a partnership ends by divorce or widowhood");
    if (ended.year !== undefined && ended.year !== null && !Number.isInteger(ended.year)) bad("the year it ended must be a whole year");
  }
  const entries = buildEntries(d, whosOf(intent));
  const me = { existing: true, key: intent.person, handle: handleOf(intent.person), person, gender: person.gender };
  const spouse = entries.get(intent.spouse);
  if (spouse.handle === me.handle) bad("a person cannot be their own spouse");
  const chosen = [me, spouse];

  describeNewPeople(d);
  // an existing family of exactly this pair
  let reuse = null;
  if (spouse.existing) {
    reuse = familiesOf(d, me).find(({ f }) => {
      const have = parentHandles(f);
      return have.length === 2 && have.includes(spouse.handle) && have.includes(me.handle);
    });
  }
  const who = listNames(d, chosen);
  const skipMarriage = !!(married && reuse && eventsOf(d, reuse.f, EVENT.MARRIAGE).length > 0);
  const skipDivorce = !!(ended && ended.how === "divorced" && reuse && eventsOf(d, reuse.f, EVENT.DIVORCE).length > 0);
  if (skipMarriage) d.warn({ code: WARNING.marriageAlreadyRecorded, family: familyKey(reuse.fh), detail: `${who} already have a marriage recorded; it was left as it is.` });
  if (skipDivorce) d.warn({ code: WARNING.divorceAlreadyRecorded, family: familyKey(reuse.fh), detail: `${who} already have a divorce recorded; it was left as it is.` });

  // the numbered objects, in order: a new place, the Marriage, the Divorce, then the Family
  const newEvents = [];
  if (married && !skipMarriage) {
    const placeHandle = resolvePlace(d, married.place);
    const t = d.alloc();
    d.create(t, "Event", eventValue(EVENT.MARRIAGE, yearDate(married.year, !!married.about), placeHandle), `event:${t}`);
    newEvents.push(t);
    d.say(`records the marriage of ${who} in ${married.about ? "about " : ""}${married.year}`, `event:${t}`);
  }
  if (ended && ended.how === "divorced" && !skipDivorce) {
    const t = d.alloc();
    d.create(t, "Event", eventValue(EVENT.DIVORCE, ended.year ? yearDate(ended.year) : blankDate(), ""), `event:${t}`);
    newEvents.push(t);
    d.say(`records the divorce of ${who}${ended.year ? " in " + ended.year : ""}`, `event:${t}`);
  }

  if (reuse) {
    const tag = `fam:${reuse.fh}`;
    if (reuse.f.type && reuse.f.type.value !== wantType) {
      d.change({ op: "set", obj: familyKey(reuse.fh), path: "/type", base: reuse.f.type, value: typed("FamilyRelType", wantType) }, tag);
      d.say(`changes the family of ${who} from ${FAMILY_REL_NAME[reuse.f.type.value] || "other"} to ${FAMILY_REL_NAME[wantType]}`, tag);
    }
    for (const t of newEvents) d.change({ op: "add", obj: familyKey(reuse.fh), path: "/event_ref_list", value: eventRef(t, ROLE.FAMILY) }, tag);
  } else {
    const slots = assignSlots(me, spouse);
    const temp = d.alloc();
    const tag = `fam:${temp}`;
    d.create(
      temp,
      "Family",
      familyValue({
        father: slots.father ? slots.father.handle : null,
        mother: slots.mother ? slots.mother.handle : null,
        children: [],
        events: newEvents.map((t) => eventRef(t, ROLE.FAMILY)),
        type: wantType,
      }),
      tag,
    );
    for (const e of chosen) {
      if (e.existing) d.change({ op: "add", obj: e.key, path: "/family_list", value: temp }, tag);
      else e.family_list.push(temp);
    }
    d.say(`makes a new family for ${who} (${FAMILY_REL_NAME[wantType]})`, tag);
  }

  if (ended && ended.how === "widowed") {
    const hasDeath = spouse.existing
      ? asList(spouse.person.event_ref_list).some((r) => {
          const ev = r && d.peek(`Event:${r.ref}`);
          return ev && ev.type && ev.type.value === EVENT.DEATH;
        })
      : spouse.death !== null;
    if (!hasDeath) d.followUps.push({ code: "offer_death_year", person: spouse.key, detail: `Add the year ${entryName(d, spouse)} died?` });
  }
  return { subject: intent.person };
}

// ---------------------------------------------------------------------------------------------------------------
// unlink
// ---------------------------------------------------------------------------------------------------------------
function planUnlink(d, intent) {
  const f = d.load(intent.family, "Family");
  const p = d.load(intent.person, "Person");
  const fh = handleOf(intent.family);
  const ph = handleOf(intent.person);
  if (intent.as !== "child" && intent.as !== "partner") bad("unlink as child or as partner");
  d.destructive = true;
  const tag = `unlink:${intent.family}`;
  const label = familyLabel(d, f);
  if (intent.as === "child") {
    const ref = asList(f.child_ref_list).find((r) => r && r.ref === ph);
    if (ref) d.change({ op: "remove", obj: intent.family, path: `/child_ref_list/@ref=${ph}`, base: ref }, tag);
    if (asList(p.parent_family_list).includes(fh)) d.change({ op: "remove", obj: intent.person, path: `/parent_family_list/@=${fh}`, base: fh }, tag);
    if (ref || asList(p.parent_family_list).includes(fh)) d.say(`removes ${nameOfPerson(p)} as a child of the family of ${label}`, tag);
  } else {
    const slot = f.father_handle === ph ? "father" : f.mother_handle === ph ? "mother" : null;
    if (slot) d.change({ op: "set", obj: intent.family, path: `/${slot}_handle`, base: ph, value: null }, tag);
    if (asList(p.family_list).includes(fh)) d.change({ op: "remove", obj: intent.person, path: `/family_list/@=${fh}`, base: fh }, tag);
    if (slot || asList(p.family_list).includes(fh)) {
      d.say(`removes ${nameOfPerson(p)} as a partner in the family of ${label}`, tag);
      const left = parentHandles(f).filter((h) => h !== ph);
      if (!left.length) {
        d.warn({
          code: WARNING.familyHasNoParents,
          family: intent.family,
          children: asList(f.child_ref_list).length,
          detail: "That family now has no parents. An admin may want to delete it or attach new parents in Gramps.",
        });
      }
    }
  }
  return { subject: intent.person };
}

// ---------------------------------------------------------------------------------------------------------------
// Finish: ops, validation, limits, duplicates
// ---------------------------------------------------------------------------------------------------------------
const PLANNERS = { parents: planParents, children: planChildren, spouse: planSpouse, unlink: planUnlink };

function finishStubs(d) {
  for (const e of d.stubs) {
    const tag = `stub:${e.temp}`;
    d.create(e.temp, "Person", personValue(e.stub, { events: { birth: e.birth, death: e.death }, family_list: e.family_list, parent_family_list: e.parent_family_list }), tag);
    if (e.birth) d.create(e.birth, "Event", eventValue(EVENT.BIRTH, yearDate(e.stub.birthYear), ""), tag);
    if (e.death) d.create(e.death, "Event", eventValue(EVENT.DEATH, yearDate(e.stub.deathYear), ""), tag);
  }
}

export function compileRelationship(opts) {
  try {
    return compile(opts);
  } catch (e) {
    if (e instanceof RelError) return { ok: false, errors: [{ code: e.code, message: e.message, ...e.extra }] };
    throw e;
  }
}

function compile(opts) {
  const { intent, get, version, people, confirmDistinct, mint, admin = false, today, maxActions = MAX_TXN_ACTIONS } = opts;
  if (!isPlain(intent)) bad("the intent must be an object");
  if (typeof get !== "function") throw new TypeError("compileRelationship needs get(key)");
  const planner = PLANNERS[intent.type];
  if (!planner) bad("unknown kind of relationship", { type: String(intent.type) });

  const d = new Draft((k) => get(k) ?? undefined);
  const { subject } = planner(d, intent);
  finishStubs(d);

  // ops: creates in temp order, then the changes
  const creates = d.creates.slice().sort((a, b) => a.n - b.n);
  const entries = [
    ...creates.map((c) => ({ op: { op: "create", obj: c.temp, cls: c.cls, value: c.value }, tag: c.tag })),
    ...d.changes,
  ];
  const ops = entries.map((e, i) => ({ id: `o${i + 1}`, ...e.op }));
  const tagIds = new Map();
  entries.forEach((e, i) => {
    if (!tagIds.has(e.tag)) tagIds.set(e.tag, []);
    tagIds.get(e.tag).push(`o${i + 1}`);
  });
  const summary = d.summary.map((s) => ({ text: s.text, opIds: tagIds.get(s.tag) || [] }));

  const createdTemps = creates.map((c) => c.temp);
  const touchedKeys = [...new Set(d.changes.map((c) => c.op.obj).filter((k) => !TEMP.test(k)))].sort();

  if (!ops.length) {
    return {
      ok: true,
      alreadyRecorded: true,
      destructive: d.destructive,
      subject,
      ops: [],
      base_versions: {},
      summary: [{ text: "the tree already says this; nothing to change", opIds: [] }],
      warnings: d.warnings,
      duplicates: [],
      followUps: d.followUps,
      stats: { ops: 0, created: 0, touched: 0, actions: 0 },
      preview: { objects: {}, minted: {}, created: [], touched: [] },
    };
  }

  // apply to the stored objects, then check the result with the Gramps rules
  const base = {};
  for (const k of touchedKeys) base[k] = d.load(k);
  const applied = applyOps(base, ops, mint ? { mint } : {});
  if (!applied.ok) {
    fail(ERROR.conflict, "the compiled changes do not apply to the stored objects", { conflicts: applied.conflicts.map((c) => ({ opId: c.opId, obj: c.obj, reason: c.reason })) });
  }
  const createdKeys = createdTemps.map((t) => `${creates.find((c) => c.temp === t).cls}:${applied.minted[t]}`);
  const after = {};
  for (const k of [...touchedKeys, ...createdKeys]) after[k] = applied.objects[k];
  const sem = checkSemantics({ before: base, after, get: (k) => d.peek(k) ?? undefined, admin, today });
  if (!sem.ok) {
    const back = new Map(createdTemps.map((t, i) => [createdKeys[i], t]));
    const errors = sem.errors.map((e) => ({ ...e, ...(e.obj && back.has(e.obj) ? { obj: back.get(e.obj) } : {}), code: e.code === SEM.ancestryCycle ? ERROR.cycle : e.code }));
    return { ok: false, errors };
  }

  const stats = { ops: ops.length, created: createdTemps.length, touched: touchedKeys.length };
  stats.actions = approvalActionCount(stats);
  if (stats.actions > maxActions) {
    fail(ERROR.proposalTooLarge, "that is too many changes at once; please send them in smaller batches", { actions: stats.actions, limit: maxActions, created: stats.created, touched: stats.touched });
  }

  // duplicates among the stubs
  const stubList = d.stubs.map((e) => ({ for: e.temp, stub: e.stub }));
  const named = new Set();
  const addNamed = (w) => {
    if (w && w.ref) named.add(handleOf(w.ref));
  };
  addNamed({ ref: intent.person });
  for (const w of whosOf(intent)) addNamed(w);
  const duplicates = stubList.length && people ? findDuplicates(stubList, people, { exclude: [...named] }) : [];
  if (Array.isArray(confirmDistinct)) {
    const missing = unconfirmedDuplicates(duplicates, confirmDistinct);
    if (missing.length) fail(ERROR.unconfirmedDuplicate, "is this the same person?", { unconfirmed: missing, duplicates });
  }

  const base_versions = {};
  if (typeof version === "function") {
    for (const k of touchedKeys) {
      const v = version(k);
      if (v !== undefined && v !== null) base_versions[k] = v;
    }
  }
  return {
    ok: true,
    alreadyRecorded: false,
    destructive: d.destructive,
    subject,
    ops,
    base_versions,
    summary,
    warnings: d.warnings,
    duplicates,
    followUps: d.followUps,
    stats,
    preview: { objects: after, minted: applied.minted, created: createdKeys, touched: touchedKeys },
  };
}
