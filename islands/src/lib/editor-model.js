// The editor island's pure model (HFY-TSK-212, editor-island-shell; HFY-PLN-002 editing.md section 9.1, BRD2 R-08 and R-09). No DOM and no
// React, so a node test pins the words and the rules (tests/editor-model.test.mjs): the /edit/ route, which entry button a viewer sees, the
// section registry, and the mode of a field. The mode comes from the policy table the edit bundle serves (api/src/records/field-policy.js
// `document()`); it is a UX hint only, because the server decides on every write (a field "saves now" in the badge but the API may still
// route the change to review). Copy is lowercase, plain, and never says "record", "users" or "members".

/** The editable classes by the lowercase name the URL uses (`/edit/?cls=person&id=I0001`); the API wants the capitalised class. */
export const EDIT_CLASSES = Object.freeze({
  person: "Person", family: "Family", event: "Event", place: "Place", source: "Source", citation: "Citation", repository: "Repository", media: "Media", note: "Note"
});

import { NAME_FIELDS, nameValues } from "./editor-names.js";

const REF = /^(?:h:[A-Za-z0-9_-]{1,64}|[A-Za-z0-9._-]{1,64})$/;

/** `?cls=person&id=I0001` -> `{ cls: "Person", ref: "I0001" }`; a missing or unknown class defaults to Person only when an id is there; null if nothing editable is named. */
export function parseRoute(search) {
  let q;
  try { q = new URLSearchParams(search || ""); } catch { return null; }
  const ref = (q.get("id") || "").trim();
  if (!ref || !REF.test(ref)) return null;
  const raw = (q.get("cls") || "person").trim().toLowerCase();
  const cls = EDIT_CLASSES[raw];
  return cls ? { cls, ref } : null;
}

/** The editor URL for a class and a gramps id (or `h:<handle>`). */
export const editHref = (cls, ref) => `/edit/?cls=${encodeURIComponent(String(cls || "Person").toLowerCase())}&id=${encodeURIComponent(ref)}`;

export const COPY = Object.freeze({
  entryOwn: "edit my info",
  entrySuggest: "suggest a change",
  entryAdmin: "edit",
  title: "edit",
  loading: "loading the editor",
  off: "editing isn't turned on yet.",
  signedOut: "sign in to edit.",
  signIn: "sign in",
  notFound: "we couldn't find that page to edit.",
  loadFailed: "the editor didn't load. try again in a moment.",
  noRoute: "pick a page to edit from its own page.",
  back: "back to the page",
  sections: "sections",
  soon: "editing this part is coming soon.",
  ownIntro: "this is your page. what you change here is saved right away, except a few things that go to review first.",
  otherIntro: "this isn't your page, so your changes go to the family to look over before they show.",
  adminIntro: "you can change anything on this page. some things only an admin can change.",
  pendingField: "a change is waiting for review",
  modeDirect: "saves now",
  modeProposal: "goes to review",
  modeAdmin: "only an admin can change this",
  modeLocked: "can't be changed on the site"
});

/**
 * Which entry button a viewer sees on a person page, or null for none. `me` is getMe()'s answer; `personId` the page's gramps id.
 * Own page (the viewer's own record, from /api/me ownRecord, or their id): "edit my info". Else an admin: "edit". Else "suggest a change".
 * Signed out, or the API says editing is off (me.editing === false): nothing. A missing `editing` (an older API) is not "off".
 */
export function entryMode(me, personId) {
  if (!me || typeof me.id !== "string" || !me.id || !personId) return null;
  if (me.editing === false) return null;
  const own = me.ownRecord && typeof me.ownRecord === "object" ? me.ownRecord.gramps_id : null;
  if (own === personId || me.id === personId) return "own";
  return me.admin === true ? "admin" : "suggest";
}
export const ENTRY_LABEL = Object.freeze({ own: COPY.entryOwn, suggest: COPY.entrySuggest, admin: COPY.entryAdmin });

// ---- the field mode ---------------------------------------------------------------------------------------------------
// A client copy of field-policy.js matching (pattern segments: literal, `*` one segment, `**` any run including none, `{a,b}`
// alternatives; the most restrictive row class wins, then the more specific pattern, then the later row). Conditional rows (`when`)
// are not judged here (the client has no record context): they match like any row, as findRow() does server-side with no ctx, so the
// stricter class (never > desk/derived > the rest) outranks a looser one; the badge never says "saves now" where a conditional row says never.
const SCORE = { any: 0, one: 1, lit: 3, alt: 3 };
const FIXED = new Set(["never", "desk", "derived"]);
function seg(s) {
  if (s === "**") return { t: "any" };
  if (s === "*") return { t: "one" };
  if (s.startsWith("{") && s.endsWith("}")) return { t: "alt", set: new Set(s.slice(1, -1).split(",")) };
  return { t: "lit", v: s };
}
function match(pat, i, ptr, j) {
  if (i === pat.length) return j === ptr.length;
  const s = pat[i];
  if (s.t === "any") {
    for (let k = j; k <= ptr.length; k++) if (match(pat, i + 1, ptr, k)) return true;
    return false;
  }
  if (j === ptr.length) return false;
  if (s.t === "one") return match(pat, i + 1, ptr, j + 1);
  if (s.t === "lit") return s.v === ptr[j] && match(pat, i + 1, ptr, j + 1);
  return s.set.has(ptr[j]) && match(pat, i + 1, ptr, j + 1);
}

