// The review queue's new pieces (HFY-TSK-388-0F; board B9): BatchApprove, ConflictCompare, DeceasedConfirm, TagProposalCard and MediaProposalCard.
// Behind lifeDatesV1 (review.jsx passes `lifeDates`). The rules are in review-batch-model.js; the HTTP is the existing proposal gate source, so a batch
// is one ordinary decision per suggestion (own etag, own Idempotency-Key): nothing here writes in bulk, and one that fails leaves the rest done.
import { useEffect, useId, useMemo, useRef, useState } from "react";
import { makeIdempotencyKey } from "@io-kit/gates";
import { PROJECT } from "./proposal-gate-source.js";
import { ageText, firstSentence } from "./review-model.js";
import { BATCH_COPY as C, classOf, deathAdded, deceasedNames, isPortrait, lifeDatesOf, personIdOf, splitQueue, tagOf, thumbOf, yearsLine } from "./review-batch-model.js";

const isObj = (v) => v !== null && typeof v === "object" && !Array.isArray(v);

const nameOf = (names, view) => (names && names.get(personIdOf(view))) || C.someone;
const proposerOf = (view) => (isObj(view.proposer) && view.proposer.label) || C.someone;

/** The one-line words of a row: "<name>: born about 1890 · died 1962", or the first sentence for a tag. */
function rowText(view, names) {
  const line = yearsLine(view);
  return line ? `${nameOf(names, view)}: ${line}` : firstSentence(view);
}

// ---- DeceasedConfirm ---------------------------------------------------------------------------------------------------------------
/** The confirm every death approval needs (D-19), single or inside a batch: an alertdialog naming who, and what changes. */
export function DeceasedConfirm({ names, onConfirm, onCancel, busy = false }) {
  const ref = useRef(null);
  const cancelRef = useRef(null);
  const uid = useId();
  useEffect(() => {
    const d = ref.current;
    if (d && typeof d.showModal === "function" && !d.open) d.showModal();
    if (cancelRef.current) cancelRef.current.focus();
    return () => { if (d && d.open) d.close(); };
  }, []);
  return (
    <dialog ref={ref} className="hfy-review__sheet" role="alertdialog" aria-labelledby={`${uid}-h`} aria-describedby={`${uid}-d`}
      onCancel={(e) => { e.preventDefault(); if (!busy) onCancel(); }} data-hfy-deceased-confirm>
      <div className="hfy-review__sheetpanel">
        <h2 className="hfy-review__h3" id={`${uid}-h`}>{C.deceasedH}</h2>
        <div id={`${uid}-d`} className="hfy-batch__dbody">
          <p className="hfy-review__note">{C.deceasedLead(names)}</p>
          <ul className="hfy-batch__names" data-hfy-deceased-names>{names.map((n, i) => <li key={`${i}:${n}`}>{n}</li>)}</ul>
          <p className="hfy-review__note">{C.deceasedWhat}</p>
        </div>
        <div className="hfy-review__row">
          <button type="button" className="hfy-review__btn" ref={cancelRef} onClick={onCancel} disabled={busy} data-hfy-deceased-cancel>{C.keepWaiting}</button>
          <button type="button" className="hfy-review__btn hfy-review__btn--primary" onClick={onConfirm} disabled={busy} data-hfy-deceased-ok>{busy ? C.working : C.deceasedConfirm}</button>
        </div>
      </div>
    </dialog>
  );
}

/** The marker on a row or card whose approval adds a death. */
export function DeceasedMark() {
  return <span className="hfy-batch__dead" data-hfy-deceased-mark>{C.deceasedRow}</span>;
}

// ---- TagProposalCard and MediaProposalCard -------------------------------------------------------------------------------------------
function Thumb({ view, rect }) {
  const url = thumbOf(view);
  return (
    <div className="hfy-thumb__frame" data-hfy-thumb>
      {url && <img className="hfy-thumb__img" src={url} alt={C.thumbAlt} loading="lazy" />}
      {rect && <span className="hfy-thumb__box" data-hfy-proposed-box style={{ left: `${rect[0]}%`, top: `${rect[1]}%`, width: `${rect[2] - rect[0]}%`, height: `${rect[3] - rect[1]}%` }} />}
    </div>
  );
}

/** A tag suggestion: the photo with the proposed box dashed, and the one-line summary. */
export function TagProposalCard({ view }) {
  const t = tagOf(view) || {};
  return (
    <figure className="hfy-thumb" data-hfy-tag-card>
      <Thumb view={view} rect={t.rect} />
      <figcaption className="hfy-thumb__cap"><span>{firstSentence(view)}</span>{t.rect && <span className="hfy-review__note">{C.proposedBox}</span>}</figcaption>
    </figure>
  );
}

