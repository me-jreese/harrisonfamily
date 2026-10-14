// Site photo tagging, the editor's UI half (HFY-TSK-260, tag-editor-ui, flag photoTagEdit; BRD2 R-31, D2-24, SI-22). It adds to the person page's
// lightbox, next to the photo tags island (lib/photo-tags-ui.js), and edits nothing of the page's own markup:
//   a "tag people" toggle in the lightbox header (for a signed-in member, when /api/me does not say editing is off);
//   with it on, an editing layer over the photo: the photo's tags as boxes to pick, a rectangle to draw on empty ground, four 44px corner
//   handles on the box being changed, and, under the caption, a panel with the person picker, a pair of nudge buttons for each edge and
//   one for the whole box (the keyboard and touch way to do everything the pointer does), and save / remove / cancel;
//   a save is a dry run of POST /api/changes, the confirmation sheet (the editor's own, with the split "saves now" and "sent for review"),
//   then the same request under an Idempotency-Key. The ops are built against the tagged person's own edit bundle (lib/photo-tag-edit.js),
//   so a tag on your own page saves now, on someone else's it is a suggestion, and an admin's saves now: the server's field policy decides.
// A tag that saved now is also put into the page's own copy of the photo's tags (media.tags) and announced with `hfy:tags-edited`, so the
// view layer shows it without a reload. Every name is a text node (member-editable text is never parsed as markup).
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { createRoot } from "react-dom/client";
import { api } from "./api.js";
import { getMe } from "./me.js";
import { PersonName } from "./person-name.jsx";
import { ConfirmSheet } from "./editor-save-ui.jsx";
import { baseVersionsFor, changesBody, newIdempotencyKey, planGroups, problemFor, savedToast } from "./editor-save.js";
import { containedRect, regionBox, tagView } from "./photo-tags.js";
import {
  BIG_STEP, CORNERS, DEFAULT_RECT, EDGES, STEP, TAG_COPY, applyToTags, buildTagOps, canRemoveTag, canUseTagEditor, dragCorner, expectedRoute, isDrawn,
  isTaggable, moveEdge, moveRect, nthOf, nudgeCorner, pointToPercent, rectBetween, sameRect, toGrampsRect
} from "./photo-tag-edit.js";

let serial = 0;
const nextId = (prefix) => `${prefix}-${(serial += 1)}`;
const text = (v) => (typeof v === "string" ? v : "");

/** `/auth/login?returnTo=<this page>`; a step-up asks for a fresh sign-in. */
const signInHref = (fresh = false) => `/auth/login?${fresh ? "prompt=login&" : ""}returnTo=${encodeURIComponent(`${location.pathname}${location.search}`)}`;

// ---------------------------------------------------------------------------------------------------------------- the photo's box
/** The image's box inside the lightbox wrapper, and the picture inside it ({ left, top, width, height, contained }); null until the image has a size. */
function useImageBox(img, host) {
  const [box, setBox] = useState(null);
  useLayoutEffect(() => {
    let dead = false;
    const run = () => {
      if (dead) return;
      const r = img.getBoundingClientRect();
      if (!img.complete || !img.naturalWidth || !r.width || !r.height) { setBox(null); return; }
      const cs = getComputedStyle(img);
      const bl = parseFloat(cs.borderLeftWidth) || 0;
      const bt = parseFloat(cs.borderTopWidth) || 0;
      const width = r.width - bl - (parseFloat(cs.borderRightWidth) || 0);
      const height = r.height - bt - (parseFloat(cs.borderBottomWidth) || 0);
      const hr = host.getBoundingClientRect();
      const next = { left: r.left + bl - (hr.left + host.clientLeft), top: r.top + bt - (hr.top + host.clientTop), width, height, contained: containedRect(width, height, img.naturalWidth, img.naturalHeight) };
      setBox((prev) => (prev && ["left", "top", "width", "height"].every((k) => Math.abs(prev[k] - next[k]) < 0.5) ? prev : next));
    };
    run();
    img.addEventListener("load", run);
    const ro = typeof ResizeObserver === "function" ? new ResizeObserver(run) : null;
    if (ro) { ro.observe(img); ro.observe(host); }
    window.addEventListener("resize", run);
    return () => { dead = true; img.removeEventListener("load", run); if (ro) ro.disconnect(); window.removeEventListener("resize", run); };
  }, [img, host]);
  return box;
}

