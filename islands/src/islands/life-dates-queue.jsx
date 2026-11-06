// The Life dates rapid-entry queue (HFY-TSK-388-0E, flag lifeDatesV1; BRD 5.7 D-26; board B6 "help fill in dates"). A HFY app island, not a kit
// package, on the static /me/dates/ page. One card per person who lacks a year; the keypad input is focused, 'save and next' sends a normal suggestion
// through POST /api/life-dates (Idempotency-Key) and moves on, 'skip' and 'i don't know' write nothing and mark nothing. Order and source: the model.
import "./life-dates-queue.css";
import { useEffect, useId, useRef, useState } from "react";
import { api } from "../lib/api.js";
import { newIdempotencyKey } from "../lib/editor-save.js";
import { readClasses } from "../lib/life-dates-model.js";
import { memberSub, useEdgeSession } from "../lib/edge-session.js";
import { mountIsland } from "../lib/mount.jsx";
import { COPY, addPending, addedText, alreadySent, ask, candidatesFrom, cardBody, checkCard, createTimingRecorder, debugOn, eligible, errorText, knownLine, progressText, readReply, sentText, sureText } from "../lib/life-dates-queue-model.js";

// Per-card timing (HFY-TSK-400, O-9): in memory only, read through window.__hfyQueueStats?.() and console.debug, both only with ?hfy_debug=1. Members see nothing.
const timing = createTimingRecorder();
const debug = debugOn(window.location.search);
if (debug) window.__hfyQueueStats = () => timing.stats();
const lap = () => { const s = timing.stop(); if (debug && s !== null) console.debug("hfy queue stats", timing.stats()); };

const store = () => { try { return window.sessionStorage; } catch { return { getItem: () => null, setItem: () => {} }; } };

async function loadPeople() {
  const flags = window.HFYFeatureFlags;
  const init = { credentials: "same-origin" };
  const res = await (flags && flags.dataFetch ? flags.dataFetch("/person/index.json", init) : fetch("/person/index.json", init));
  if (!res.ok) throw new Error(String(res.status));
  return res.json();
}

/** The handle, then how exact each date on file is. null when either cannot be read (the person is passed over, never guessed at). */
async function loadInfo(row) {
  const rec = await api.get(`/records/Person/by-id/${encodeURIComponent(row.id)}`);
  const handle = rec && typeof rec.handle === "string" ? rec.handle : null;
  if (!handle) return null;
  const classes = readClasses(await api.get(`/life-dates?target=${encodeURIComponent(`Person:${handle}`)}`));
  return classes ? { handle, classes } : null;
}

function Card({ row, handle, onAdvance, onSkip }) {
  const id = useId();
  const input = useRef(null);
  const attempt = useRef({ json: "", key: "" });
  const [text, setText] = useState("");
  const [error, setError] = useState("");
  const [sure, setSure] = useState(null);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");
  useEffect(() => { timing.start(); input.current?.focus(); }, []);
  const errId = `${id}-err`;

  async function send({ confirm = false, unknown = false } = {}) {
    setMessage("");
    if (!unknown) {
      if (!text.trim()) { setError(COPY.enterYear); return; }
      const v = checkCard(row, text);
      if (v.error) { setError(v.error); return; }
      setError("");
      if (v.needsSure && !confirm) { setSure(v.years); return; }
    }
    const body = cardBody(handle, row, text, { confirm, unknown });
    if (!body) { setMessage(errorText({ status: 500 })); return; }
    setBusy(true);
    try {
      const json = JSON.stringify(body);
      if (attempt.current.json !== json) attempt.current = { json, key: newIdempotencyKey() };
      const res = await api.post("/life-dates", body, { headers: { "Idempotency-Key": attempt.current.key } });
      const reply = readReply(res, body);
      if (reply.confirm) { setSure(reply.years || 121); setBusy(false); return; }
      const saved = Object.keys(reply.saved).length > 0;
      if (saved) addPending(store(), row.id, reply.saved);
      onAdvance({ saved, notes: reply.notes });
    } catch (err) {
      setMessage(errorText(err)); // the year stays in the field
      setBusy(false);
    }
  }

  return (
    <form className="hfy-lq__card" data-q="card" noValidate onSubmit={(e) => { e.preventDefault(); if (!busy) send({ confirm: sure !== null }); }}>
      <h2 className="hfy-lq__name" data-q="name">{row.name}</h2>
      <p className="hfy-lq__known" data-q="known">{knownLine(row)}</p>
      <label className="hfy-lq__ask" htmlFor={id}>{ask(row)}</label>
      <input ref={input} id={id} className={`hfy-lq__yr${error ? " hfy-lq__yr--err" : ""}`} type="text" inputMode="numeric" pattern="[0-9]*" maxLength={4} autoComplete="off"
        value={text} aria-invalid={error ? "true" : undefined} aria-describedby={error ? errId : undefined} data-q="year"
        onChange={(e) => { setText(e.target.value.replace(/[^0-9]/g, "")); setError(""); setSure(null); }} />
      {error && <p className="hfy-lq__err" id={errId} role="alert" data-q="error">{error}</p>}
      {message && <p className="hfy-lq__err" role="alert" data-q="message">{message}</p>}
      {sure !== null && (
        <div className="hfy-lq__sure" role="group" aria-label="are you sure?">
          <p className="hfy-lq__err" role="alert" data-q="sure">{sureText(sure)}</p>
          <button type="button" className="hfy-lq__btn hfy-lq__btn--pri" disabled={busy} onClick={() => send({ confirm: true })} data-q="sure-yes">{COPY.yes}</button>
          <button type="button" className="hfy-lq__btn" disabled={busy} onClick={() => setSure(null)} data-q="sure-no">{COPY.no}</button>
        </div>
      )}
      {sure === null && (
        <>
          <button type="submit" className="hfy-lq__btn hfy-lq__btn--pri hfy-lq__btn--lg" disabled={busy} data-q="save">{busy ? COPY.saving : COPY.save}</button>
          <div className="hfy-lq__pair">
            <button type="button" className="hfy-lq__btn" disabled={busy} onClick={onSkip} data-q="skip">{COPY.skip}</button>
            <button type="button" className="hfy-lq__btn" disabled={busy} onClick={onSkip} data-q="dontknow">{COPY.dontKnow}</button>
          </div>
          {row.kind === "death" && (
            <div className="hfy-lq__unk">
              <button type="button" className="hfy-lq__btn hfy-lq__btn--quiet" disabled={busy} onClick={() => send({ unknown: true })} data-q="unknown">{COPY.unknownDeath}</button>
              <span className="hfy-lq__note">{COPY.unknownNote}</span>
            </div>
          )}
        </>
      )}
    </form>
  );
}

