// The relationship wizard's calls (HFY-TSK-158; editing.md section 8.2). Every call goes through the shared API client, so a signed-out edge
// session sends nothing. Pure of React so a node test can run it against a fake client (tests/wizard-api.test.mjs).
//
//   preview(intent, confirm)   POST /api/relationships/preview  ->  { view, error }   the server's sentences, warnings, duplicates, follow-ups
//   send(intent, confirm, key) POST /api/relationships          ->  the 201 body ({ proposal }, or { applied } for an admin)
//   resolveHandle(handle)      GET  /api/records/Person/:handle    -> { handle, gid, name } | null   a duplicate candidate has no Gramps id, this finds it
//   resolvePerson(gid)         GET  /api/records/Person/by-id/:gid -> { handle, gid, name } | null   (the intent names handles, the search gives ids)
//   loadFamily(handle)         GET  /api/records/Person|Family/...  -> { families, partners }      for "something's wrong" and the other parent
//   loadPlaces(gid)            GET  /api/edit/Person/:gid          -> [{ ref, name }]              the places the member's own page already holds
//
// A preview without `confirmDistinct` only REPORTS duplicates (200); one with it is the real gate, so a partly confirmed list gets 422
// unconfirmed_duplicate with the candidates in `details.candidates`: both are read the same way here.
import { api as defaultApi } from "./api.js";
import { makeLookups } from "./editor-sections.js";
import { previewView } from "./wizard-model.js";

const MAX_FAMILIES = 8;
const MAX_PEOPLE = 30;
const isObj = (v) => v !== null && typeof v === "object" && !Array.isArray(v);
const arr = (v) => (Array.isArray(v) ? v : []);
const str = (v) => (typeof v === "string" ? v : "");

/** The display name of a Gramps Person object: first names and surnames, or "". */
export function nameOfObj(obj) {
  const n = isObj(obj) && isObj(obj.primary_name) ? obj.primary_name : {};
  const surname = arr(n.surname_list).map((s) => (isObj(s) ? str(s.surname) : "")).filter(Boolean).join(" ");
  return [str(n.first_name), surname].filter(Boolean).join(" ");
}

/** The Idempotency-Key for one send: the same key for the same intent, so a retry after a dropped connection cannot send twice. */
export function newKey() {
  const c = globalThis.crypto;
  if (c && typeof c.randomUUID === "function") return c.randomUUID();
  const bytes = new Uint8Array(16);
  if (c && typeof c.getRandomValues === "function") c.getRandomValues(bytes);
  else for (let i = 0; i < bytes.length; i += 1) bytes[i] = Math.floor(Math.random() * 256);
  return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}

