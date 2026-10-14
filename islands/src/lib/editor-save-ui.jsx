// The editor's save flow, UI half (HFY-TSK-213, editor-save-flow; editing.md section 9.1 "Submitting", BRD2 R-06, R-08, R-09).
//   sticky bar   "3 changes — 2 save now, 1 goes to review" and a review button, above the shell's bottom bar
//   review       POST /api/changes with dry_run: the confirmation sheet lists the plan's sentences grouped "saves now" and "sent for review",
//                and says who looks at the second group
//   save         POST /api/changes under an Idempotency-Key: a toast "saved." with an undo (10 minutes) and "1 suggestion sent"
//   undo         POST /api/changes with the inverse ops the 201 returned, against the versions it returned
//   409          version_conflict: refetch the bundle, replay the member's edits over it, and say "this page just changed — please check your
//                edits." (once; a second conflict is shown as an error)
// The sheet is a native modal <dialog>: the browser traps focus, makes the page inert behind it and closes it on Escape. The pure rules
// (ops, counts, bodies, words) are in editor-save.js.
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { api } from "./api.js";
import {
  NOTE_MAX, SAVE_COPY, barText, changesBody, confirmLabel, countOps, newIdempotencyKey, noteCountText, opsFromDrafts, planGroups, problemFor, reviewerLine, savedToast, undoBody, undoLeftMs
} from "./editor-save.js";

export const REVIEW_HREF = "/me/review/?tab=mine";

/** The sections with a form, the only ones that produce ops. */
export const formSections = (sections) => sections.filter((s) => s.form);

/**
 * The save flow's state and actions. `getBundle()` is the bundle the forms were made from, `getDrafts()` the form values now, `refetch()` fetches
 * the bundle again, and `adopt(bundle, keepDrafts, settled)` makes it the page's bundle (remounting the forms; when `keepDrafts`, with the member's
 * edits laid over it, minus the ops in `settled`, an op id -> value map of what a save just stored).
 */