/** A photo or portrait suggestion, on the same card. */
export function MediaProposalCard({ view }) {
  return (
    <figure className="hfy-thumb" data-hfy-media-card>
      <Thumb view={view} rect={null} />
      <figcaption className="hfy-thumb__cap"><span className="hfy-review__kind">{isPortrait(view) ? C.portraitLine : C.photoLine}</span><span>{firstSentence(view)}</span></figcaption>
    </figure>
  );
}

/** The years of a life-dates suggestion in plain words, with the death marker. */
export function YearsCard({ view }) {
  return (
    <div className="hfy-batch__years" data-hfy-years-card>
      <p className="hfy-batch__yline">{yearsLine(view)}</p>
      {deathAdded(view) && <DeceasedMark />}
    </div>
  );
}

/** The body a card shows in place of the field-by-field rows, or null when the suggestion is not one of these. */
export function ClassBody({ view }) {
  const c = classOf(view);
  if (c === "years") return <YearsCard view={view} />;
  if (c === "tag") return <TagProposalCard view={view} />;
  if (c === "media") return <MediaProposalCard view={view} />;
  return null;
}

// ---- BatchApprove --------------------------------------------------------------------------------------------------------------------
/**
 * The batch panel on the waiting list. `views` are the listed suggestions. Uncontested years and tags are ticked; contested ones are left out and
 * named. If any ticked row adds a death, the confirm lists each of them before anything is sent.
 */
export function BatchApprove({ views, source, names, onChanged, onCompare }) {
  const { batch, contested, groups } = useMemo(() => splitQueue(views), [views]);
  const [off, setOff] = useState(() => new Set());
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState("");
  const uid = useId();
  const picked = batch.filter((v) => !off.has(v.id));
  const dead = picked.filter(deathAdded);
  const toggle = (id) => setOff((cur) => { const n = new Set(cur); if (n.has(id)) n.delete(id); else n.add(id); return n; });

  const run = async () => {
    if (busy) return;
    setBusy(true); setConfirming(false); setResult("");
    let ok = 0;
    for (const v of picked) {
      try {
        await source.decide({ id: v.id, project: PROJECT, etag: v.etag, idempotencyKey: makeIdempotencyKey(v.id, "approve"), verdict: { type: "approve" } });
        ok += 1;
      } catch { /* counted below; the row stays on the list */ }
    }
    setBusy(false);
    setOff(new Set());
    setResult(ok === 0 ? C.noneWent : ok === picked.length ? C.doneN(ok) : C.partial(ok, picked.length - ok));
    onChanged();
  };
  const start = () => { if (!picked.length || busy) return; if (dead.length) setConfirming(true); else run(); };

  if (!batch.length && !contested.length && !result) return null;
  return (
    <section className="hfy-batch" aria-labelledby={`${uid}-h`} data-hfy-batch>
      {batch.length > 0 && (
        <>
          <h2 className="hfy-review__h3" id={`${uid}-h`}>{C.batchH}</h2>
          <p className="hfy-review__note">{C.batchLead}</p>
          <ul className="hfy-batch__list" data-hfy-batch-rows>
            {batch.map((v) => (
              <li key={v.id} data-hfy-batch-row={v.id}>
                <label className="hfy-batch__row">
                  <input type="checkbox" checked={!off.has(v.id)} onChange={() => toggle(v.id)} disabled={busy} />
                  <span className="hfy-batch__text"><span>{rowText(v, names)}</span><span className="hfy-review__note">{proposerOf(v)} · {ageText(v)}</span></span>
                  {deathAdded(v) && <DeceasedMark />}
                </label>
              </li>
            ))}
          </ul>
          <button type="button" className="hfy-review__btn hfy-review__btn--primary" disabled={!picked.length || busy} onClick={start} data-hfy-batch-approve>{busy ? C.working : C.approveN(picked.length)}</button>
          {!picked.length && <p className="hfy-review__note">{C.nothingPicked}</p>}
        </>
      )}
      {result && <p className="hfy-review__ok" role="status" data-hfy-batch-done>{result}</p>}
      {contested.length > 0 && (
        <div className="hfy-batch__contested" data-hfy-contested>
          <h3 className="hfy-review__h4">{C.contestedH}</h3>
          <p className="hfy-review__note">{C.contestedLead}</p>
          <ul className="hfy-batch__list">
            {groups.map((g) => (
              <li key={g.key} className="hfy-batch__row hfy-batch__row--out" data-hfy-contested-row={g.key}>
                <span className="hfy-batch__text">
                  <span>{nameOf(names, g.entries[0])}: {g.entries.map((e) => yearsLine(e)).join(" or ")}</span>
                  <span className="hfy-review__note">{g.entries.length} answers</span>
                </span>
                <button type="button" className="hfy-review__btn" onClick={() => onCompare(g.key)} data-hfy-compare={g.key}>{C.compare}</button>
              </li>
            ))}
            {contested.filter((v) => !lifeDatesOf(v)).map((v) => (
              <li key={v.id} className="hfy-batch__row hfy-batch__row--out" data-hfy-contested-row={v.id}><span className="hfy-batch__text"><span>{firstSentence(v)}</span></span></li>
            ))}
          </ul>
        </div>
      )}
      {confirming && <DeceasedConfirm names={deceasedNames(dead, names)} busy={busy} onCancel={() => setConfirming(false)} onConfirm={run} />}
    </section>
  );
}

