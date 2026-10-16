// Admin web deletes and the possible-duplicate queue: the UI half (HFY-TSK-295, edit-admin-delete; Q2-15). The words and rules are in admin-delete.js.
//   DeletePanel     a card at the foot of the editor, for an admin with `adminDelete`: "delete this page…" opens a sheet that shows the dry run (what goes,
//                   which pages lose a link, which ids are retired, the day's budget) and deletes under an Idempotency-Key. Nothing is sent until the
//                   admin confirms; a stale sign-in sends them to sign in again (step-up).
//   DuplicatesTab   the review page's "possible duplicates" tab: pairs to merge in Gramps on the desktop. It only reads.
import "./admin-delete.css";
import { useCallback, useEffect, useRef, useState } from "react";
import { api } from "./api.js";
import { COPY, deleteBody, newIdempotencyKey, pairRow, planView, problemFor } from "./admin-delete.js";

function List({ title, note, items, id }) {
  if (!items.length) return null;
  return (
    <section className="hfy-sheet__group" aria-labelledby={id} data-hfy-group={id}>
      <h3 className="hfy-sheet__group-h" id={id}>{title}</h3>
      {note && <p className="hfy-sheet__who">{note}</p>}
      <ul className="hfy-sheet__list">{items.map((t, i) => <li key={`${i}:${t.key}`}>{t.text}</li>)}</ul>
    </section>
  );
}

/** The delete sheet's state machine: planning -> ready -> deleting -> done, or error from any of them (a retryable error goes back to deleting under the same key). */
function useDelete({ cls, bundle, refetch }) {
  const [sheet, setSheet] = useState(null);
  const keyRef = useRef(null);
  const baseRef = useRef(null); // the key and version the dry run was made on: the delete sends the same pair
  const live = useRef(true);
  useEffect(() => { live.current = true; return () => { live.current = false; }; }, []);
  const set = useCallback((next) => { if (live.current) setSheet(next); }, []);
  const open = async () => {
    keyRef.current = newIdempotencyKey();
    set({ phase: "planning" });
    try {
      // The version the editor loaded may be stale (a save from this same page bumps it), so the sheet re-reads the record when it opens.
      const fresh = refetch ? await refetch() : bundle;
      baseRef.current = { key: fresh.key, version: fresh.version };
      const body = await api.post("/admin/deletes", deleteBody({ ...baseRef.current, dryRun: true }));
      set({ phase: "ready", view: planView(body) });
    } catch (e) {
      set({ phase: "error", problem: problemFor(e) });
    }
  };
  const confirm = async () => {
    // From "ready", or from a retryable error (the answer was lost or the site failed) with a plan on screen: the same key, so a delete that did commit replays.
    const again = sheet && sheet.phase === "error" && sheet.view && sheet.problem && sheet.problem.retry && keyRef.current;
    if (!sheet || !(sheet.phase === "ready" || again)) return;
    const view = sheet.view;
    set({ phase: "deleting", view });
    try {
      // One key for this sheet: if the answer is lost, the same click replays the receipt instead of deleting twice.
      await api.post("/admin/deletes", deleteBody({ ...baseRef.current }), { headers: { "Idempotency-Key": keyRef.current } });
      set(null);
      return true;
    } catch (e) {
      set({ phase: "error", problem: problemFor(e), view });
      return false;
    }
  };
  return { sheet, open, confirm, close: () => set(null), cls };
}