export function useSaveFlow({ sections, viewer, getBundle, getDrafts, refetch, adopt }) {
  const [sheet, setSheet] = useState(null);
  const [toast, setToast] = useState(null);
  // Bumped when the page has taken the new record after a save or an undo: the review button is gone by then, so focus goes to the toast.
  const [focusTick, setFocusTick] = useState(0);
  const keyRef = useRef({ sig: "", key: "" });
  const live = useRef(true);
  useEffect(() => { live.current = true; return () => { live.current = false; }; }, []);
  const set = useCallback((next) => { if (live.current) setSheet(next); }, []);

  const build = (bundle) => opsFromDrafts({ key: bundle.key, sections: formSections(sections), obj: bundle.obj, drafts: getDrafts() });
  const keyFor = (bundle, ops, note) => {
    const sig = JSON.stringify([bundle.key, bundle.version, ops, note]);
    if (keyRef.current.sig !== sig) keyRef.current = { sig, key: newIdempotencyKey() };
    return keyRef.current.key;
  };

  // The page takes the bundle fetched after a save or an undo. The forms stay editable meanwhile, so the member may already be typing the next
  // edit: whatever they typed that the server has not just taken (`settledOps`) is laid over the fresh record instead of being reset away.
  const refreshSeq = useRef(0);
  const adoptFresh = (fresh, settledOps = []) => {
    const bundle = getBundle();
    const settled = Object.fromEntries(settledOps.map((o) => [o.id, o.value]));
    const pending = bundle ? build(bundle).ops.filter((o) => !(Object.hasOwn(settled, o.id) && settled[o.id] === o.value)) : [];
    adopt(fresh, pending.length > 0, settled);
  };

  // Fetch the bundle after a save or an undo and adopt it, unless a later save or undo has started its own fetch meanwhile (its answer is newer).
  const refresh = async (settledOps = []) => {
    refreshSeq.current += 1;
    const ticket = refreshSeq.current;
    const fresh = await refetch();
    if (ticket === refreshSeq.current) adoptFresh(fresh, settledOps);
  };

  // A conflict: refetch the bundle and replay the member's edits over it (the forms remount holding the member's values, so the ops are
  // rebuilt against what the page is now). Once per attempt; the caller shows the notice.
  const replay = async () => {
    const fresh = await refetch();
    adopt(fresh, true);
    return fresh;
  };

  const plan = async (bundle, { notice = "", replayed = false, note = "" } = {}) => {
    const { ops, labels } = build(bundle);
    if (!ops.length) {
      set(null);
      if (notice) setToast({ text: SAVE_COPY.noMoreChanges, saved: false, sent: 0, undo: null, undoUntil: 0, id: Date.now() });
      return;
    }
    set({ phase: "planning", notice, ops, labels, bundle, replayed, groups: null, problem: null, note });
    try {
      const body = await api.post("/changes", changesBody({ target: bundle.key, version: bundle.version, ops, dryRun: true }));
      // The dry run went through, so a conflict on the save that follows is a new one and gets its own replay.
      set({ phase: "ready", notice, ops, labels, bundle, replayed: false, groups: planGroups(body), problem: null, note });
    } catch (e) {
      await fail(e, { ops, labels, bundle, replayed, notice, groups: null });
    }
  };

  const fail = async (e, ctx) => {
    const problem = problemFor(e, { labels: ctx.labels, ops: ctx.ops });
    if (problem.conflict && !ctx.replayed) {
      try {
        const fresh = await replay();
        return plan(fresh, { notice: SAVE_COPY.conflict, replayed: true, note: ctx.note || "" });
      } catch (again) {
        set({ ...ctx, phase: "error", problem: problemFor(again, {}) });
        return undefined;
      }
    }
    set({ ...ctx, phase: "error", problem });
    return undefined;
  };

  const review = () => {
    const bundle = getBundle();
    if (bundle) plan(bundle);
  };

  const save = async (retried = false) => {
    const s = sheet;
    if (!s || !s.ops || s.phase === "saving") return;
    set({ ...s, phase: "saving" });
    try {
      const note = s.groups && s.groups.review.length ? (s.note || "").trim() : "";
      const body = await api.post("/changes", changesBody({ target: s.bundle.key, version: s.bundle.version, ops: s.ops, note }), { headers: { "Idempotency-Key": keyFor(s.bundle, s.ops, note) } });
      const t = savedToast(body);
      set(null);
      setToast({ ...t, id: Date.now() });
      try { await refresh(s.ops); } catch { setToast({ ...t, text: `${t.text} reload the page to see it.`, id: Date.now() }); }
      setFocusTick((n) => n + 1);
    } catch (e) {
      const problem = problemFor(e, { labels: s.labels, ops: s.ops });
      if (problem.retryKey && !retried) {
        keyRef.current = { sig: "", key: "" };
        return save(true);
      }
      await fail(e, { ...s, notice: s.notice });
    }
    return undefined;
  };

  const undo = async () => {
    const t = toast;
    const bundle = getBundle();
    if (!t || !t.undo || t.working || !bundle || undoLeftMs(t) === 0) return;
    // One key per undo, kept across a retry: if the first answer was lost the server replays it instead of applying the inverse twice.
    const undoKey = t.undoKey || newIdempotencyKey();
    setToast({ ...t, working: true, undoKey });
    try {
      await api.post("/changes", undoBody({ target: bundle.key, undo: t.undo }), { headers: { "Idempotency-Key": undoKey } });
      setToast({ text: SAVE_COPY.undone, saved: false, sent: 0, undo: null, undoUntil: 0, id: Date.now() });
      try { await refresh(); } catch { /* the next save replays over whatever changed */ }
      setFocusTick((n) => n + 1);
    } catch (e) {
      const p = problemFor(e, {});
      // A hiccup (no answer, a busy site) leaves the undo on offer for the rest of its window, with the reason beside it; a conflict or a
      // refusal ends it.
      if (p.transient) { const baseText = t.baseText || t.text; setToast({ ...t, baseText, text: `${baseText} ${p.text}`, working: false, undoKey }); return; }
      const text = p.conflict ? SAVE_COPY.undoConflict : e && (e.status === 400 || e.status === 403 || e.status === 422) ? SAVE_COPY.undoFailed : p.text;
      setToast({ text, saved: false, sent: 0, undo: null, undoUntil: 0, id: Date.now() });
      if (p.conflict) { try { await refresh(); } catch { /* shown on the next save */ } }
    }
  };

  // The undo goes away when its 10 minutes are over.
  useEffect(() => {
    if (!toast || !toast.undo) return undefined;
    const left = undoLeftMs(toast);
    const timer = setTimeout(() => setToast((cur) => (cur && cur.id === toast.id ? { ...cur, undo: null } : cur)), left);
    return () => clearTimeout(timer);
  }, [toast]);

  return {
    sheet, toast, viewer, focusTick,
    review, save: () => save(false), undo,
    closeSheet: () => set(null),
    setNote: (note) => setSheet((cur) => (cur ? { ...cur, note } : cur)),
    retry: () => { const b = getBundle(); if (b) plan(b, { notice: sheet ? sheet.notice : "", replayed: sheet && !(sheet.problem && sheet.problem.conflict) ? sheet.replayed : false, note: sheet ? sheet.note || "" : "" }); },
    dismissToast: () => setToast(null)
  };
}

