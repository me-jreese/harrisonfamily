// The review island's components (HFY-TSK-259; HFY-PLN-002 editing.md section 9.2). `ProposalCard` is what the kit's `useGateInbox` is handed as its
// `renderCard`: the kit's default `GateCardView` shows developer-facing JSON, a "Clear" button and "Snooze 1h", so the family's card replaces it.
// One card serves three readers: an admin deciding (approve, ask for changes, decline, edit then approve), the proposer (edit, withdraw) and a
// member reading what was suggested about their own page. Every person's name is a PersonName link (ruling P2-R46). The pure rules are in
// review-model.js and the HTTP is in proposal-gate-source.js; this file draws them.
import { useEffect, useId, useMemo, useRef, useState } from "react";
import { cardFromConflict, makeIdempotencyKey } from "@io-kit/gates";
import { PROJECT, cardFromApiConflict, proposalToCard } from "./proposal-gate-source.js";
import { PersonName } from "./person-name.jsx";
import { personNames } from "./people-corpus.js";
import { Comments } from "./comments-ui.jsx";
import { fullTime } from "./time.js";
import {
  COPY, ageText, amendReady, isNewer, amendable, approveBlocked, buildAmend, conflictRows, firstSentence, isOutOfDate, kindBadge, needsFreshSignIn, opRows, pageWord, problemOf,
  REASON_MAX, reasonCountText, reasonProblem, rebaseOf, resolvePath, sentences, signInHref, stateChip, touchedKeys, warningsOf,
} from "./review-model.js";

const isObj = (v) => v !== null && typeof v === "object" && !Array.isArray(v);
const arr = (v) => (Array.isArray(v) ? v : []);

/** The family's names by Gramps id (one shared GET /person/index.json). Empty until it loads, and if it never does: a name then falls back to words. */
export function usePersonNames() {
  const [names, setNames] = useState(() => new Map());
  useEffect(() => {
    let live = true;
    personNames().then((m) => { if (live) setNames(m); }, () => {});
    return () => { live = false; };
  }, []);
  return names;
}

// ---- small pieces ------------------------------------------------------------------------------------------------------------
/** "suggested by <name>": the proposer's name is a link to their page. */
function Who({ view }) {
  const p = isObj(view.proposer) ? view.proposer : {};
  return <span className="hfy-review__who">{COPY.suggestedBy} <PersonName id={p.id} name={p.label || "someone"} /></span>;
}

/** "about <name>": the page's name is a link when it is a person's page, else the plain word for the kind of page. */
function About({ view, names }) {
  const s = isObj(view.subject) ? view.subject : {};
  if (s.cls === "Person" && s.gramps_id) return <span className="hfy-review__about">{COPY.about} <PersonName id={s.gramps_id} name={names.get(s.gramps_id) || "a page"} /></span>;
  return <span className="hfy-review__about">{COPY.about} {pageWord(view)}</span>;
}

function Age({ view }) {
  return <time className="hfy-review__age" dateTime={view.created_at} title={fullTime(view.created_at)}>{ageText(view)}</time>;
}

/** The words that say where a suggestion stands: the admin's flags (out of date, asked a question) or the proposer's own chip. */
function StateTag({ view, mode }) {
  const text = mode === "review"
    ? (view.state === "needs_changes" ? "waiting on the person" : isOutOfDate(view) ? COPY.outOfDate : view.state === "pending" ? "" : stateChip(view))
    : stateChip(view);
  return text ? <span className="hfy-review__chip" data-hfy-state={view.state} data-hfy-stale={isOutOfDate(view) ? "true" : undefined}>{text}</span> : null;
}

