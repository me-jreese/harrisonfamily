// HFY-TSK-410: the desktop never blanks the website's own Media path.
//
// A Media created on the website carries a non-empty `path` (its uploaded file). The desktop keeps `Media.path` local (a path is a file on
// the desktop's disk; the add-on's projection sends it blank, rule media.path.local_only), so a desktop bug, or an add-on older than the
// fix, would send `path: ""` in an update of such a Media, and nothing else on the server refuses it: the schema accepts an empty path.
// applyBatch therefore PRESERVES the stored path for a desktop update that blanks it. It does not refuse: the rest of the op is the
// desktop's edit and is stored; only the blank is replaced by the value the head already holds. A path the op names (non-empty) is the
// caller's, and a Media whose stored path is empty (a desktop-created one) is stored as sent.
import { objectJson } from "./store.js";

const isObj = (v) => v !== null && typeof v === "object" && !Array.isArray(v);

/**
 * `ops` with every desktop Media update that sends `path: ""` over a stored non-empty path rewritten to keep the stored one (obj and
 * objJson both). Returns `ops` itself when nothing changes. Pure: `heads` is the Map applyBatch read (`Class#handle` -> head item).
 */
export function keepWebsiteMediaPath(ops, heads, origin) {
  if (origin !== "desktop") return ops;
  let changed = false;
  const out = ops.map((op) => {
    if (op.op !== "update" || op.class !== "Media" || !isObj(op.obj) || op.obj.path !== "") return op;
    const prev = heads.get(`${op.class}#${op.handle}`);
    if (!prev || prev.deleted === true || typeof prev.obj_json !== "string") return op;
    let stored;
    try {
      stored = JSON.parse(prev.obj_json);
    } catch {
      return op;
    }
    if (!isObj(stored) || typeof stored.path !== "string" || stored.path === "") return op;
    changed = true;
    const obj = { ...op.obj, path: stored.path };
    return { ...op, obj: JSON.parse(objectJson(obj)), objJson: objectJson(obj) };
  });
  return changed ? out : ops;
}
