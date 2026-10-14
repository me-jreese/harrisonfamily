// /me/requests/: the access-requests island (HFY-TSK-264, surf-access-admin-ui; flag accessRequests; surfaces.md 7.4 and 7.10, BRD2 D2-23,
// reviews PS-13 and IF-06). The admin queue of the family's requests to join: three tabs (waiting, adding to the tree, done), a list, and a
// detail with the answers, the masked email (no copy button, ever: the admin never has the address, IF-06), "who is this?" (the top five
// candidates from the family index), "they're new" (an editable Gramps preview) and "not now / decline". Every link and new needs the
// "confirmed with this person outside the site" box (PS-13); a link, a new and a remove need a fresh sign-in, which the server asks for with
// 401 step_up_required and this page answers with a sign-in link. Under 64rem the list and the detail are two views (?id=); from it two columns.
// A non-admin sees one line and no request is made for them. feature-flags.js loads this bundle only with accessRequests on, so with the flag
// off nothing here is requested and the static page keeps its "not available yet" line (HFY-R8).
import "./access-requests.css";
import { useCallback, useEffect, useId, useMemo, useRef, useState } from "react";
import { api } from "../lib/api.js";
import { getMe, forgetMe } from "../lib/me.js";
import { memberSub, useEdgeSession } from "../lib/edge-session.js";
import { mountIsland } from "../lib/mount.jsx";
import { PersonName } from "../lib/person-name.jsx";
import {
  COPY, TABS, answersOf, applyUniquePlaces, askedAgo, bornLine, declineBody, describeError, editPreview, giveAccessPrompt, linkBody, locationFor, newBody,
  parseLocation, placeChoices, previewFields, rankCandidates, removePrompt, requesterName, resultLine, revokeBody, setEventPlace, stateWords, tabById, tidyPreviewNames,
} from "../lib/access-requests-model.js";

/** The sign-in link: a fresh one (prompt=login) for a step-up, back to this same list or detail. */
export const signInHref = (fresh) => `/auth/login?${fresh ? "prompt=login&" : ""}returnTo=${encodeURIComponent(`${location.pathname}${location.search}`)}`;

/** Tell the shell's gear that the count moved (the badge asks /api/me again). */
const CHANGED_EVENT = "hfy:access-requests-changed";
const announceChanged = () => { forgetMe(); try { window.dispatchEvent(new CustomEvent(CHANGED_EVENT)); } catch { /* no event, the badge catches up on the next page */ } };

const wide = () => typeof matchMedia === "function" && matchMedia("(min-width: 64rem)").matches;
function useWide() {
  const [isWide, setIsWide] = useState(wide());
  useEffect(() => {
    if (typeof matchMedia !== "function") return undefined;
    const mq = matchMedia("(min-width: 64rem)");
    const on = () => setIsWide(mq.matches);
    mq.addEventListener("change", on);
    return () => mq.removeEventListener("change", on);
  }, []);
  return isWide;
}

/** A gated data file (the family index, the place index), through the page's refreshing fetch when it has one. Resolves to the parsed body or null. */
async function loadData(url) {
  try {
    const flags = window.HFYFeatureFlags;
    const init = { credentials: "same-origin" };
    const res = await (flags && flags.dataFetch ? flags.dataFetch(url, init) : fetch(url, init));
    if (!res.ok) return null;
    return await res.json();
  } catch {
    return null;
  }
}
const rowsOf = (body) => (Array.isArray(body?.people) ? body.people : Array.isArray(body) ? body : []);
let indexes = null;
/** The family index and the place index, once per page. A file that does not load is an empty list (the admin can still decide by hand). */
const loadIndexes = () => (indexes ??= Promise.all([loadData("/person/index.json"), loadData("/place/index.json")]).then(([p, pl]) => ({ people: rowsOf(p), places: rowsOf(pl) })));

// ---- small pieces ----------------------------------------------------------------------------------------------------------------------
function Problem({ problem }) {
  if (!problem) return null;
  return (
    <div className="hfy-requests__problem" role="alert" data-hfy-problem={problem.kind}>
      <p>{problem.text}</p>
      {problem.kind === "signin" && <a className="hfy-requests__signin" href={signInHref(true)}>sign in again</a>}
      {problem.kind === "field" && problem.errors?.length > 0 && (
        <ul>{problem.errors.map((e, i) => <li key={i}>{typeof e.detail === "string" ? e.detail : String(e.pointer || "")}</li>)}</ul>
      )}
    </div>
  );
}