// ---- ConflictCompare -----------------------------------------------------------------------------------------------------------------
/** Contested years side by side. No answer is chosen for the admin: "use this one" stays off until one is picked. */
export function ConflictCompare({ group, source, names, onClose, onChanged, onNotice = () => {} }) {
  const [pick, setPick] = useState("");
  const [busy, setBusy] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const [notice, setNotice] = useState("");
  const [failed, setFailed] = useState("");
  const uid = useId();
  const chosen = group.entries.find((e) => e.id === pick) || null;
  const who = nameOf(names, group.entries[0]);

  const approve = async () => {
    if (!chosen || busy) return;
    setBusy(true); setConfirming(false); setFailed("");
    try {
      await source.decide({ id: chosen.id, project: PROJECT, etag: chosen.etag, idempotencyKey: makeIdempotencyKey(chosen.id, "approve"), verdict: { type: "approve" } });
      onChanged(); onClose();
    } catch { setFailed(C.noneWent); } finally { setBusy(false); }
  };
  const askBoth = async () => {
    if (busy) return;
    setBusy(true); setFailed("");
    try {
      for (const e of group.entries) await source.askForChanges({ id: e.id, project: PROJECT, etag: e.etag, idempotencyKey: makeIdempotencyKey(e.id, "needs_changes"), reason: C.askReason });
      setNotice(C.askedBoth); onNotice(C.askedBoth); onChanged();
    } catch { setFailed(C.noneWent); } finally { setBusy(false); }
  };
  return (
    <section className="hfy-batch hfy-cmpwrap" aria-labelledby={`${uid}-h`} data-hfy-compare-panel>
      <h2 className="hfy-review__h3" id={`${uid}-h`}>{C.compareH}</h2>
      <p className="hfy-review__note">{C.compareLead}</p>
      <fieldset className="hfy-cmp">
        <legend className="hfy-cmp__legend">{C.compareLegend(who)}</legend>
        {group.entries.map((e) => (
          <label key={e.id} className="hfy-cmp__opt" data-on={pick === e.id ? "true" : undefined} data-hfy-cmp-opt={e.id}>
            <input type="radio" name={`${uid}-pick`} checked={pick === e.id} onChange={() => setPick(e.id)} disabled={busy} />
            <span className="hfy-cmp__year">{yearsLine(e)}</span>
            <span className="hfy-review__note">{C.sentBy} {proposerOf(e)} · {ageText(e)}</span>
            {typeof e.note === "string" && e.note && <span className="hfy-cmp__note">{e.note}</span>}
            {deathAdded(e) && <DeceasedMark />}
          </label>
        ))}
      </fieldset>
      {notice && <p className="hfy-review__ok" role="status" data-hfy-cmp-notice>{notice}</p>}
      {failed && <p className="hfy-review__problem" role="alert">{failed}</p>}
      <div className="hfy-review__row">
        <button type="button" className="hfy-review__btn hfy-review__btn--primary" disabled={!chosen || busy} onClick={() => (deathAdded(chosen) ? setConfirming(true) : approve())} data-hfy-cmp-use>{busy ? C.working : C.useThis}</button>
        <button type="button" className="hfy-review__btn" disabled={busy || Boolean(notice)} onClick={askBoth} data-hfy-cmp-neither>{C.neither}</button>
        <button type="button" className="hfy-review__btn" onClick={onClose} disabled={busy} data-hfy-cmp-close>{C.closeCompare}</button>
      </div>
      {confirming && chosen && <DeceasedConfirm names={deceasedNames([chosen], names)} busy={busy} onCancel={() => setConfirming(false)} onConfirm={approve} />}
    </section>
  );
}