/** Compile the bundle's `policy` document once: `resolve(cls, pointer, viewer)` -> "direct" | "proposal" | "admin" | "desk" | "never" | "derived". */
export function createModeResolver(policy) {
  const rows = (policy && Array.isArray(policy.rows) ? policy.rows : []).map((r, order) => {
    const segs = r.pointer === "" ? [] : String(r.pointer).slice(1).split("/").map(seg);
    return { ...r, segs, order, prio: r.own === "never" ? 2 : FIXED.has(r.own) ? 1 : 0, score: segs.reduce((n, s) => n + SCORE[s.t], 0) };
  });
  return {
    // `lenient`: a conditional row that refuses (never, desk, derived) is left out. The client cannot judge its condition (it has no record
    // context), so by default it counts, as the server does with no context; a list row, whose condition is about the value it holds, is
    // hinted without it and the server refuses the value itself if it must.
    resolve(cls, pointer, viewer = {}, { lenient = false } = {}) {
      const ptr = pointer === "" ? [] : String(pointer).slice(1).split("/");
      let best = null;
      for (const r of rows) {
        if (r.cls !== cls || !match(r.segs, 0, ptr, 0)) continue;
        if (lenient && r.when && FIXED.has(r.own)) continue;
        if (!best || r.prio > best.prio || (r.prio === best.prio && (r.score > best.score || (r.score === best.score && r.order > best.order)))) best = r;
      }
      if (!best) return viewer.admin ? "direct" : "proposal";
      return viewer.admin ? best.admin : viewer.relation === "own" ? best.own : best.other;
    }
  };
}

/** The badge a code earns: { key, text }. direct and proposal are the two common ones; admin is "only an admin can change this" for a member (an admin sees "saves now"). */
export function badgeFor(code) {
  if (code === "direct") return { key: "direct", text: COPY.modeDirect };
  if (code === "proposal") return { key: "proposal", text: COPY.modeProposal };
  if (code === "admin") return { key: "admin", text: COPY.modeAdmin };
  return { key: "locked", text: COPY.modeLocked };
}

/** Every badge text, for the copy test. */
export const allBadgeText = () => ["direct", "proposal", "admin", "never"].map((c) => badgeFor(c).text);

// ---- the sections -----------------------------------------------------------------------------------------------------
// The section registry per class. A section with `form` is rendered by one SchemaForm over the listed fields of a schema definition
// (`from` names the $def; `prefix` is the record pointer the form sits under, so a field's policy pointer is prefix + the form pointer, or
// `pointers[field]` where the field does not sit there). A section with `lists` holds list editors (editor-sections.js LIST_ADAPTERS): rows
// that are added, changed and removed, each row its own small SchemaForm. The rest are frames the later tasks fill (editor-other-records,
// the links and family sections). `adminOnly` sections are hidden from members.
export const PERSON_SECTIONS = Object.freeze([
  {
    id: "names", title: "names", lists: ["alt"],
    form: { from: "Name", prefix: "/primary_name", fields: NAME_FIELDS, names: true, widgets: { first_name: "givenNames", call: "callName" }, pointers: { surname: "/primary_name/surname_list/0/surname" } }
  },
  { id: "events", title: "life events", lists: ["events"] },
  { id: "facts", title: "facts", lists: ["facts"] },
  { id: "notes", title: "notes", lists: ["notes"] },
  { id: "photos", title: "photos", lists: ["photos"] },
  { id: "links", title: "links" },
  { id: "connected", title: "people connected to you", lists: ["connected"] },
  { id: "sources", title: "sources", lists: ["sources"] },
  { id: "family", title: "family" },
  { id: "more", title: "more", adminOnly: true }
]);

const OTHER_SECTIONS = Object.freeze([{ id: "details", title: "details" }]);

/** The sections the viewer sees for a class, in order. */
export function sectionsFor(cls, viewer = {}) {
  const all = cls === "Person" ? PERSON_SECTIONS : OTHER_SECTIONS;
  return all.filter((s) => !s.adminOnly || viewer.admin === true);
}

/** The line under the page title for the viewer's relation to the record. */
export const introFor = (viewer = {}) => (viewer.admin ? COPY.adminIntro : viewer.relation === "own" ? COPY.ownIntro : COPY.otherIntro);

/**
 * The inputSchema of a section's form: the named fields of the schema definition `from`, retitled in the family's words. The virtual
 * `surname` field is the Surname definition's own `surname`; `form.widgets` names the host widget of a field. Returns null when the schema
 * lacks the definition (the section then shows the frame only).
 */
export function sectionSchema(schema, form) {
  const def = schema && schema.$defs && schema.$defs[form.from];
  if (!def || !def.properties) return null;
  const properties = {};
  for (const [key, title] of form.fields) {
    const sn = schema.$defs.Surname && schema.$defs.Surname.properties;
    const prop = form.names && key === "surname" ? (sn && sn.surname) || { type: "string", maxLength: 100 } : def.properties[key];
    if (!prop) continue;
    properties[key] = { ...prop, title, ...(form.widgets && form.widgets[key] ? { "x-io-widget": form.widgets[key] } : {}) };
  }
  if (!Object.keys(properties).length) return null;
  return { type: "object", additionalProperties: false, properties };
}

/** The record pointer a form field's policy is read at (`pointer` is the form's own, "/first_name"). */
export function fieldPointer(form, pointer) {
  const field = String(pointer).split("/")[1];
  return (form.pointers && form.pointers[field]) || `${form.prefix}${pointer}`;
}

/** The values for a section form, read from the record at the form's prefix (a string field missing from the record starts empty). */
export function sectionValues(obj, form) {
  if (form.names) return nameValues(obj);
  const base = form.prefix.split("/").filter(Boolean).reduce((o, k) => (o && typeof o === "object" ? o[k] : undefined), obj);
  const out = {};
  for (const [key] of form.fields) {
    const v = base && typeof base === "object" ? base[key] : undefined;
    if (typeof v === "string" && v !== "") out[key] = v;
  }
  return out;
}