/** The sticky dock: the toast after a save, and the bar with the count and the review button while there are changes. */
export function SaveDock({ flow, counts }) {
  const { toast } = flow;
  const toastRef = useRef(null);
  const { focusTick } = flow;
  // The review button leaves with the last change, so focus would fall to the page: say what happened instead.
  useEffect(() => {
    if (!focusTick) return undefined;
    const frame = requestAnimationFrame(() => { if (toastRef.current) toastRef.current.focus(); });
    return () => cancelAnimationFrame(frame);
  }, [focusTick]);
  const left = undoLeftMs(toast);
  const text = barText(counts);
  if (!toast && !text) return null;
  return (
    <div className="hfy-editor__dock" data-hfy-dock>
      {toast && (
        <div className="hfy-editor__toast" role="status" tabIndex={-1} ref={toastRef} data-hfy-toast>
          <p className="hfy-editor__toast-text" data-hfy-toast-text>{toast.text}</p>
          <div className="hfy-editor__toast-actions">
            {toast.sent > 0 && <a href={REVIEW_HREF}>{SAVE_COPY.seeSuggestions}</a>}
            {left > 0 && <button type="button" onClick={flow.undo} disabled={toast.working === true} data-hfy-undo>{SAVE_COPY.undo}</button>}
            <button type="button" onClick={flow.dismissToast} aria-label={SAVE_COPY.close}>{SAVE_COPY.close}</button>
          </div>
        </div>
      )}
      {text && (
        <div className="hfy-editor__bar" role="group" aria-label="your changes" data-hfy-bar>
          <p className="hfy-editor__bar-text" data-hfy-bar-text>{text}</p>
          <button type="button" className="hfy-editor__primary" onClick={flow.review} data-hfy-review>{SAVE_COPY.review}</button>
        </div>
      )}
    </div>
  );
}

function Group({ id, title, note, items }) {
  if (!items.length) return null;
  return (
    <section className="hfy-sheet__group" aria-labelledby={id} data-hfy-group={id}>
      <h3 className="hfy-sheet__group-h" id={id}>{title}</h3>
      {note && <p className="hfy-sheet__who" data-hfy-who>{note}</p>}
      <ul className="hfy-sheet__list">{items.map((t, i) => <li key={`${i}:${t}`}>{t}</li>)}</ul>
    </section>
  );
}