function Queue() {
  const [phase, setPhase] = useState("loading"); // loading | failed | ready
  const [tick, setTick] = useState(0);
  const [rows, setRows] = useState([]);
  const [idx, setIdx] = useState(0);
  const [cur, setCur] = useState(null); // null while the next person is being checked, "done" at the end, else { i, row, handle }
  const [added, setAdded] = useState(0);
  const [sent, setSent] = useState(false);
  const [note, setNote] = useState("");
  const cache = useRef(new Map());
  const lookup = (row) => {
    if (!cache.current.has(row.id)) cache.current.set(row.id, loadInfo(row).catch(() => null));
    return cache.current.get(row.id);
  };

  useEffect(() => {
    let live = true;
    setPhase("loading");
    loadPeople().then((m) => { if (live) { setRows(candidatesFrom(m)); setIdx(0); setPhase("ready"); } }, () => { if (live) setPhase("failed"); });
    return () => { live = false; };
  }, [tick]);

  useEffect(() => {
    if (phase !== "ready") return undefined;
    let live = true;
    setCur(null);
    (async () => {
      let i = idx;
      while (i < rows.length) {
        const row = rows[i];
        if (!alreadySent(store(), row)) {
          const info = await lookup(row);
          if (!live) return;
          if (info && eligible(row, info.classes)) {
            setCur({ i, row, handle: info.handle });
            if (rows[i + 1]) lookup(rows[i + 1]);
            return;
          }
        }
        i += 1;
      }
      if (live) setCur("done");
    })();
    return () => { live = false; };
  }, [phase, rows, idx]);

  const here = cur && cur !== "done" ? cur : null;
  const nextName = here ? here.row.name : "";
  const total = rows.length;
  const advance = (o) => {
    lap();
    if (o.saved) setAdded((n) => n + 1);
    setSent(o.saved);
    setNote(o.notes.join(" "));
    setIdx(here.i + 1);
  };
  const skip = () => { lap(); setSent(false); setNote(""); setIdx(here.i + 1); };

  return (
    <section className="hfy-lq" aria-label={COPY.title} aria-busy={phase === "loading" || cur === null}>
      <p className="hfy-lq__lede">{COPY.lede}</p>
      {phase === "loading" && <p className="hfy-lq__note" role="status">{COPY.loading}</p>}
      {phase === "failed" && (
        <div className="hfy-lq__empty" data-q="failed">
          <p role="alert">{COPY.loadFailed}</p>
          <button type="button" className="hfy-lq__btn" onClick={() => setTick((t) => t + 1)} data-q="retry">{COPY.retry}</button>
        </div>
      )}
      {phase === "ready" && total > 0 && (
        <div className="hfy-lq__prog">
          <div className="hfy-lq__bar" role="progressbar" aria-label="people done in this branch" aria-valuemin={0} aria-valuemax={total} aria-valuenow={here ? here.i : cur === "done" ? total : idx} data-q="bar">
            <div className="hfy-lq__fill" style={{ width: `${Math.round(((here ? here.i : cur === "done" ? total : idx) / total) * 100)}%` }} />
          </div>
          <p className="hfy-lq__count" data-q="progress">{progressText(here ? here.i : cur === "done" ? total : idx, total)}</p>
          {added > 0 && <p className="hfy-lq__count" data-q="added">{addedText(added)}</p>}
        </div>
      )}
      <div className="hfy-lq__live" role="status" data-q="status">{sent ? sentText(nextName) : note}</div>
      {phase === "ready" && total === 0 && (
        <div className="hfy-lq__empty" data-q="empty"><h2>{COPY.emptyTitle}</h2><p>{COPY.emptyBody}</p></div>
      )}
      {phase === "ready" && total > 0 && cur === null && <p className="hfy-lq__note">{COPY.finding}</p>}
      {here && <Card key={here.row.id} row={here.row} handle={here.handle} onAdvance={advance} onSkip={skip} />}
      {cur === "done" && (
        <div className="hfy-lq__empty" data-q="done"><h2>{COPY.doneTitle}</h2>{added > 0 && <p>{addedText(added)}</p>}</div>
      )}
    </section>
  );
}

function Page() {
  const session = useEdgeSession();
  const sub = memberSub(session);
  return (
    <div>
      {session === undefined && <p className="hfy-lq__note" role="status">{COPY.loading}</p>}
      {session !== undefined && !sub && (
        <p className="hfy-lq__note" data-q="signin">{COPY.signIn} <a href={`/auth/login?returnTo=${encodeURIComponent("/me/dates/")}`}>{COPY.signInLink}</a></p>
      )}
      {sub && <Queue />}
    </div>
  );
}

const off = document.querySelector("[data-dates-off]");
if (off) off.remove();
mountIsland("life-dates-queue", Page);