function Confirmed({ checked, onChange, idPrefix }) {
  const id = `${idPrefix}-confirmed`;
  return (
    <div className="hfy-requests__check">
      <input type="checkbox" id={id} checked={checked} onChange={(e) => onChange(e.target.checked)} required data-hfy-confirmed />
      <label htmlFor={id}>{COPY.confirmedOutside}</label>
    </div>
  );
}

function Row({ item, selected, onOpen }) {
  const born = bornLine(item);
  return (
    <li className="hfy-requests__item" data-selected={selected ? "true" : undefined} data-hfy-request={item.id}>
      <button type="button" className="hfy-requests__open" onClick={() => onOpen(item.id)} aria-current={selected ? "true" : undefined}>
        <span className="hfy-requests__name">{requesterName(item) || "someone"}</span>
        {item.state && item.state !== "pending" && item.state !== "awaiting_record" && <span className="hfy-requests__chip">{stateWords(item.state)}</span>}
        {born && <span className="hfy-requests__meta">{born}</span>}
        <span className="hfy-requests__meta">{askedAgo(item.createdAt)}</span>
      </button>
    </li>
  );
}

// ---- who is this? ------------------------------------------------------------------------------------------------------------------------
function Candidates({ request, onPick, disabled }) {
  const [idx, setIdx] = useState(null);
  useEffect(() => {
    let live = true;
    loadIndexes().then((i) => { if (live) setIdx(i); });
    return () => { live = false; };
  }, []);
  const list = useMemo(() => (idx ? rankCandidates(request, idx.people, idx.places) : []), [idx, request]);
  if (!idx) return <p className="hfy-requests__note" role="status">looking through the tree…</p>;
  if (!list.length) return <p className="hfy-requests__note" data-hfy-no-candidates>{COPY.noCandidates}</p>;
  return (
    <ul className="hfy-requests__candidates" data-hfy-candidates>
      {list.map((c) => (
        <li key={c.id} className="hfy-requests__candidate" data-hfy-candidate={c.id}>
          <span className="hfy-requests__who"><PersonName id={c.id} name={c.name} />{c.line && <span className="hfy-requests__meta"> {c.line}</span>}</span>
          <button type="button" className="hfy-requests__btn" onClick={() => onPick(c)} disabled={disabled} data-hfy-act="its-them" aria-label={`it's them: ${c.name}`}>it's them</button>
        </li>
      ))}
    </ul>
  );
}

// ---- they're new: the editable Gramps preview ----------------------------------------------------------------------------------------
function PreviewEditor({ preview, onChange, places }) {
  const base = useId();
  const f = previewFields(preview);
  const choices = placeChoices(preview, places);
  const field = (key, label, props = {}) => (
    <div className="hfy-requests__field">
      <label htmlFor={`${base}-${key}`}>{label}</label>
      <input type="text" id={`${base}-${key}`} value={f[key]} onChange={(e) => onChange(editPreview(preview, key, e.target.value))} data-hfy-preview={key} {...props} />
    </div>
  );
  return (
    <div className="hfy-requests__preview" data-hfy-preview-editor>
      {field("given", "given names", { autoComplete: "off", maxLength: 100 })}
      {field("surname", "last name at birth", { autoComplete: "off", maxLength: 60 })}
      {field("nick", "what the family calls them", { autoComplete: "off", maxLength: 40 })}
      {field("birthYear", "born (the year)", { inputMode: "numeric", maxLength: 4 })}
      <div className="hfy-requests__field">
        <label htmlFor={`${base}-gender`}>gender</label>
        <select id={`${base}-gender`} value={f.gender} onChange={(e) => onChange(editPreview(preview, "gender", e.target.value))} data-hfy-preview="gender">
          <option value={0}>female</option>
          <option value={1}>male</option>
        </select>
      </div>
      {choices.map((c) => (
        <div className="hfy-requests__field" key={c.eventKey}>
          <label htmlFor={`${base}-place-${c.eventKey}`}>{c.role === "birth" ? "place of birth" : "place they live"}: {c.raw}</label>
          <select id={`${base}-place-${c.eventKey}`} value={c.chosen} onChange={(e) => onChange(setEventPlace(preview, c.eventKey, e.target.value))} data-hfy-place={c.eventKey}>
            <option value="">{c.matches.length ? "not chosen, add it later" : "no place in the tree matches, add it later"}</option>
            {c.matches.map((m) => <option key={m.handle} value={m.handle}>{m.displayName}</option>)}
          </select>
          {c.ambiguous && <p className="hfy-requests__note">more than one place has this name. pick the right one.</p>}
        </div>
      ))}
    </div>
  );
}

