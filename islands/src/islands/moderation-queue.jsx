// /me/moderation/: the admin moderation queue (HFY-TSK-192, hfy-moderation-queue-page; flag moderationV1; R-32; social.md 11.6). Open items first:
// kind, author, when, the state and the note, then "open" (a link to the item) and "unhide". A "closed" tab lists what was resolved, paged.
// Signed out gets the sign-in line, a non-admin one line and no queue request. feature-flags.js loads this bundle only with moderationV1 on, so with
// the flag off nothing here is requested and the static page keeps its "not available yet" line (HFY-R8). Every write is re-checked on the server.
import "./moderation-queue.css";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { api } from "../lib/api.js";
import { getMe } from "../lib/me.js";
import { memberSub, useEdgeSession } from "../lib/edge-session.js";
import { mountIsland } from "../lib/mount.jsx";
import { createModerationClient, errorLine } from "../lib/moderation.js";
import { fullTime } from "../lib/time.js";
import {
  COPY, TABS, appendPage, authorLabel, canUnhide, kindWord, listQuery, locationFor, parseTab, readPage, rowKey, safeHref, stateWords, tabById, unhideLabel, whenOf, withoutRow,
} from "../lib/moderation-queue-model.js";

export const signInHref = () => `/auth/login?returnTo=${encodeURIComponent(`${location.pathname}${location.search}`)}`;
const client = createModerationClient(api);

function Row({ row, busy, onUnhide }) {
  const href = safeHref(row.href);
  return (
    <li className="hfy-modq__item" data-hfy-modq-item={row.target.kind} data-hidden={row.hidden ? "true" : undefined}>
      <div className="hfy-modq__head">
        <span className="hfy-modq__kind">{kindWord(row.target)}</span>
        <span className="hfy-modq__author">{authorLabel(row)}</span>
        <time className="hfy-modq__when" dateTime={row.open === false ? row.resolved_at ?? row.at : row.at} title={fullTime(row.open === false ? row.resolved_at ?? row.at : row.at)}>{whenOf(row)}</time>
        <span className="hfy-modq__state" data-hfy-modq-state>{stateWords(row)}</span>
      </div>
      {typeof row.note === "string" && row.note !== "" && <p className="hfy-modq__note">{row.note}</p>}
      {row.by?.label && <p className="hfy-modq__by">{COPY.by} {row.by.label}</p>}
      {(href || canUnhide(row)) && (
        <div className="hfy-modq__actions">
          {href && <a className="hfy-modq__btn" href={href} data-hfy-act="open" aria-label={`${COPY.open}: ${kindWord(row.target)} by ${authorLabel(row)}`}>{COPY.open}</a>}
          {canUnhide(row) && (
            <button type="button" className="hfy-modq__btn" onClick={() => onUnhide(row)} disabled={busy} data-hfy-act="unhide" aria-label={`${unhideLabel(row)}: ${kindWord(row.target)} by ${authorLabel(row)}`}>{unhideLabel(row)}</button>
          )}
        </div>
      )}
    </li>
  );
}

