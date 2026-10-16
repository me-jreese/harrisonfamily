// The MOD# overlay (D2-19, D2-34), pure and import-free: which note, MediaRef and Media items an open MOD# record hides, and a copy of an object
// without them. records/read.js (the records API, the edit bundle, MCP) and the hfy-graph-render Lambda (HFY-TSK-274) both use it.
const isObj = (v) => v !== null && typeof v === "object" && !Array.isArray(v);

/** The MOD# targets this object can reference: note:<h>, media:<h> and mediaref:<holder handle>:<media handle> (BRD2 section 4). */
export function collectModTargets(obj) {
  const out = new Set();
  const holder = isObj(obj) ? obj.handle : undefined;
  const walk = (v) => {
    if (Array.isArray(v)) { v.forEach(walk); return; }
    if (!isObj(v)) return;
    for (const [k, x] of Object.entries(v)) {
      if (k === "note_list" && Array.isArray(x)) {
        for (const h of x) if (typeof h === "string" && h) out.add(`note:${h}`);
      } else if (k === "media_list" && Array.isArray(x)) {
        for (const r of x) if (isObj(r) && typeof r.ref === "string" && r.ref) { out.add(`media:${r.ref}`); if (holder) out.add(`mediaref:${holder}:${r.ref}`); }
      }
      walk(x);
    }
  };
  walk(obj);
  return [...out];
}

/**
 * A hidden item is visible to admins and to its owner (BRD2 D2-19, R2-25: "the page owner when they are a member"). The owner is the member
 * whose own Person holds the item (viewer.ownTargets, filled by viewRecord), and also the member who raised the MOD# item (author_id).
 */
const mayView = (mod, viewer, target) =>
  viewer?.admin === true || (typeof viewer?.id === "string" && mod.author_id === viewer.id) || viewer?.ownTargets?.has(target) === true;
const hiddenFor = (mods, target, viewer) => { const m = mods.get(target); return m !== undefined && !mayView(m, viewer, target); };

/** True when the record itself (a Note or Media) is hidden from `viewer`: the route answers 404. */
export function recordHidden(cls, handle, viewer, mods) {
  if (cls === "Note") return hiddenFor(mods, `note:${handle}`, viewer);
  if (cls === "Media") return hiddenFor(mods, `media:${handle}`, viewer);
  return false;
}

/**
 * D2-19: `obj` without the notes, MediaRefs and Media that `mods` (loadMods) hides from `viewer`. Admins and the owner of a hidden item keep it.
 * The MediaRef target is `mediaref:<handle of the object holding the list>:<media handle>`. Returns a copy; the input is not mutated.
 */
export function applyModOverlay(obj, viewer, mods) {
  if (!isObj(obj) || !(mods instanceof Map) || mods.size === 0 || viewer?.admin === true) return obj;
  const holder = obj.handle;
  const walk = (v) => {
    if (Array.isArray(v)) return v.map(walk);
    if (!isObj(v)) return v;
    const out = {};
    for (const [k, x] of Object.entries(v)) {
      if (k === "note_list" && Array.isArray(x)) out[k] = x.filter((h) => !(typeof h === "string" && hiddenFor(mods, `note:${h}`, viewer)));
      else if (k === "media_list" && Array.isArray(x)) {
        out[k] = x.filter((r) => !(isObj(r) && typeof r.ref === "string" && (hiddenFor(mods, `media:${r.ref}`, viewer) || hiddenFor(mods, `mediaref:${holder}:${r.ref}`, viewer)))).map(walk);
      } else out[k] = walk(x);
    }
    return out;
  };
  return walk(obj);
}