export function createWizardApi({ api = defaultApi } = {}) {
  const familyCache = new Map(); // own handle -> Promise

  async function preview(intent, confirm = []) {
    const body = { intent, ...(confirm.length ? { confirmDistinct: confirm } : {}) };
    try {
      const res = await api.post("/relationships/preview", body);
      return { view: previewView(res), error: null };
    } catch (e) {
      // The real gate answering for a partly confirmed list: read its candidates like a report.
      if (e && e.code === "unconfirmed_duplicate" && isObj(e.details) && Array.isArray(e.details.candidates)) {
        return { view: { ...previewView({}), duplicates: e.details.candidates }, error: null };
      }
      return { view: null, error: e };
    }
  }

  async function send(intent, confirm, key) {
    // route "review": the wizard always makes a proposal (the screen says an admin will check it), even for an admin session, whose default is "auto".
    return api.post("/relationships", { intent, confirmDistinct: confirm, route: "review" }, { headers: { "Idempotency-Key": key } });
  }

  async function resolvePerson(gid) {
    try {
      const r = await api.get(`/records/Person/by-id/${encodeURIComponent(gid)}`);
      return r && typeof r.handle === "string" ? { handle: r.handle, gid: str(r.gramps_id) || gid, name: nameOfObj(r.obj) } : null;
    } catch (e) {
      if (e && (e.status === 404 || e.status === 409)) return null;
      throw e;
    }
  }

  async function record(cls, handle) {
    try {
      const r = await api.get(`/records/${cls}/${encodeURIComponent(handle)}`);
      return isObj(r) && isObj(r.obj) ? { handle: str(r.handle) || handle, gid: str(r.gramps_id), obj: r.obj } : null;
    } catch (e) {
      if (e && e.status === 404) return null;
      throw e;
    }
  }

  /** A person on the site by handle: `{ handle, gid, name }`, or null when it is not there. For the person a member said "yes, that's them" about. */
  async function resolveHandle(handle) {
    const p = await record("Person", handle);
    return p ? { handle: p.handle, gid: p.gid || null, name: nameOfObj(p.obj) } : null;
  }

  /** The member's own families: `families: [{ handle, meAs: "child"|"partner", parents: [p], children: [p] }]`, p = `{ handle, gid, name }`. */
  function loadFamily(meHandle) {
    if (!familyCache.has(meHandle)) {
      const run = (async () => {
        const me = await record("Person", meHandle);
        if (!me) return { families: [], partners: [] };
        const asChild = arr(me.obj.parent_family_list).filter((h) => typeof h === "string").map((h) => [h, "child"]);
        const asPartner = arr(me.obj.family_list).filter((h) => typeof h === "string").map((h) => [h, "partner"]);
        const wanted = [...asChild, ...asPartner].slice(0, MAX_FAMILIES);
        const recs = await Promise.all(wanted.map(async ([h, meAs]) => ({ h, meAs, rec: await record("Family", h) })));
        const handles = new Set();
        for (const { rec } of recs) {
          if (!rec) continue;
          for (const k of [rec.obj.father_handle, rec.obj.mother_handle]) if (typeof k === "string" && k) handles.add(k);
          for (const c of arr(rec.obj.child_ref_list)) if (isObj(c) && typeof c.ref === "string") handles.add(c.ref);
        }
        handles.delete(meHandle);
        const people = new Map([[meHandle, { handle: meHandle, gid: me.gid, name: nameOfObj(me.obj) }]]);
        await Promise.all([...handles].slice(0, MAX_PEOPLE).map(async (h) => {
          const p = await record("Person", h);
          if (p) people.set(h, { handle: h, gid: p.gid, name: nameOfObj(p.obj) });
        }));
        const pick = (h) => people.get(h) || null;
        const families = [];
        for (const { h, meAs, rec } of recs) {
          if (!rec) continue;
          const parents = [rec.obj.father_handle, rec.obj.mother_handle].filter((k) => typeof k === "string" && k).map(pick).filter(Boolean);
          const children = arr(rec.obj.child_ref_list).map((c) => (isObj(c) ? pick(c.ref) : null)).filter((p) => p && p.handle !== meHandle);
          families.push({ handle: h, meAs, parents, children });
        }
        const partners = [];
        const seen = new Set();
        for (const f of families) {
          if (f.meAs !== "partner") continue;
          for (const p of f.parents) if (p.handle !== meHandle && !seen.has(p.handle)) { seen.add(p.handle); partners.push(p); }
        }
        return { families, partners };
      })();
      familyCache.set(meHandle, run);
      run.catch(() => familyCache.delete(meHandle)); // a failed load is tried again next time
    }
    return familyCache.get(meHandle);
  }

  /** The places the member's own page holds (the edit bundle's `related`), by name: what "where did you marry?" can offer. */
  async function loadPlaces(gid) {
    const bundle = await api.get(`/edit/Person/${encodeURIComponent(gid)}`);
    return makeLookups(bundle || {}).places.map((p) => ({ ref: `Place:${p.ref}`, name: p.name }));
  }

  return { preview, send, resolvePerson, resolveHandle, loadFamily, loadPlaces };
}