// ---------------------------------------------------------------------------------------------------------------- the person picker
/**
 * A person from the family index. The box searches as you type; only a person picked from the list is a value, never the typed text.
 * A pick is `{ id, name }` (a Gramps person id and the name the index shows). The list is a listbox (arrow keys, Enter, Esc).
 */
function TagPicker({ onPick, inputRef }) {
  const id = useMemo(() => nextId("photo-tag-edit-pick"), []);
  const [query, setQuery] = useState("");
  const [results, setResults] = useState([]);
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(-1);
  const [status, setStatus] = useState("idle");
  const seq = useRef(0);
  const run = async (q) => {
    const n = (seq.current += 1);
    if (!q.trim()) { setResults([]); setActive(-1); setStatus("idle"); return; }
    setStatus("loading");
    try {
      const { suggestPeople } = await import("./people-corpus.js"); // the search engine loads when someone first types
      const found = (await suggestPeople(q)).filter((r) => isTaggable(r.id));
      if (n !== seq.current) return;
      setResults(found);
      setActive(found.length ? 0 : -1);
      setStatus(found.length ? "idle" : "none");
    } catch {
      if (n === seq.current) setStatus("none");
    }
  };
  const choose = (o) => { setOpen(false); setQuery(""); setResults([]); onPick({ id: o.id, name: o.title || o.id }); };
  const onKey = (e) => {
    if (e.key === "ArrowDown") { e.preventDefault(); e.stopPropagation(); setOpen(true); setActive((a) => Math.min(results.length - 1, a + 1)); }
    else if (e.key === "ArrowUp") { e.preventDefault(); e.stopPropagation(); setActive((a) => Math.max(0, a - 1)); }
    else if (e.key === "Escape" && open) { e.preventDefault(); e.stopPropagation(); setOpen(false); }
    else if (e.key === "Enter") { e.preventDefault(); e.stopPropagation(); if (open && results[active]) choose(results[active]); }
  };
  return (
    <div className="photo-tag-edit__pick">
      <label htmlFor={`${id}-input`}>{TAG_COPY.pick}</label>
      <input
        id={`${id}-input`} ref={inputRef} className="photo-tag-edit__input" type="text" role="combobox" autoComplete="off" aria-autocomplete="list"
        aria-expanded={open && results.length > 0} aria-controls={`${id}-list`} aria-describedby={`${id}-hint`}
        aria-activedescendant={open && active >= 0 ? `${id}-opt-${active}` : undefined} value={query}
        onChange={(e) => { setQuery(e.target.value); setOpen(true); run(e.target.value); }} onKeyDown={onKey}
      />
      <p className="photo-tag-edit__hint" id={`${id}-hint`}>{status === "loading" ? TAG_COPY.pickSearching : status === "none" ? TAG_COPY.pickNone : TAG_COPY.pickHint}</p>
      <ul id={`${id}-list`} role="listbox" aria-label={TAG_COPY.pick} className="photo-tag-edit__list" hidden={!(open && results.length > 0)}>
        {results.map((o, i) => (
          <li key={o.id} id={`${id}-opt-${i}`} role="option" aria-selected={i === active} className="photo-tag-edit__option" onMouseDown={(e) => { e.preventDefault(); choose(o); }}>
            {o.title}{o.subtitle ? ` (${o.subtitle})` : ""}
          </li>
        ))}
      </ul>
    </div>
  );
}

// ---------------------------------------------------------------------------------------------------------------- the save flow
const plainProblem = (text) => ({ text, fields: [], conflict: false, retryKey: false, signIn: false, stepUp: false, transient: false });

/**
 * Plan, confirm and save one change. `start(change)` reads the tagged person's edit bundle, builds the ops, and dry-runs them; the sheet shows
 * the plan's two groups; `save` posts them under an Idempotency-Key; a conflict reads the bundle again and plans once more, and a tag that is
 * no longer there ends in a plain note. The object it returns has the shape of the editor's save flow, so its ConfirmSheet can show it.
 */