function Queue() {
  const [tab, setTab] = useState(() => parseTab(location.search));
  const [rows, setRows] = useState([]);
  const [cursor, setCursor] = useState(null);
  const [loading, setLoading] = useState(true);
  const [problem, setProblem] = useState(null);
  const [notice, setNotice] = useState("");
  const [busy, setBusy] = useState(false);
  const [notAdmin, setNotAdmin] = useState(false);
  const live = useRef(0);

  const load = useCallback(async (which, after) => {
    const ticket = ++live.current;
    if (!after) { setLoading(true); setProblem(null); setRows([]); setCursor(null); }
    try {
      const page = readPage(await api.get("/moderation", { query: listQuery(which, after) }));
      if (ticket !== live.current) return;
      setRows((cur) => (after ? appendPage(cur, page) : page.items));
      setCursor(page.cursor);
    } catch (e) {
      if (ticket !== live.current) return;
      if (e?.status === 403) { setNotAdmin(true); return; }
      setProblem(await errorLine(e));
    } finally {
      if (ticket === live.current) setLoading(false);
    }
  }, []);
  useEffect(() => { load(tab); }, [tab, load]);
  useEffect(() => {
    const on = () => setTab(parseTab(location.search));
    window.addEventListener("popstate", on);
    return () => window.removeEventListener("popstate", on);
  }, []);

  const pick = (id) => {
    setTab(id); setNotice("");
    try { history.replaceState(null, "", `${location.pathname}${locationFor(id)}`); } catch { /* the page works without the address */ }
  };
  const unhide = async (row) => {
    setBusy(true); setNotice(""); setProblem(null);
    try {
      await client.act(row.target, { action: "unhide" });
      setRows((cur) => withoutRow(cur, row));
      setNotice("unhidden.");
    } catch (e) {
      setProblem(await errorLine(e));
    } finally {
      setBusy(false);
    }
  };

  if (notAdmin) return <p className="hfy-modq__msg" data-hfy-not-admin>{COPY.notAdmin}</p>;
  const label = tabById(tab).label;
  return (
    <div className="hfy-modq" data-hfy-modq-ready data-tab={tab}>
      <nav className="hfy-modq__tabs" aria-label="moderation">
        {TABS.map((t) => (
          <a key={t.id} href={`?tab=${t.id}`} className="hfy-modq__tab" aria-current={t.id === tab ? "page" : undefined} data-hfy-tab={t.id}
            onClick={(e) => { e.preventDefault(); pick(t.id); }}>{t.label}</a>
        ))}
      </nav>
      <p className="hfy-modq__status" role="status" data-hfy-notice>{notice}</p>
      {problem && <p className="hfy-modq__problem" role="alert" data-hfy-problem>{problem}</p>}
      <section aria-label={label} aria-busy={loading}>
        {loading && <div className="hfy-modq__skeleton" role="status" aria-label={COPY.loading} />}
        {!loading && !problem && rows.length === 0 && <p className="hfy-modq__msg" data-hfy-empty>{COPY.empty[tab]}</p>}
        {rows.length > 0 && <ul className="hfy-modq__items" data-hfy-items>{rows.map((r) => <Row key={rowKey(r)} row={r} busy={busy} onUnhide={unhide} />)}</ul>}
        {cursor && !loading && <button type="button" className="hfy-modq__btn" onClick={() => load(tab, cursor)} data-hfy-more>{COPY.more}</button>}
      </section>
    </div>
  );
}

function ModerationPage() {
  const session = useEdgeSession();
  const [me, setMe] = useState(undefined);
  const signedIn = session !== undefined && memberSub(session) !== null;
  useEffect(() => {
    if (!signedIn) return undefined;
    let on = true;
    getMe().then((m) => { if (on) setMe(m); });
    return () => { on = false; };
  }, [signedIn]);
  const pending = session === undefined || (signedIn && me === undefined);
  const wrap = useMemo(() => "hfy-modq__wrap", []);
  if (pending) return <section className={wrap} aria-busy="true"><div className="hfy-modq__skeleton" role="status" aria-label={COPY.loading} /></section>;
  if (!signedIn) {
    return (
      <section className={wrap}>
        <div className="hfy-modq__gate" role="status" data-hfy-gate><p>{COPY.signedOut}</p><a className="hfy-modq__btn" href={signInHref()}>{COPY.signIn}</a></div>
      </section>
    );
  }
  if (me.admin !== true) return <section className={wrap}><p className="hfy-modq__msg" data-hfy-not-admin>{COPY.notAdmin}</p></section>;
  return <section className={wrap}><Queue /></section>;
}

const off = document.querySelector("[data-moderation-off]");
if (off) off.remove();
mountIsland("moderation-queue", ModerationPage);