export function DeletePanel({ cls, bundle, signInHref, refetch }) {
  const flow = useDelete({ cls, bundle, refetch });
  const [gone, setGone] = useState(false);
  const ref = useRef(null);
  const { sheet } = flow;
  useEffect(() => {
    const d = ref.current;
    if (!d || typeof d.showModal !== "function") return;
    if (sheet && !d.open) d.showModal();
    else if (!sheet && d.open) d.close();
  }, [sheet]);
  if (gone) {
    return (
      <div className="hfy-admin__done" role="status" data-hfy-admin-done>
        <p>{COPY.done} {COPY.doneGone}</p>
        <a className="hfy-admin__link" href="/">{COPY.home}</a>
      </div>
    );
  }
  const busy = sheet && (sheet.phase === "planning" || sheet.phase === "deleting");
  const view = sheet && sheet.view;
  const over = Boolean(view && view.budget && view.budget.over);
  const onConfirm = async () => { if (await flow.confirm()) setGone(true); };
  return (
    <div className="hfy-admin" data-hfy-admin-delete>
      <p className="hfy-admin__lead">{COPY.lead}</p>
      <button type="button" className="hfy-admin__danger" onClick={flow.open} data-hfy-delete-open>{COPY.buttonTitle(cls)}</button>
      <dialog
        ref={ref}
        className="hfy-sheet"
        aria-labelledby="hfy-delete-h"
        onCancel={(e) => { e.preventDefault(); if (!busy || sheet.phase === "planning") flow.close(); }}
        onClose={() => { if (sheet) flow.close(); }}
        data-hfy-delete-sheet={sheet ? sheet.phase : "closed"}
      >
        {sheet && (
          <div className="hfy-sheet__panel" aria-busy={busy ? "true" : "false"}>
            <h2 className="hfy-sheet__h" id="hfy-delete-h">{COPY.sheetTitle(cls)}</h2>
            {sheet.phase === "planning" && <p className="hfy-sheet__note" role="status">{COPY.planning}</p>}
            {sheet.phase === "error" && sheet.problem && (
              <div className="hfy-sheet__problem" role="alert" data-hfy-problem>
                <p>{sheet.problem.text}</p>
                {sheet.problem.signIn && <a className="hfy-sheet__signin" href={signInHref(true)}>{COPY.signIn}</a>}
              </div>
            )}
            {view && (
              <>
                <List id="hfy-delete-goes" title={COPY.goesH} items={view.deletes} />
                <List id="hfy-delete-links" title={COPY.linksH} note={COPY.linksNote} items={view.updates} />
                {view.ids.length > 0 && <p className="hfy-sheet__note" data-hfy-ids>{COPY.idsNote(view.ids)}</p>}
                {view.budget && <p className={over ? "hfy-sheet__problem" : "hfy-sheet__who"} role={over ? "alert" : undefined} data-hfy-budget>{view.budget.text}</p>}
                <p className="hfy-sheet__notice">{COPY.forGood}</p>
              </>
            )}
            <div className="hfy-sheet__actions">
              <button type="button" className="hfy-sheet__secondary" onClick={flow.close} disabled={sheet.phase === "deleting"} data-hfy-delete-cancel>{COPY.cancel}</button>
              {view && (sheet.phase !== "error" || (sheet.problem && sheet.problem.retry)) && (
                <button type="button" className="hfy-admin__danger" onClick={onConfirm} disabled={busy || over} data-hfy-delete-confirm>{sheet.phase === "deleting" ? COPY.deleting : sheet.phase === "error" ? COPY.retryConfirm : COPY.confirm}</button>
              )}
            </div>
          </div>
        )}
      </dialog>
    </div>
  );
}

const PAGE = 50;

/** The possible-duplicates list. Reads /api/admin/duplicates; a page of 50 at a time. */
export function DuplicatesTab() {
  const [state, setState] = useState({ phase: "loading", items: [], cursor: null, total: 0, more: false });
  const load = useCallback(async (cursor) => {
    setState((s) => ({ ...s, phase: cursor ? s.phase : "loading", more: Boolean(cursor) }));
    try {
      const body = await api.get("/admin/duplicates", { query: { limit: PAGE, ...(cursor ? { cursor } : {}) } });
      setState((s) => ({ phase: "ready", items: [...(cursor ? s.items : []), ...(Array.isArray(body.items) ? body.items : [])], cursor: body.cursor || null, total: Number(body.total) || 0, more: false }));
    } catch {
      setState((s) => ({ ...s, phase: "failed", more: false }));
    }
  }, []);
  useEffect(() => { load(null); }, [load]);
  const { phase, items, cursor, more } = state;
  return (
    <section className="hfy-dups" aria-label={COPY.tab} data-hfy-dups>
      <p className="hfy-dups__lead">{COPY.dupLead}</p>
      {phase === "loading" && <div className="hfy-dups__skeleton" role="status" aria-label={COPY.dupLoading} />}
      {phase === "failed" && (
        <p className="hfy-dups__problem" role="alert">{COPY.dupFailed} <button type="button" className="hfy-dups__btn" onClick={() => load(cursor)}>{COPY.retry}</button></p>
      )}
      {phase === "ready" && !items.length && <p className="hfy-dups__note" role="status" data-hfy-empty>{COPY.dupEmpty}</p>}
      {items.length > 0 && (
        <ul className="hfy-dups__items" data-hfy-items>
          {items.map((it) => {
            const row = pairRow(it);
            return (
              <li key={row.key} className="hfy-dups__row" data-hfy-pair>
                {[row.a, row.b].map((p, i) => (
                  <span key={p.key || i} className="hfy-dups__side">
                    {p.href ? <a href={p.href}>{p.text}</a> : <span>{p.text}</span>}
                  </span>
                ))}
                <span className="hfy-dups__strength">{row.strength}</span>
              </li>
            );
          })}
        </ul>
      )}
      {cursor && <button type="button" className="hfy-dups__btn" onClick={() => load(cursor)} disabled={more} data-hfy-more>{COPY.more}</button>}
    </section>
  );
}