function useTagFlow({ me, onDone }) {
  const [sheet, setSheet] = useState(null);
  const run = useRef(null); // { change, bundle, built }
  const keyRef = useRef({ sig: "", key: "" });
  const seq = useRef(0); // a plan that finishes after the sheet was closed (or after a newer plan began) is dropped
  const live = useRef(true);
  useEffect(() => { live.current = true; return () => { live.current = false; }; }, []);
  const put = useCallback((next) => { if (live.current) setSheet(next); }, []);

  const groups = (body, change) => {
    const g = planGroups(body);
    const sentence = (kind) => {
      const name = change.name || "someone";
      return kind === "add" ? <>tag <PersonName id={change.grampsId} name={name} /> in this photo</>
        : kind === "remove" ? <>remove <PersonName id={change.grampsId} name={name} />&rsquo;s tag from this photo</>
        : <>change where <PersonName id={change.grampsId} name={name} /> is tagged in this photo</>;
    };
    const lines = (items) => items.map(() => sentence(change.kind));
    return { direct: lines(g.direct), review: lines(g.review), warnings: g.warnings };
  };

  const fail = async (e, change, replayed) => {
    const c = run.current;
    const problem = problemFor(e, { labels: c ? c.built.labels : {}, ops: c ? c.built.ops : [] });
    if (problem.conflict && !replayed) return plan(change, { replayed: true, notice: TAG_COPY.tagsChanged });
    put({ phase: "error", notice: "", groups: null, problem, note: "" });
    return undefined;
  };

  const plan = async (change, { replayed = false, notice = "" } = {}) => {
    seq.current += 1;
    const ticket = seq.current;
    put({ phase: "planning", notice, groups: null, problem: null, note: "" });
    let bundle;
    try {
      bundle = await api.get(`/edit/Person/${encodeURIComponent(change.grampsId)}`);
      if (ticket !== seq.current) return;
    } catch (e) {
      if (ticket !== seq.current) return;
      const p = problemFor(e, {});
      put({ phase: "error", notice: "", groups: null, problem: p.signIn || p.transient ? p : plainProblem(TAG_COPY.loadFailed), note: "" });
      return;
    }
    const built = buildTagOps(bundle, change);
    if (!built.ok) {
      put({ phase: "error", notice: "", groups: null, problem: plainProblem(built.reason === "exists" ? TAG_COPY.exists : built.reason === "nochange" ? TAG_COPY.nochange : built.reason === "invalid" ? TAG_COPY.invalid : TAG_COPY.staleTag), note: "" });
      return;
    }
    run.current = { change, bundle, built };
    try {
      const body = await api.post("/changes", changesBody({ target: bundle.key, version: bundle.version, ops: built.ops, dryRun: true, baseVersions: baseVersionsFor(bundle, built.ops) }));
      if (ticket !== seq.current) return;
      put({ phase: "ready", notice, groups: groups(body, change), problem: null, note: "", replayed });
    } catch (e) {
      if (ticket !== seq.current) return;
      await fail(e, change, replayed);
    }
  };

  const keyFor = (c, note) => {
    const sig = JSON.stringify([c.bundle.key, c.bundle.version, c.built.ops, note]);
    if (keyRef.current.sig !== sig) keyRef.current = { sig, key: newIdempotencyKey() };
    return keyRef.current.key;
  };

  const save = async (retried = false) => {
    const c = run.current;
    const s = sheet;
    if (!c || !s || s.phase === "saving") return;
    put({ ...s, phase: "saving" });
    try {
      const note = s.groups && s.groups.review.length ? (s.note || "").trim() : "";
      const body = await api.post("/changes", changesBody({ target: c.bundle.key, version: c.bundle.version, ops: c.built.ops, note, baseVersions: baseVersionsFor(c.bundle, c.built.ops) }), { headers: { "Idempotency-Key": keyFor(c, note) } });
      const t = savedToast(body);
      put(null);
      if (live.current) onDone({ change: c.change, rect: c.built.rect, applied: t.saved, sent: t.sent });
    } catch (e) {
      const problem = problemFor(e, { labels: c.built.labels, ops: c.built.ops });
      if (problem.retryKey && !retried) { keyRef.current = { sig: "", key: "" }; await save(true); return; }
      await fail(e, c.change, s.replayed === true);
    }
  };

  const flow = {
    sheet, viewer: { admin: me.admin === true },
    closeSheet: () => { seq.current += 1; put(null); },
    setNote: (note) => setSheet((cur) => (cur ? { ...cur, note } : cur)),
    retry: () => { if (run.current) plan(run.current.change, { replayed: sheet ? sheet.replayed === true && !(sheet.problem && sheet.problem.conflict) : false }); },
    save: () => save(false)
  };
  return { flow, start: (change) => plan(change) };
}