// ---- the list row -------------------------------------------------------------------------------------------------------------
/** One row of the list: who and what it is about, how old it is, the kind, and the first sentence. Only the button opens the card (names are links). */
export function ProposalRow({ card, selected, onOpen, names, mode }) {
  const view = card.hfy;
  return (
    <li className="hfy-review__item" data-hfy-proposal-id={view.id} data-selected={selected ? "true" : undefined}>
      <p className="hfy-review__meta"><Who view={view} /> <span aria-hidden="true">·</span> <About view={view} names={names} /> <span aria-hidden="true">·</span> <Age view={view} /></p>
      <button type="button" className="hfy-review__open" aria-current={selected ? "true" : undefined} onClick={() => onOpen(view.id)}>
        <span className="hfy-review__kind" data-hfy-kind>{kindBadge(view)}</span>
        <span className="hfy-review__first">{firstSentence(view)}</span>
        <StateTag view={view} mode={mode} />
      </button>
    </li>
  );
}

// ---- before -> after -----------------------------------------------------------------------------------------------------------
function Diff({ parts }) {
  return (
    <span className="hfy-review__diff" data-hfy-diff>
      {parts.map((p, i) => (p.t === "same" ? <span key={i}>{p.text} </span> : p.t === "del" ? <del key={i}>{p.text}</del> : <ins key={i}>{p.text}</ins>))}
    </span>
  );
}

function OpRows({ view }) {
  const rows = opRows(view);
  if (!rows.length) return null;
  return (
    <ul className="hfy-review__ops" aria-label={COPY.edits}>
      {rows.map((r) => (
        <li key={r.id} data-hfy-op={r.id}>
          <span className="hfy-review__sentence">{r.text}</span>
          {r.set && (
            <span className="hfy-review__ba">
              <span className="hfy-review__before"><span className="hfy-review__tag">{COPY.from}</span> {r.before ?? "empty"}</span>
              <span aria-hidden="true">→</span>
              <span className="hfy-review__after"><span className="hfy-review__tag">{COPY.to}</span> {r.after ?? "empty"}</span>
              {r.diff && r.diff.some((p) => p.t !== "same") && <Diff parts={r.diff} />}
            </span>
          )}
        </li>
      ))}
    </ul>
  );
}

/** A relationship suggestion is a list of sentences ("adds [name] as a child of [name]"), not a set of field edits. */
function Sentences({ view }) {
  const list = sentences(view);
  if (!list.length) return null;
  return <ul className="hfy-review__ops" aria-label={COPY.edits}>{list.map((t, i) => <li key={`${i}:${t}`}><span className="hfy-review__sentence">{t}</span></li>)}</ul>;
}

// ---- the stale card ------------------------------------------------------------------------------------------------------------
function ConflictList({ rows }) {
  return (
    <section className="hfy-review__conflicts" aria-labelledby="hfy-conflicts-h" data-hfy-conflicts>
      <h3 className="hfy-review__h4" id="hfy-conflicts-h">{COPY.conflictsH}</h3>
      <p className="hfy-review__note">{COPY.conflictsLead}</p>
      <ul className="hfy-review__ops">
        {rows.map((r) => (
          <li key={r.id} data-hfy-conflict={r.opId}>
            <span className="hfy-review__sentence">{r.text}</span>
            {r.gone ? <span className="hfy-review__note">this page was removed.</span> : (
              <dl className="hfy-review__three">
                {r.base !== null && <div><dt>{COPY.conflictBase}</dt><dd>{r.base}</dd></div>}
                <div><dt>{COPY.conflictNow}</dt><dd>{r.current ?? "empty"}</dd></div>
                <div><dt>{COPY.conflictProposed}</dt><dd>{r.proposed ?? "empty"}</dd></div>
              </dl>
            )}
          </li>
        ))}
      </ul>
    </section>
  );
}

// ---- the amend form ("edit then approve" and the proposer's edit) ---------------------------------------------------------------------
/** The fresh version of each stored object the ops touch, from the edit bundle route. */
async function fetchFresh(api, keys) {
  const out = {};
  await Promise.all(keys.map(async (k) => {
    const [cls, handle] = [k.slice(0, k.indexOf(":")), k.slice(k.indexOf(":") + 1)];
    const b = await api.get(`/edit/${encodeURIComponent(cls)}/${encodeURIComponent(`h:${handle}`)}`);
    out[k] = { version: Number.isInteger(b && b.version) ? b.version : null, obj: b && b.obj };
  }));
  return out;
}