/** The confirmation sheet: a native modal dialog, a bottom sheet under 43rem. */
export function ConfirmSheet({ flow, signInHref }) {
  const { sheet } = flow;
  const ref = useRef(null);
  useEffect(() => {
    const d = ref.current;
    if (!d || typeof d.showModal !== "function") return;
    if (sheet && !d.open) d.showModal();
    else if (!sheet && d.open) d.close();
  }, [sheet]);
  const busy = sheet && (sheet.phase === "planning" || sheet.phase === "saving");
  const groups = sheet && sheet.groups;
  const none = groups && !groups.direct.length && !groups.review.length;
  return (
    <dialog
      ref={ref}
      className="hfy-sheet"
      aria-labelledby="hfy-sheet-h"
      onCancel={(e) => { e.preventDefault(); if (!busy || (sheet && sheet.phase === "planning")) flow.closeSheet(); }}
      onClose={() => { if (sheet) flow.closeSheet(); }}
      data-hfy-sheet={sheet ? sheet.phase : "closed"}
    >
      {sheet && (
        <div className="hfy-sheet__panel" aria-busy={busy ? "true" : "false"}>
          <h2 className="hfy-sheet__h" id="hfy-sheet-h">{SAVE_COPY.sheetTitle}</h2>
          {sheet.notice && <p className="hfy-sheet__notice" role="status" data-hfy-notice>{sheet.notice}</p>}
          {sheet.phase === "planning" && <p className="hfy-sheet__note" role="status">{SAVE_COPY.planning}</p>}
          {sheet.phase === "error" && sheet.problem && (
            <div className="hfy-sheet__problem" role="alert" data-hfy-problem>
              <p>{sheet.problem.text}</p>
              {sheet.problem.fields.length > 0 && <p>{SAVE_COPY.checkFields} {sheet.problem.fields.join(", ")}</p>}
              {sheet.problem.signIn && <a className="hfy-sheet__signin" href={signInHref(sheet.problem.stepUp)}>sign in</a>}
            </div>
          )}
          {groups && (
            <>
              <Group id="hfy-sheet-direct" title={SAVE_COPY.groupDirect} items={groups.direct} />
              <Group id="hfy-sheet-review" title={SAVE_COPY.groupReview} note={reviewerLine(flow.viewer)} items={groups.review} />
              {none && <p className="hfy-sheet__note">{SAVE_COPY.nothingToSave}</p>}
              {groups.review.length > 0 && (
                <div className="hfy-sheet__field">
                  <label htmlFor="hfy-sheet-note">{SAVE_COPY.noteLabel}</label>
                  <textarea id="hfy-sheet-note" rows={3} maxLength={NOTE_MAX} value={sheet.note || ""} onChange={(e) => flow.setNote(e.target.value)} disabled={sheet.phase === "saving"} aria-describedby="hfy-sheet-note-count" data-hfy-note />
                  <p className="hfy-sheet__note" id="hfy-sheet-note-count" data-hfy-note-count>{noteCountText((sheet.note || "").length)}</p>
                </div>
              )}
              {groups.warnings.length > 0 && (
                <section className="hfy-sheet__group" aria-labelledby="hfy-sheet-warn">
                  <h3 className="hfy-sheet__group-h" id="hfy-sheet-warn">{SAVE_COPY.warnings}</h3>
                  <ul className="hfy-sheet__list">{groups.warnings.map((w, i) => <li key={`${i}:${w}`}>{w}</li>)}</ul>
                </section>
              )}
            </>
          )}
          <div className="hfy-sheet__actions">
            <button type="button" className="hfy-sheet__secondary" onClick={flow.closeSheet} disabled={sheet.phase === "saving"} data-hfy-back>{SAVE_COPY.back}</button>
            {sheet.phase === "error" && !sheet.problem?.signIn && <button type="button" className="hfy-editor__primary" onClick={flow.retry} data-hfy-retry>{sheet.problem?.conflict ? SAVE_COPY.reviewAgain : "try again"}</button>}
            {(sheet.phase === "ready" || sheet.phase === "saving") && !none && (
              <button type="button" className="hfy-editor__primary" onClick={flow.save} disabled={sheet.phase === "saving"} data-hfy-save>
                {sheet.phase === "saving" ? SAVE_COPY.saving : confirmLabel(groups)}
              </button>
            )}
          </div>
        </div>
      )}
    </dialog>
  );
}

/** Bar counts for the ops now (the bundle's policy table, a hint; the dry run decides). */
export function useCounts({ bundle, sections, drafts, resolver, cls, viewer }) {
  return useMemo(() => {
    if (!bundle || !viewer) return { total: 0, direct: 0, review: 0 };
    const { ops } = opsFromDrafts({ key: bundle.key, sections: formSections(sections), obj: bundle.obj, drafts });
    return countOps(ops, resolver, cls, viewer);
  }, [bundle, sections, drafts, resolver, cls, viewer]);
}