// ---------------------------------------------------------------------------------------------------------------- the editor
const ARROWS = { ArrowLeft: [-1, 0], ArrowRight: [1, 0], ArrowUp: [0, -1], ArrowDown: [0, 1] };
const EDGE_GLYPH = { left: ["←", "→"], right: ["←", "→"], top: ["↑", "↓"], bottom: ["↑", "↓"] };
const DIR_WORD = { left: ["left", "right"], right: ["left", "right"], top: ["up", "down"], bottom: ["up", "down"] };

/** Keys that must not reach the lightbox: its arrows step to the next photo and Esc closes it. */
const guardKeys = (e, { esc = null } = {}) => {
  if (e.key === "ArrowLeft" || e.key === "ArrowRight") e.stopPropagation();
  if (e.key === "Escape" && esc && esc(e)) { e.preventDefault(); e.stopPropagation(); }
};

function TagEditor({ detail, me, person }) {
  const { media, img, box } = detail;
  const [rev, setRev] = useState(0);
  const [sel, setSel] = useState(null);
  const [status, setStatus] = useState("");
  const [toast, setToast] = useState("");
  const [settled, setSettled] = useState(0); // bumped when a drag ends, so the box's new place is announced
  const geometry = useImageBox(img, box);
  const layerRef = useRef(null);
  const drag = useRef(null);
  const pickerRef = useRef(null);
  const addRef = useRef(null);
  const headingId = useMemo(() => nextId("photo-tag-edit-h"), []);

  const rawTags = Array.isArray(media.tags) ? media.tags : [];
  const items = useMemo(() => rawTags.map((t, i) => ({ i, view: tagView(t, person), nth: nthOf(rawTags, i) })).filter((x) => x.view), [rev, media, person]);

  const done = useCallback(({ change, rect, applied, sent }) => {
    if (applied) {
      media.tags = applyToTags(media.tags, change, rect);
      document.dispatchEvent(new CustomEvent("hfy:tags-edited", { detail }));
      setRev((n) => n + 1);
      setToast(change.kind === "remove" ? TAG_COPY.removedDirect : TAG_COPY.savedDirect);
    } else {
      setToast(sent ? TAG_COPY.savedReview : TAG_COPY.nochange);
    }
    setSel(null);
    requestAnimationFrame(() => { if (addRef.current) addRef.current.focus(); });
  }, [media, detail]);
  const { flow, start } = useTagFlow({ me, onDone: done });

  // The box being changed: the new draft or the existing tag, with its working rect in percent of the photo (floats while dragging).
  const setRect = useCallback((rect) => setSel((s) => (s ? { ...s, rect, dirty: s.kind === "new" ? true : !sameRect(toGrampsRect(rect), toGrampsRect(s.from)) } : s)), []);
  const pick = (item) => {
    setToast("");
    const v = item.view;
    // A tag without a box starts as the default box and is dirty at once: saving it gives the tag its place.
    setSel({ kind: "existing", id: item.i, grampsId: v.grampsId, name: v.name, from: v.rect, nth: item.nth, rect: v.rect ? v.rect.slice() : [...DEFAULT_RECT], dirty: !v.rect });
  };
  const addNew = (person0 = null) => {
    setToast("");
    setSel({ kind: "new", rect: [...DEFAULT_RECT], person: person0, dirty: true });
  };

  // Announce where the box is after it moves (not on every pixel of a drag).
  useEffect(() => {
    if (!sel || drag.current) return undefined;
    const t = setTimeout(() => setStatus(TAG_COPY.statusArea(toGrampsRect(sel.rect))), 400);
    return () => clearTimeout(t);
  }, [sel && sel.rect, settled]);
  // A new draft with nobody picked yet goes straight to the picker.
  useEffect(() => { if (sel && sel.kind === "new" && !sel.person && !sel.drawing && pickerRef.current) pickerRef.current.focus(); }, [sel && sel.kind, sel && sel.person, sel && sel.drawing]);

  // ---- the pointer
  const pctAt = (e) => (layerRef.current && geometry ? pointToPercent(e.clientX, e.clientY, layerRef.current.getBoundingClientRect(), geometry.contained) : null);
  const begin = (e, mode, extra = {}) => {
    if (e.button !== undefined && e.button !== 0) return;
    const p = pctAt(e);
    if (!p) return;
    e.stopPropagation();
    if (layerRef.current && layerRef.current.setPointerCapture) { try { layerRef.current.setPointerCapture(e.pointerId); } catch { /* a synthetic pointer */ } }
    drag.current = { mode, start: p, orig: sel ? sel.rect : null, id: e.pointerId, prev: sel, ...extra };
  };
  const onLayerDown = (e) => {
    if (e.target !== e.currentTarget) return;
    // A real draw replaces the selection, so one with an unsaved change is not drawn over: finish or cancel it first.
    if (sel && sel.kind === "existing" && sel.dirty) { setToast(TAG_COPY.finishFirst); return; }
    begin(e, "draw");
  };
  const onMove = (e) => {
    const d = drag.current;
    if (!d || d.id !== e.pointerId) return;
    const p = pctAt(e);
    if (!p) return;
    if (d.mode === "draw") { if (isDrawn(d.start, p)) setSel({ kind: "new", rect: rectBetween(d.start, p), person: d.prev && d.prev.kind === "new" ? d.prev.person : null, dirty: true, drawing: true }); }
    else if (d.mode === "move") setRect(moveRect(d.orig, p.x - d.start.x, p.y - d.start.y));
    else if (d.mode === "corner") setRect(dragCorner(d.orig, d.corner, p));
  };
  const onUp = (e) => {
    const d = drag.current;
    if (!d || d.id !== e.pointerId) return;
    drag.current = null;
    if (layerRef.current && layerRef.current.releasePointerCapture) { try { layerRef.current.releasePointerCapture(e.pointerId); } catch { /* already released */ } }
    if (d.mode === "draw") {
      const p = pctAt(e);
      if (e.type === "pointercancel" || !p || !isDrawn(d.start, p)) { setSel(d.prev || null); return; } // a tap on empty ground: nothing was drawn
      setToast("");
      setSel((s) => (s && s.kind === "new" ? { ...s, drawing: false } : s));
    }
    setSettled((n) => n + 1); // lets the "where it is now" announcement run
  };

  // ---- the keys
  const nudgeBody = (e) => {
    const a = ARROWS[e.key];
    if (!a || !sel) return;
    e.preventDefault();
    e.stopPropagation();
    const k = e.shiftKey ? BIG_STEP : STEP;
    setRect(moveRect(sel.rect, a[0] * k, a[1] * k));
  };
  const nudgeHandle = (corner) => (e) => {
    const a = ARROWS[e.key];
    if (!a || !sel) return;
    e.preventDefault();
    e.stopPropagation();
    const k = e.shiftKey ? BIG_STEP : STEP;
    setRect(nudgeCorner(sel.rect, corner, a[0] * k, a[1] * k));
  };
  const escape = () => {
    if (sel) { setSel(null); setStatus(""); return true; }
    return false;
  };
  // With the sheet open, Esc is the sheet's: it must not reach the lightbox (Bootstrap closes on it), and it is not left to the browser's own
  // close handling, which skips a second Esc that has no user action before it. The sheet's cancel handler decides (it stays while saving).
  const guardSheet = (e) => {
    const open = e.key === "Escape" ? document.querySelector("dialog.hfy-sheet[open]") : null;
    if (open) { e.preventDefault(); e.stopPropagation(); open.dispatchEvent(new Event("cancel", { cancelable: true })); return; }
    guardKeys(e, { esc: escape });
  };

  // ---- the change
  const route = sel ? expectedRoute(me, sel.kind === "new" ? sel.person && sel.person.id : sel.grampsId) : null;
  const personId = sel ? (sel.kind === "new" ? sel.person && sel.person.id : sel.grampsId) : null;
  const canSave = Boolean(sel && sel.dirty && (sel.kind === "existing" || sel.person));
  const existingTag = sel && sel.kind === "existing" ? { grampsId: sel.grampsId } : null;
  const submit = (kind) => {
    if (!sel) return;
    const base = { mediaHandle: media.handle };
    if (sel.kind === "new") { if (sel.person) start({ kind: "add", ...base, grampsId: sel.person.id, name: sel.person.name, rect: sel.rect }); return; }
    start(kind === "remove"
      ? { kind: "remove", ...base, grampsId: sel.grampsId, name: sel.name, from: sel.from, nth: sel.nth }
      : { kind: "move", ...base, grampsId: sel.grampsId, name: sel.name, from: sel.from, nth: sel.nth, rect: sel.rect });
  };

  // ---- the layer
  const place = (rect) => (geometry ? regionBox(rect, geometry.contained) : { left: 0, top: 0, width: 0, height: 0 });
  const styleOf = (rect) => { const b = place(rect); return { left: `${b.left}px`, top: `${b.top}px`, width: `${b.width}px`, height: `${b.height}px` }; };
  const corner = (rect, c) => {
    const b = place(rect);
    return { left: `${c === "nw" || c === "sw" ? b.left : b.left + b.width}px`, top: `${c === "nw" || c === "ne" ? b.top : b.top + b.height}px` };
  };
  const editable = (item) => Boolean(item.view.rect) && isTaggable(item.view.grampsId);
  const arealess = items.filter((item) => !item.view.rect && isTaggable(item.view.grampsId));
  const chosen = (item) => Boolean(sel && sel.kind === "existing" && sel.id === item.i);
  const handles = sel && geometry ? CORNERS.map((c) => (
    <button
      key={c} type="button" className="photo-tag-edit__handle" data-corner={c} aria-label={TAG_COPY.handleLabel[c]} style={corner(sel.rect, c)}
      onPointerDown={(e) => begin(e, "corner", { corner: c })} onKeyDown={nudgeHandle(c)}
    />
  )) : null;
  const layer = (
    <div
      ref={layerRef} className="photo-tag-edit__layer" role="group" aria-label={TAG_COPY.heading} hidden={!geometry}
      style={geometry ? { left: `${geometry.left}px`, top: `${geometry.top}px`, width: `${geometry.width}px`, height: `${geometry.height}px` } : undefined}
      onPointerDown={onLayerDown} onPointerMove={onMove} onPointerUp={onUp} onPointerCancel={onUp}
      onTouchStart={(e) => e.stopPropagation()} onTouchEnd={(e) => e.stopPropagation()} onKeyDown={guardSheet} data-hfy-tag-layer
    >
      {geometry && items.filter((item) => editable(item) || (chosen(item) && isTaggable(item.view.grampsId))).map((item) => {
        const here = sel && sel.kind === "existing" && sel.id === item.i;
        return (
          <button
            key={item.i} type="button" className="photo-tag-edit__region" aria-pressed={here ? "true" : "false"} aria-label={TAG_COPY.regionLabel(item.view.name)}
            style={styleOf(here ? sel.rect : item.view.rect)} data-tag={item.i}
            onClick={() => { if (!here) pick(item); }} onPointerDown={here ? (e) => begin(e, "move") : undefined} onKeyDown={here ? nudgeBody : undefined}
          >
            <span className="photo-tag-edit__label">{item.view.name}</span>
          </button>
        );
      })}
      {geometry && sel && sel.kind === "new" && <div className="photo-tag-edit__draft" aria-hidden="true" style={styleOf(sel.rect)} onPointerDown={(e) => begin(e, "move")} />}
      {!(sel && sel.drawing) && handles}
    </div>
  );

  // ---- the panel
  const panel = (
    <div className="photo-tag-edit" onKeyDown={guardSheet}>
      <section className="photo-tag-edit__panel" aria-labelledby={headingId} data-hfy-tag-panel>
        <h3 className="photo-tag-edit__h" id={headingId}>{TAG_COPY.heading}</h3>
        {toast && <p className="photo-tag-edit__toast" role="status" data-hfy-tag-toast>{toast}</p>}
        <p className="photo-tag-edit__sr" role="status" aria-live="polite">{status}</p>
        {!sel && (
          <>
            <p className="photo-tag-edit__hint">{TAG_COPY.intro}</p>
            {arealess.length > 0 && (
              <div className="photo-tag-edit__noarea" data-hfy-tag-noarea>
                <h4 className="photo-tag-edit__h">{TAG_COPY.noAreaHeading}</h4>
                <p className="photo-tag-edit__hint">{TAG_COPY.noAreaHint}</p>
                <ul className="photo-tag-edit__noarea-list">
                  {arealess.map((item) => (
                    <li key={item.i}>
                      <button type="button" className="photo-tag-edit__btn" onClick={() => pick(item)} data-hfy-tag-noarea-pick={item.i}>{TAG_COPY.noAreaGive(item.view.name)}</button>
                    </li>
                  ))}
                </ul>
              </div>
            )}
            <div className="photo-tag-edit__row">
              <button type="button" className="photo-tag-edit__btn photo-tag-edit__btn--primary" ref={addRef} onClick={() => addNew(null)} data-hfy-tag-add>{TAG_COPY.addTag}</button>
              {isTaggable(me.id) && <button type="button" className="photo-tag-edit__btn" onClick={() => addNew({ id: me.id, name: text(me.label) || me.id })} data-hfy-tag-me>{TAG_COPY.tagMyself}</button>}
            </div>
          </>
        )}
        {sel && (
          <>
            {sel.kind === "new" && !sel.person && <TagPicker onPick={(p) => setSel((s) => (s ? { ...s, person: p } : s))} inputRef={pickerRef} />}
            {sel.kind === "new" && sel.person && (
              <p className="photo-tag-edit__who" data-hfy-tag-who>
                {TAG_COPY.pickPicked} <PersonName id={sel.person.id} name={sel.person.name} />{" "}
                <button type="button" className="photo-tag-edit__btn" onClick={() => setSel((s) => (s ? { ...s, person: null } : s))}>{TAG_COPY.pickAnother}</button>
              </p>
            )}
            {sel.kind === "existing" && <p className="photo-tag-edit__who" data-hfy-tag-who>{TAG_COPY.existing} <PersonName id={sel.grampsId} name={sel.name} /></p>}
            {personId && <p className="photo-tag-edit__route" data-hfy-tag-route={route}>{route === "direct" ? TAG_COPY.routeDirect : TAG_COPY.routeReview}</p>}
            {sel.kind === "new" && !sel.person && <p className="photo-tag-edit__hint">{TAG_COPY.pickFirst}</p>}
            <fieldset className="photo-tag-edit__nudge" data-hfy-tag-nudge>
              <legend>{TAG_COPY.boxHeading}</legend>
              <p className="photo-tag-edit__hint">{TAG_COPY.drag}</p>
              <div className="photo-tag-edit__edges">
                {EDGES.map((edge) => (
                  <div key={edge} className="photo-tag-edit__pair" role="group" aria-label={TAG_COPY.edge[edge]}>
                    <span className="photo-tag-edit__pair-name">{TAG_COPY.edge[edge]}</span>
                    {[-1, 1].map((dir, k) => (
                      <button
                        key={dir} type="button" className="photo-tag-edit__btn" aria-label={TAG_COPY.nudgeLabel(TAG_COPY.edge[edge], DIR_WORD[edge][k])}
                        onClick={() => setRect(moveEdge(sel.rect, edge, dir * STEP))} data-edge={edge} data-dir={dir}
                      >{EDGE_GLYPH[edge][k]}</button>
                    ))}
                  </div>
                ))}
              </div>
              <div className="photo-tag-edit__row" role="group" aria-label={TAG_COPY.moveBox}>
                <span className="photo-tag-edit__pair-name">{TAG_COPY.moveBox}</span>
                {[["left", -1, 0, "←"], ["up", 0, -1, "↑"], ["down", 0, 1, "↓"], ["right", 1, 0, "→"]].map(([word, dx, dy, glyph]) => (
                  <button key={word} type="button" className="photo-tag-edit__btn" aria-label={TAG_COPY.moveLabel(word)} onClick={() => setRect(moveRect(sel.rect, dx * STEP, dy * STEP))} data-move={word}>{glyph}</button>
                ))}
              </div>
            </fieldset>
            <div className="photo-tag-edit__row">
              <button type="button" className="photo-tag-edit__btn photo-tag-edit__btn--primary" disabled={!canSave} onClick={() => submit("save")} data-hfy-tag-save>{TAG_COPY.save}</button>
              {existingTag && canRemoveTag(me, existingTag) && <button type="button" className="photo-tag-edit__btn" onClick={() => submit("remove")} data-hfy-tag-remove>{TAG_COPY.remove}</button>}
              <button type="button" className="photo-tag-edit__btn" onClick={() => { setSel(null); setStatus(""); }} data-hfy-tag-cancel>{TAG_COPY.cancel}</button>
            </div>
          </>
        )}
      </section>
      <ConfirmSheet flow={flow} signInHref={signInHref} />
    </div>
  );
  return (
    <>
      {createPortal(layer, box)}
      {panel}
    </>
  );
}