function AmendForm({ view, rebase, admin, api, busy, problem, onCancel, onSubmit }) {
  const uid = useId();
  const [fresh, setFresh] = useState(null);
  const [loadFailed, setLoadFailed] = useState(false);
  const [choices, setChoices] = useState({});
  const [values, setValues] = useState({});
  const [leaveOut, setLeaveOut] = useState(() => new Set());
  const [note, setNote] = useState(typeof view.note === "string" ? view.note : "");
  useEffect(() => {
    let live = true;
    fetchFresh(api, touchedKeys(view.ops)).then((f) => { if (live) setFresh(f); }, () => { if (live) setLoadFailed(true); });
    return () => { live = false; };
  }, [api, view.id, view.etag]); // eslint-disable-line react-hooks/exhaustive-deps

  // A proposer is shown no stored values in a conflict row: the page's value comes from the edit bundle where the path is a plain one.
  const effective = useMemo(() => {
    const ops = new Map(arr(view.ops).filter(isObj).map((o) => [o.id, o]));
    return {
      status: rebase.status,
      conflicts: rebase.conflicts.map((c) => {
        if ("current" in c || !fresh) return c;
        const op = ops.get(c.opId);
        const hit = op && fresh[c.obj] ? resolvePath(fresh[c.obj].obj, c.path || op.path) : { found: false };
        return hit.found ? { ...c, current: hit.value } : c;
      }),
    };
  }, [rebase, fresh, view]);
  const rows = useMemo(() => conflictRows(view, effective), [view, effective]);
  const byOp = useMemo(() => new Map(rows.map((r) => [r.opId, r])), [rows]);
  const versions = useMemo(() => Object.fromEntries(Object.entries(fresh || {}).filter(([, v]) => Number.isInteger(v.version)).map(([k, v]) => [k, v.version])), [fresh]);
  const state = amendReady({ view, rebase: effective, choices, leaveOut });
  const ready = fresh !== null && state.ok;
  const set = (id, v) => setValues((cur) => ({ ...cur, [id]: v }));
  const toggleOut = (id) => setLeaveOut((cur) => { const n = new Set(cur); if (n.has(id)) n.delete(id); else n.add(id); return n; });
  const ops = opRows(view);
  const raw = new Map(arr(view.ops).filter(isObj).map((o) => [o.id, o]));

  return (
    <form className="hfy-review__amend" data-hfy-amend onSubmit={(e) => { e.preventDefault(); if (ready) onSubmit({ ...buildAmend({ view, rebase: effective, choices, values, leaveOut, versions }), note }); }}>
      <h3 className="hfy-review__h4">{admin ? COPY.editApprove : COPY.editSuggestion}</h3>
      {fresh === null && !loadFailed && <p className="hfy-review__note" role="status">{COPY.checking}</p>}
      {loadFailed && <p className="hfy-review__problem" role="alert">{problemOf({ status: 0 }).text}</p>}
      <ul className="hfy-review__ops">
        {ops.map((r) => {
          const op = raw.get(r.id);
          const c = byOp.get(r.id);
          const editable = op && op.op === "set" && typeof op.value === "string";
          const out = leaveOut.has(r.id);
          return (
            <li key={r.id} data-hfy-amend-op={r.id}>
              <span className="hfy-review__sentence">{r.text}</span>
              {c && !c.gone && (
                <fieldset className="hfy-review__choice">
                  <legend className="hfy-review__note">{COPY.conflictNow}: {c.current ?? "empty"}</legend>
                  {c.canKeep && c.current !== null && (
                    <label className="hfy-review__radio"><input type="radio" name={`${uid}-${r.id}`} checked={choices[r.id] === "keep"} onChange={() => setChoices((cur) => ({ ...cur, [r.id]: "keep" }))} /> {COPY.keepSuggested}{c.proposed ? `: ${c.proposed}` : ""}</label>
                  )}
                  <label className="hfy-review__radio"><input type="radio" name={`${uid}-${r.id}`} checked={choices[r.id] === "page"} onChange={() => setChoices((cur) => ({ ...cur, [r.id]: "page" }))} /> {COPY.usePage}</label>
                </fieldset>
              )}
              {c && c.gone && <p className="hfy-review__note">this page was removed, so this one is left out.</p>}
              {editable && (!c || choices[r.id] === "keep") && !out && (
                <div className="hfy-review__field">
                  <label htmlFor={`${uid}-v-${r.id}`}>{COPY.conflictProposed}</label>
                  <input id={`${uid}-v-${r.id}`} type="text" value={r.id in values ? values[r.id] : op.value} onChange={(e) => set(r.id, e.target.value)} />
                </div>
              )}
              {!c && (
                <label className="hfy-review__check"><input type="checkbox" checked={out} onChange={() => toggleOut(r.id)} /> {COPY.leaveOut}</label>
              )}
            </li>
          );
        })}
      </ul>
      {!admin && (
        <div className="hfy-review__field">
          <label htmlFor={`${uid}-note`}>{COPY.noteLabel}</label>
          <textarea id={`${uid}-note`} rows={3} maxLength={REASON_MAX} value={note} onChange={(e) => setNote(e.target.value)} />
        </div>
      )}
      {state.why === "pick" && <p className="hfy-review__note" role="status">{COPY.conflictBlocks}</p>}
      {state.why === "empty" && <p className="hfy-review__note" role="status">{COPY.nothingLeft}</p>}
      {problem && <Problem problem={problem} />}
      <div className="hfy-review__row">
        <button type="submit" className="hfy-review__btn hfy-review__btn--primary" disabled={!ready || busy} data-hfy-amend-send>{busy ? COPY.working : admin ? COPY.approveAmended : COPY.saveChanges}</button>
        <button type="button" className="hfy-review__btn" onClick={onCancel} disabled={busy}>{COPY.cancel}</button>
      </div>
    </form>
  );
}