// ---- the actions of a waiting request ----------------------------------------------------------------------------------------------------
function Actions({ detail, name, onDone, onProblem, problem, busy, setBusy }) {
  const base = useId();
  const [mode, setMode] = useState(null); // null | { kind: "link", cand } | "new" | "decline"
  const [confirmed, setConfirmed] = useState(false);
  const [preview, setPreview] = useState(null);
  const [places, setPlaces] = useState([]);
  const [note, setNote] = useState("");
  const [sendNote, setSendNote] = useState(false);
  const [needSecond, setNeedSecond] = useState(false);
  const pending = detail.state === "pending";
  const request = useMemo(() => ({ ...(detail.form || {}) }), [detail.form]);

  const reset = () => { setMode(null); setConfirmed(false); setNote(""); setSendNote(false); setNeedSecond(false); onProblem(null); };
  const startNew = async () => {
    onProblem(null);
    setConfirmed(false);
    const i = await loadIndexes();
    setPlaces(i.places);
    setPreview(detail.preview ? tidyPreviewNames(applyUniquePlaces(detail.preview, i.places)) : null);
    setMode("new");
  };

  const send = async (body, { second = false } = {}) => {
    setBusy(true);
    onProblem(null);
    try {
      const answer = await api.post(`/access-requests/${encodeURIComponent(detail.id)}/decision`, body);
      announceChanged();
      onDone(resultLine(answer));
      reset();
    } catch (err) {
      const p = describeError(err);
      if (p.kind === "second" && !second) setNeedSecond(true);
      onProblem(p);
    } finally {
      setBusy(false);
    }
  };
  const link = (second) => send(linkBody({ grampsId: mode.cand.id, version: detail.version, confirmedOutside: confirmed, allowSecondEmail: second }), { second });

  return (
    <section className="hfy-requests__actions" aria-labelledby={`${base}-who`} data-hfy-actions>
      <h3 className="hfy-requests__h4" id={`${base}-who`}>{COPY.whoIsThis}</h3>
      {mode !== "new" && (
        <Candidates request={request} onPick={(cand) => { setMode({ kind: "link", cand }); setConfirmed(false); setNeedSecond(false); onProblem(null); }} disabled={busy} />
      )}

      {mode && mode.kind === "link" && (
        <form className="hfy-requests__confirm" role="group" aria-label="let them in" onSubmit={(e) => { e.preventDefault(); if (confirmed && !busy) link(false); }} data-hfy-confirm="link">
          <p className="hfy-requests__ask">{giveAccessPrompt(name, mode.cand.name)}</p>
          <Confirmed checked={confirmed} onChange={setConfirmed} idPrefix={`${base}-link`} />
          <div className="hfy-requests__row">
            <button type="submit" className="hfy-requests__btn hfy-requests__btn--primary" disabled={!confirmed || busy} data-hfy-act="let-in">{COPY.letThemIn}</button>
            {needSecond && <button type="button" className="hfy-requests__btn" disabled={!confirmed || busy} onClick={() => link(true)} data-hfy-act="second-email">add as a second email</button>}
            <button type="button" className="hfy-requests__btn" onClick={reset} disabled={busy}>{COPY.notYet}</button>
          </div>
        </form>
      )}

      {pending && mode !== "new" && !(mode && mode.kind === "link") && (
        <button type="button" className="hfy-requests__btn" onClick={startNew} disabled={busy} data-hfy-act="new">{COPY.theyAreNew}</button>
      )}
      {mode === "new" && (
        <form className="hfy-requests__confirm" role="group" aria-label={COPY.theyAreNew} onSubmit={(e) => { e.preventDefault(); if (confirmed && preview && !busy) send(newBody({ preview, version: detail.version, confirmedOutside: confirmed })); }} data-hfy-confirm="new">
          <h3 className="hfy-requests__h4">{COPY.theyAreNew}</h3>
          {preview ? <PreviewEditor preview={preview} onChange={setPreview} places={places} /> : <p className="hfy-requests__note">the answers can't be turned into a page yet. read them above, and add this person in Gramps first.</p>}
          <Confirmed checked={confirmed} onChange={setConfirmed} idPrefix={`${base}-new`} />
          <div className="hfy-requests__row">
            <button type="submit" className="hfy-requests__btn hfy-requests__btn--primary" disabled={!confirmed || !preview || busy} data-hfy-act="add-new">add them to the tree</button>
            <button type="button" className="hfy-requests__btn" onClick={reset} disabled={busy}>{COPY.notYet}</button>
          </div>
        </form>
      )}

      {mode !== "decline" ? (
        !(mode && mode.kind === "link") && mode !== "new" && (
          <button type="button" className="hfy-requests__btn hfy-requests__btn--quiet" onClick={() => { setMode("decline"); onProblem(null); }} disabled={busy} data-hfy-act="decline">{COPY.decline}</button>
        )
      ) : (
        <form className="hfy-requests__confirm" onSubmit={(e) => { e.preventDefault(); if (!busy) send(declineBody({ note, sendNote, version: detail.version })); }} data-hfy-confirm="decline">
          <div className="hfy-requests__field">
            <label htmlFor={`${base}-note`}>a note, if you want to leave one</label>
            <textarea id={`${base}-note`} rows={3} maxLength={500} value={note} onChange={(e) => setNote(e.target.value)} data-hfy-note />
          </div>
          <div className="hfy-requests__check">
            <input type="checkbox" id={`${base}-send`} checked={sendNote} onChange={(e) => setSendNote(e.target.checked)} disabled={!note.trim()} />
            <label htmlFor={`${base}-send`}>{COPY.includeNote}</label>
          </div>
          <div className="hfy-requests__row">
            <button type="submit" className="hfy-requests__btn hfy-requests__btn--danger" disabled={busy} data-hfy-act="send-decline">decline</button>
            <button type="button" className="hfy-requests__btn" onClick={reset} disabled={busy}>{COPY.notYet}</button>
          </div>
        </form>
      )}
      <Problem problem={problem} />
    </section>
  );
}

// ---- removing access ----------------------------------------------------------------------------------------------------------------------
// TODO(HFY-TSK-331): revoking is keyed by the ALLOW# entry (ruling P2-R60), which HFY-TSK-331 adds as its own route; until it merges this
// calls the request-based revoke (POST /api/access-requests/:id/revoke), which works while the request is still inside its retention.
function Revoke({ detail, name, onDone, onProblem, problem, busy, setBusy }) {
  const base = useId();
  const [open, setOpen] = useState(false);
  const [confirmed, setConfirmed] = useState(false);
  const go = async () => {
    setBusy(true);
    onProblem(null);
    try {
      const answer = await api.post(`/access-requests/${encodeURIComponent(detail.id)}/revoke`, revokeBody({ version: detail.version, confirmedOutside: confirmed }));
      announceChanged();
      onDone(resultLine(answer, { revoke: true }));
      setOpen(false);
    } catch (err) {
      onProblem(describeError(err));
    } finally {
      setBusy(false);
    }
  };
  return (
    <section className="hfy-requests__actions" data-hfy-actions>
      {!open ? (
        <button type="button" className="hfy-requests__btn hfy-requests__btn--danger" onClick={() => { setOpen(true); onProblem(null); }} disabled={busy} data-hfy-act="remove-open">remove access</button>
      ) : (
        <form className="hfy-requests__confirm" role="group" aria-label="remove access" onSubmit={(e) => { e.preventDefault(); if (confirmed && !busy) go(); }} data-hfy-confirm="revoke">
          <p className="hfy-requests__ask">{removePrompt(name)}</p>
          <Confirmed checked={confirmed} onChange={setConfirmed} idPrefix={`${base}-revoke`} />
          <div className="hfy-requests__row">
            <button type="submit" className="hfy-requests__btn hfy-requests__btn--danger" disabled={!confirmed || busy} data-hfy-act="remove">{COPY.remove}</button>
            <button type="button" className="hfy-requests__btn" onClick={() => { setOpen(false); setConfirmed(false); }} disabled={busy}>{COPY.keep}</button>
          </div>
        </form>
      )}
      <Problem problem={problem} />
    </section>
  );
}

// ---- the detail -----------------------------------------------------------------------------------------------------------------------------
function Detail({ id, onBack, onChanged, headingRef, showBack }) {
  const [detail, setDetail] = useState(null);
  const [error, setError] = useState(null);
  const [result, setResult] = useState(null);
  const [problem, setProblem] = useState(null);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    try {
      setDetail(await api.get(`/access-requests/${encodeURIComponent(id)}`));
      setError(null);
    } catch (err) {
      setError(describeError(err));
    }
  }, [id]);
  useEffect(() => { setDetail(null); setError(null); setResult(null); setProblem(null); load(); }, [id, load]);

  const done = (line) => { setResult(line); load(); onChanged(); };
  if (error) return <div className="hfy-requests__detail"><Problem problem={error} /></div>;
  if (!detail) return <div className="hfy-requests__detail"><div className="hfy-requests__skeleton" role="status" aria-label="loading" /></div>;

  const name = requesterName(detail.form) || "this person";
  const born = bornLine(detail.form);
  const answers = answersOf(detail.form);
  const waiting = detail.state === "pending" || detail.state === "awaiting_record";
  const linkedId = typeof detail.decision?.grampsId === "string" ? detail.decision.grampsId : null;
  return (
    <div className="hfy-requests__detail" data-hfy-detail={detail.id}>
      {showBack && <button type="button" className="hfy-requests__back" onClick={onBack} data-hfy-back>back to the list</button>}
      <article className="hfy-requests__card" aria-labelledby={`hfy-req-${detail.id}`}>
        <header className="hfy-requests__cardhead">
          <h2 className="hfy-requests__h3" id={`hfy-req-${detail.id}`} tabIndex={-1} ref={headingRef}>{name}</h2>
          <p className="hfy-requests__meta">{[stateWords(detail.state), born, askedAgo(detail.createdAt)].filter(Boolean).join(" · ")}</p>
        </header>
        {result && <p className="hfy-requests__ok" role="status" data-hfy-result>{result}</p>}
        <dl className="hfy-requests__answers" data-hfy-answers>
          <div><dt>{COPY.emailHidden}</dt><dd data-hfy-email>{detail.email}</dd></div>
          {answers.map((a) => <div key={a.key}><dt>{a.label}</dt><dd>{a.value}</dd></div>)}
        </dl>
        {detail.state === "active" && linkedId && <p className="hfy-requests__note" data-hfy-linked>let in as <PersonName id={linkedId} name={linkedId} />.</p>}
        {detail.state === "awaiting_record" && <p className="hfy-requests__note">approved. waiting for their page in the tree. when it's there, find them below and press it's them.</p>}
        {detail.hold && <p className="hfy-requests__note">a second email is on hold until {String(detail.hold.until).slice(0, 10)}.</p>}
        {waiting && <Actions detail={detail} name={name} onDone={done} onProblem={setProblem} problem={problem} busy={busy} setBusy={setBusy} />}
        {detail.state === "active" && <Revoke detail={detail} name={name} onDone={done} onProblem={setProblem} problem={problem} busy={busy} setBusy={setBusy} />}
      </article>
    </div>
  );
}