// ---------------------------------------------------------------------------------------------------------------- the lightbox
let current = null; // { detail, person, me, modal } for the photo now shown
let toggle = null;
let panelHost = null;
let root = null;
let editing = false;
let watching = false;
let token = 0;

function unmountEditor() {
  if (root) { try { root.unmount(); } catch { /* already gone */ } root = null; }
  if (panelHost) { panelHost.remove(); panelHost = null; }
}

function setEditing(on, modal) {
  editing = on;
  if (toggle) {
    toggle.setAttribute("aria-pressed", on ? "true" : "false");
  }
  if (modal) modal.classList.toggle("photo-tag-edit-on", on);
}

function mountEditor() {
  unmountEditor();
  if (!editing || !current) return;
  const { detail, person, me } = current;
  const { media, box } = detail;
  const caption = document.getElementById("mediaLightboxCaption");
  const anchor = caption && caption.parentElement ? caption.parentElement : box;
  panelHost = document.createElement("div");
  panelHost.className = "photo-tag-edit-host";
  anchor.after(panelHost);
  root = createRoot(panelHost);
  root.render(<TagEditor key={`${media.handle}:${detail.index}`} detail={detail} me={me} person={person} />);
}

function ensureToggle(modal) {
  if (toggle && toggle.isConnected) return toggle;
  toggle = document.createElement("button");
  toggle.type = "button";
  toggle.className = "photo-tag-edit__toggle";
  toggle.textContent = TAG_COPY.toggle;
  toggle.setAttribute("aria-pressed", "false");
  toggle.hidden = true;
  toggle.addEventListener("click", () => {
    setEditing(!editing, current && current.modal);
    if (editing) mountEditor(); else unmountEditor();
  });
  const host = modal.querySelector(".lightbox-actions") || modal.querySelector(".modal-header");
  if (host) host.insertBefore(toggle, host.firstChild);
  return toggle;
}