function Problem({ problem }) {
  return (
    <div className="hfy-review__problem" role="alert" data-hfy-problem>
      <p>{problem.text}</p>
      {problem.signIn && <a className="hfy-review__signin" href={signInHref(problem.stepUp, `${location.pathname}${location.search}`)}>{problem.stepUp ? COPY.signInStepUp : COPY.signIn}</a>}
    </div>
  );
}

// ---- the reason sheet (ask for changes, decline) ------------------------------------------------------------------------------------
function ReasonSheet({ kind, onClose, onSend, busy, problem }) {
  const ref = useRef(null);
  const [text, setText] = useState("");
  const [touched, setTouched] = useState(false);
  const ask = kind === "ask";
  const err = reasonProblem(text);
  useEffect(() => {
    const d = ref.current;
    if (d && typeof d.showModal === "function" && !d.open) d.showModal();
    return () => { if (d && d.open) d.close(); };
  }, []);
  return (
    <dialog ref={ref} className="hfy-review__sheet" aria-labelledby="hfy-reason-h" onCancel={(e) => { e.preventDefault(); if (!busy) onClose(); }} data-hfy-reason-sheet={kind}>
      <form className="hfy-review__sheetpanel" onSubmit={(e) => { e.preventDefault(); setTouched(true); if (!err && !busy) onSend(text.trim()); }}>
        <h2 className="hfy-review__h3" id="hfy-reason-h">{ask ? COPY.askTitle : COPY.declineTitle}</h2>
        <div className="hfy-review__field">
          <label htmlFor="hfy-reason">{ask ? COPY.askLabel : COPY.declineLabel}</label>
          <textarea id="hfy-reason" rows={4} maxLength={REASON_MAX} value={text} onChange={(e) => setText(e.target.value)} onBlur={() => setTouched(true)} aria-describedby="hfy-reason-help hfy-reason-count" aria-invalid={touched && err ? "true" : undefined} required data-hfy-reason />
          <p className="hfy-review__note" id="hfy-reason-help">{ask ? COPY.askHelp : COPY.declineHelp}</p>
          <p className="hfy-review__note" id="hfy-reason-count">{reasonCountText(text.length)}</p>
          {touched && err && <p className="hfy-review__problem" role="alert" data-hfy-reason-error>{err}</p>}
        </div>
        {problem && <Problem problem={problem} />}
        <div className="hfy-review__row">
          <button type="button" className="hfy-review__btn" onClick={onClose} disabled={busy}>{COPY.cancel}</button>
          <button type="submit" className="hfy-review__btn hfy-review__btn--primary" disabled={Boolean(err) || busy} data-hfy-reason-send>{busy ? COPY.working : ask ? COPY.askChanges : COPY.decline}</button>
        </div>
      </form>
    </dialog>
  );
}