// ---- the list --------------------------------------------------------------------------------------------------------------------------------
function useList(state, refreshKey) {
  const [s, setS] = useState({ items: [], cursor: null, loading: true, error: null });
  useEffect(() => {
    let live = true;
    setS({ items: [], cursor: null, loading: true, error: null });
    api.get("/access-requests", { query: { state, limit: 50 } }).then(
      (r) => { if (live) setS({ items: Array.isArray(r?.items) ? r.items : [], cursor: r?.cursor || null, loading: false, error: null }); },
      (err) => { if (live) setS({ items: [], cursor: null, loading: false, error: describeError(err) }); },
    );
    return () => { live = false; };
  }, [state, refreshKey]);
  const more = async () => {
    if (!s.cursor) return;
    try {
      const r = await api.get("/access-requests", { query: { state, limit: 50, cursor: s.cursor } });
      setS((cur) => ({ ...cur, items: [...cur.items, ...(Array.isArray(r?.items) ? r.items : [])], cursor: r?.cursor || null }));
    } catch (err) {
      setS((cur) => ({ ...cur, error: describeError(err) }));
    }
  };
  return [s, more];
}

function Queue() {
  const initial = useMemo(() => parseLocation(location.search), []);
  const [tab, setTab] = useState(initial.tab);
  const [selectedId, setSelectedId] = useState(initial.id);
  const [refreshKey, setRefreshKey] = useState(0);
  const isWide = useWide();
  const headingRef = useRef(null);
  const moved = useRef(false);
  const [list, more] = useList(tabById(tab).state, refreshKey);

  useEffect(() => {
    const on = () => { const l = parseLocation(location.search); setTab(l.tab); setSelectedId(l.id); };
    window.addEventListener("popstate", on);
    return () => window.removeEventListener("popstate", on);
  }, []);
  const go = (next, push) => {
    try { (push ? history.pushState : history.replaceState).call(history, push && next.id ? { hfyRequests: true } : null, "", `${location.pathname}${locationFor(next)}`); } catch { /* the page still works without the address */ }
  };
  const pickTab = (t) => { setTab(t); setSelectedId(null); go({ tab: t }, false); };
  const open = (id) => { setSelectedId(id); go({ tab, id }, true); };
  const close = () => { if (history.state && history.state.hfyRequests) { history.back(); return; } setSelectedId(null); go({ tab }, false); };

  // Focus follows the view change on a phone: the detail's heading when one opens.
  useEffect(() => {
    if (!moved.current) { moved.current = true; return; }
    if (!isWide && selectedId && headingRef.current) headingRef.current.focus();
  }, [selectedId, isWide, list.loading]);

  const showList = isWide || !selectedId;
  const showDetail = isWide || Boolean(selectedId);
  if (list.error && list.error.kind !== "reload" && list.error.text === COPY.notAdmin) return <p className="hfy-requests__note" data-hfy-not-admin>{COPY.notAdmin}</p>;
  return (
    <div className="hfy-requests" data-hfy-requests-ready data-tab={tab} data-selected={selectedId ? "true" : undefined}>
      <nav className="hfy-requests__tabs" aria-label="family requests">
        {TABS.map((t) => (
          <a key={t.id} href={`?tab=${t.id}`} className="hfy-requests__tab" aria-current={t.id === tab ? "page" : undefined} data-hfy-tab={t.id}
            onClick={(e) => { e.preventDefault(); pickTab(t.id); }}>{t.label}</a>
        ))}
      </nav>
      <div className="hfy-requests__split">
        {showList && (
          <section className="hfy-requests__list" aria-label={tabById(tab).label} aria-busy={list.loading}>
            {list.loading && <div className="hfy-requests__skeleton" role="status" aria-label="loading" />}
            {!list.loading && list.error && <Problem problem={list.error} />}
            {!list.loading && !list.error && !list.items.length && <p className="hfy-requests__note" data-hfy-empty>{COPY.empty[tab]}</p>}
            {list.items.length > 0 && (
              <ul className="hfy-requests__items" data-hfy-items>
                {list.items.map((it) => <Row key={it.id} item={it} selected={it.id === selectedId} onOpen={open} />)}
              </ul>
            )}
            {list.cursor && <button type="button" className="hfy-requests__btn" onClick={more} data-hfy-more>show more</button>}
          </section>
        )}
        {showDetail && (selectedId
          ? <Detail id={selectedId} onBack={close} onChanged={() => setRefreshKey((k) => k + 1)} headingRef={headingRef} showBack={!isWide} />
          : <p className="hfy-requests__note hfy-requests__pick">pick a request to read it.</p>)}
      </div>
    </div>
  );
}

function Requests() {
  const session = useEdgeSession();
  const [me, setMe] = useState(undefined);
  const signedIn = session !== undefined && memberSub(session) !== null;
  useEffect(() => {
    if (!signedIn) return undefined;
    let live = true;
    getMe().then((m) => { if (live) setMe(m); });
    return () => { live = false; };
  }, [signedIn]);
  const pending = session === undefined || (signedIn && me === undefined);
  if (pending) return <section className="hfy-requests__wrap" aria-busy="true"><div className="hfy-requests__skeleton" role="status" aria-label="loading" /></section>;
  if (!signedIn) {
    return (
      <section className="hfy-requests__wrap">
        <div className="hfy-requests__gate" role="status" data-hfy-gate>
          <p>{COPY.signedOut}</p>
          <a className="hfy-requests__signin" href={signInHref(false)}>sign in</a>
        </div>
      </section>
    );
  }
  if (me.admin !== true) return <section className="hfy-requests__wrap"><p className="hfy-requests__note" data-hfy-not-admin>{COPY.notAdmin}</p></section>;
  return <section className="hfy-requests__wrap"><Queue /></section>;
}

const off = document.querySelector("[data-requests-off]");
if (off) off.remove();
mountIsland("access-requests", Requests);