/**
 * Called for every `hfy:lightbox-media` (detail: { index, media, img, box }) with the page's person (or null). Shows the toggle when the viewer
 * may tag, and, when tagging is on, the editor for the photo now shown. A photo without a Media handle (a missing file) is not taggable.
 */
export async function showTagEditor(detail, person) {
  const mine = (token += 1);
  unmountEditor();
  const { media, img, box } = detail || {};
  const modal = (img && img.closest(".modal")) || document.getElementById("mediaLightbox");
  const me = await getMe();
  if (mine !== token) return;
  const ok = Boolean(modal && media && typeof media.handle === "string" && media.handle && img && box) && canUseTagEditor(me);
  if (!ok) {
    current = null;
    if (toggle) toggle.hidden = true;
    if (modal) modal.classList.remove("photo-tag-edit-available");
    return;
  }
  current = { detail, person: person || null, me, modal };
  ensureToggle(modal).hidden = false;
  modal.classList.add("photo-tag-edit-available");
  setEditing(editing, modal);
  if (!watching) {
    watching = true;
    modal.addEventListener("hidden.bs.modal", () => { token += 1; unmountEditor(); setEditing(false, modal); if (toggle) toggle.hidden = true; modal.classList.remove("photo-tag-edit-available"); current = null; });
    // The page hides the image (d-none) while the next photo loads: the layer must not float over the spinner.
    new MutationObserver(() => { if (current && current.detail.img.classList.contains("d-none")) { token += 1; unmountEditor(); } }).observe(img, { attributes: true, attributeFilter: ["class"] });
  }
  if (editing) mountEditor();
}

/** The photo's tags changed (an edit saved now): nothing to do here; the view layer redraws on `hfy:tags-edited`. Kept for tests. */
export const editorState = () => ({ editing, mounted: Boolean(root) });