// ---- the card ------------------------------------------------------------------------------------------------------------------------
/**
 * The detail card, the `renderCard` the island hands the kit's inbox. `mode` is the tab: "review" (an admin deciding), "mine" (the proposer) or
 * "about" (a member reading what was suggested about their own page). `source` is the proposal gate source; `api` the shared client (the detail,
 * the edit bundle). `onCardChanged(card)` takes a fresh card (a 412, an edit, a decision); `onChanged()` asks the list to reload.
 */
export function ProposalCard({ card, source, api, mode, names, onCardChanged, onChanged }) {
  const listed = card.hfy;
  const [detail, setDetail] = useState({ phase: "idle", view: null, rebase: rebaseOf(null) });
  const [busy, setBusy] = useState("");
  const [problem, setProblem] = useState(null);
  const [sheet, setSheet] = useState(null); // "ask" | "decline"
  const [amending, setAmending] = useState(false);
  const [confirmWithdraw, setConfirmWithdraw] = useState(false);
  const [notice, setNotice] = useState("");
  const [reload, setReload] = useState(0);
  const open = listed.state === "pending" || listed.state === "needs_changes" || listed.state === "stale";
  const wantsDetail = open && (mode === "review" || mode === "mine");

  // The detail (the rebase) of an open card. It is fetched again when the card's etag changes: a 412, an edit, another admin's move.
  useEffect(() => {
    setSheet(null); setAmending(false); setConfirmWithdraw(false);
    if (!wantsDetail) { setDetail({ phase: "idle", view: null, rebase: rebaseOf(null) }); return undefined; }
    let live = true;
    setDetail({ phase: "loading", view: null, rebase: rebaseOf(null) });
    api.get(`/proposals/${encodeURIComponent(listed.id)}`).then(
      (d) => {
        if (!live) return;
        setDetail({ phase: "ready", view: d, rebase: rebaseOf(d) });
        // The detail is the fresher read: when its etag moved on, the list's card is replaced by it (a decision or an edit by someone else).
        if (isObj(d) && typeof d.etag === "string" && d.etag !== listed.etag && isNewer(d, listed)) onCardChanged(proposalToCard(d));
      },
      () => { if (live) setDetail({ phase: "failed", view: null, rebase: rebaseOf(null) }); },
    );
    return () => { live = false; };
  }, [api, listed.id, listed.etag, wantsDetail, reload]); // eslint-disable-line react-hooks/exhaustive-deps

  // The view to act on: the detail when it is for the same etag (it carries `can`), else the listed one.
  const view = detail.view && detail.view.etag === listed.etag ? detail.view : listed;
  const rebase = detail.rebase;
  const can = isObj(view.can) ? view.can : {};
  const admin = mode === "review" && can.decide === true;
  const proposer = mode === "mine";
  const blocked = admin && (approveBlocked(rebase) || detail.phase !== "ready");
  const destructive = needsFreshSignIn(view);
  const rows = useMemo(() => conflictRows(view, rebase), [view, rebase]);
  const head = firstSentence(view);

  const finish = (nextView, text) => {
    setNotice(text || COPY.done);
    setSheet(null); setAmending(false); setConfirmWithdraw(false); setProblem(null);
    if (nextView) onCardChanged(proposalToCard(nextView));
    onChanged();
  };
  const fail = (e) => {
    const fresh = cardFromConflict(e) || cardFromApiConflict(e);
    const p = problemOf(e);
    setProblem(p);
    if (fresh) onCardChanged(fresh);
    else if (p.conflict) { onChanged(); setReload((n) => n + 1); } // a rebase conflict: the suggestion is now out of date; read it again
  };
  const run = async (name, fn) => {
    if (busy) return;
    setBusy(name); setProblem(null); setNotice("");
    try { await fn(); } catch (e) { fail(e); } finally { setBusy(""); }
  };
  const inputFor = (verdict) => ({ id: view.id, project: PROJECT, etag: view.etag, idempotencyKey: makeIdempotencyKey(view.id, verdict) });

  const approve = () => run("approve", async () => {
    const r = await source.decide({ ...inputFor("approve"), verdict: { type: "approve" } });
    finish(r && r.proposal, "added to the family tree.");
  });
  const approveAmended = (amend) => run("approve", async () => {
    const r = await source.decide({ ...inputFor("approve"), verdict: { type: "approve" }, inputs: { amend: { ops: amend.ops, base_versions: amend.base_versions } } });
    finish(r && r.proposal, "added to the family tree.");
  });
  const decline = (reason) => run("decline", async () => {
    const r = await source.decide({ ...inputFor("deny"), verdict: { type: "deny", reason } });
    finish(r && r.proposal, "declined.");
  });
  const askChanges = (reason) => run("ask", async () => {
    const r = await source.askForChanges({ ...inputFor("needs_changes"), reason });
    finish(r && r.proposal, "sent. they'll see your question.");
  });
  const saveEdit = (amend) => run("edit", async () => {
    const r = await source.amend({ id: view.id, etag: view.etag, ops: amend.ops, base_versions: amend.base_versions, note: amend.note });
    finish(r, "saved. it's back in the queue for an admin.");
  });
  const withdraw = () => run("withdraw", async () => {
    const r = await source.withdraw({ id: view.id, etag: view.etag });
    finish(r, "withdrawn.");
  });

  const labelId = useId();
  const showDecision = !open && isObj(view.decision);
  const warnings = warningsOf(view);
  const rel = view.kind === "relationship";
  const canEdit = proposer && can.amend === true && amendable(view);
  return (
    <article className="hfy-review__card" aria-labelledby={labelId} data-hfy-proposal-card data-hfy-card-id={view.id} data-state={view.state} data-mode={mode} data-hfy-rebase={rebase.status}>
      <header className="hfy-review__cardhead">
        <p className="hfy-review__meta"><span className="hfy-review__kind" data-hfy-kind>{kindBadge(view)}</span> <Who view={view} /> <span aria-hidden="true">·</span> <About view={view} names={names} /> <span aria-hidden="true">·</span> <Age view={view} /></p>
        <h2 className="hfy-review__h3" id={labelId}>{head}</h2>
        <StateTag view={view} mode={mode === "review" ? "review" : "mine"} />
      </header>

      {rel ? <Sentences view={view} /> : <OpRows view={view} />}
      {warnings.length > 0 && (
        <section className="hfy-review__warn" aria-label={COPY.warnings}>
          <h3 className="hfy-review__h4">{COPY.warnings}</h3>
          <ul>{warnings.map((w, i) => <li key={`${i}:${w}`}>{w}</li>)}</ul>
        </section>
      )}
      {typeof view.note === "string" && view.note && (
        <section className="hfy-review__noteblock" aria-label={COPY.note}>
          <h3 className="hfy-review__h4">{COPY.note}</h3>
          <p data-hfy-note>{view.note}</p>
        </section>
      )}

      {open && admin && rebase.status === "clean" && <p className="hfy-review__note" role="status" data-hfy-clean>{COPY.stillApplies}</p>}
      {open && rebase.status === "conflict" && rows.length > 0 && (admin || proposer) && <ConflictList rows={rows} />}
      {open && admin && detail.phase === "loading" && <p className="hfy-review__note" role="status">{COPY.checking}</p>}
      {showDecision && (
        <p className="hfy-review__note" role="status" data-hfy-decision>
          {view.state === "approved" ? COPY.approvedLine : stateChip(view)}
        </p>
      )}
      {notice && <p className="hfy-review__ok" role="status" data-hfy-notice>{notice}</p>}
      {problem && !sheet && !amending && <Problem problem={problem} />}

      {amending && (admin || canEdit) && (
        <AmendForm view={view} rebase={rebase} admin={admin} api={api} busy={busy === "approve" || busy === "edit"} problem={problem}
          onCancel={() => { setAmending(false); setProblem(null); }} onSubmit={admin ? approveAmended : saveEdit} />
      )}

      {admin && !amending && (
        <div className="hfy-review__actions" role="group" aria-label="decide" data-hfy-actions>
          <button type="button" className="hfy-review__btn hfy-review__btn--primary" disabled={Boolean(busy) || blocked} aria-describedby={blocked ? `${labelId}-why` : undefined} onClick={approve} data-hfy-act="approve">{busy === "approve" ? COPY.working : COPY.approve}</button>
          <button type="button" className="hfy-review__btn" disabled={Boolean(busy)} onClick={() => { setProblem(null); setSheet("ask"); }} data-hfy-act="ask">{COPY.askChanges}</button>
          <button type="button" className="hfy-review__btn hfy-review__btn--danger" disabled={Boolean(busy)} onClick={() => { setProblem(null); setSheet("decline"); }} data-hfy-act="decline">{COPY.decline}</button>
          {amendable(view) && <button type="button" className="hfy-review__btn" disabled={Boolean(busy) || detail.phase !== "ready"} onClick={() => { setProblem(null); setAmending(true); }} data-hfy-act="edit">{COPY.editApprove}</button>}
          {blocked && detail.phase === "ready" && <p className="hfy-review__note" id={`${labelId}-why`} data-hfy-blocked>{COPY.conflictBlocks}</p>}
          {destructive && <p className="hfy-review__note" data-hfy-stepup>{COPY.signInAgain}</p>}
        </div>
      )}

      {proposer && open && !amending && (
        <div className="hfy-review__actions" role="group" aria-label="your suggestion" data-hfy-actions>
          {canEdit && <button type="button" className="hfy-review__btn hfy-review__btn--primary" disabled={Boolean(busy) || detail.phase !== "ready"} onClick={() => { setProblem(null); setAmending(true); }} data-hfy-act="edit">{COPY.editSuggestion}</button>}
          {can.withdraw === true && !confirmWithdraw && <button type="button" className="hfy-review__btn" disabled={Boolean(busy)} onClick={() => setConfirmWithdraw(true)} data-hfy-act="withdraw">{COPY.withdraw}</button>}
          {can.withdraw === true && confirmWithdraw && (
            <div className="hfy-review__confirm" role="group" aria-label={COPY.withdrawAsk} data-hfy-confirm>
              <p>{COPY.withdrawAsk}</p>
              <button type="button" className="hfy-review__btn hfy-review__btn--danger" disabled={Boolean(busy)} onClick={withdraw} data-hfy-act="withdraw-yes">{COPY.withdraw}</button>
              <button type="button" className="hfy-review__btn" onClick={() => setConfirmWithdraw(false)} data-hfy-act="withdraw-keep">{COPY.keep}</button>
            </div>
          )}
          {!canEdit && can.amend === true && !amendable(view) && <p className="hfy-review__note">{COPY.noEdit}</p>}
        </div>
      )}

      {sheet && <ReasonSheet kind={sheet} busy={Boolean(busy)} problem={problem} onClose={() => { setSheet(null); setProblem(null); }} onSend={sheet === "ask" ? askChanges : decline} />}

      <Comments subject={`proposal:${view.id}`} />
    </article>
  );
}

/** The chips row: a group of toggle buttons, one pressed. */
export function Chips({ chips, active, onPick, label }) {
  return (
    <div className="hfy-review__chips" role="group" aria-label={label}>
      {chips.map((c) => <button key={c.id} type="button" className="hfy-review__chipbtn" aria-pressed={c.id === active} onClick={() => onPick(c.id)} data-hfy-chip={c.id}>{c.label}</button>)}
    </div>
  );
}
