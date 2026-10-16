// /admin/sync/: the admin-sync island (HFY-TSK-279, sync-admin-status-page; flag syncStatusV1; sync.md 13.3, BRD2 11.1 7.1, reviews PS-22 and SI-30).
// Four cards for the people who look after the site: the desktop (last run, versions), the website (head and rendered seq, the lag, the last render
// error), the conflicts (each with the website's value beside the desktop's and "keep website" / "keep desktop") and the recent batches. Under 64rem the
// cards stack in one column with full-width 44px buttons and wrapping values; from 64rem it is two columns, the cards on the left and the conflicts on
// the right. Reading is for an hfy-admin or the gramps-owner; deciding is for the gramps-owner with a sign-in at most 300 s old: the server answers
// 401 step_up_required and this page answers with a fresh sign-in link. Anyone else sees the standard not-allowed line. feature-flags.js loads this
// bundle only with syncStatusV1 on, so with the flag off nothing here is requested and the static page keeps its "not available yet" line (HFY-R8).
import "./admin-sync.css";
import { useCallback, useEffect, useState } from "react";
import { api } from "../lib/api.js";
import { memberSub, useEdgeSession } from "../lib/edge-session.js";
import { mountIsland } from "../lib/mount.jsx";
import {
  COPY, ago, confirmAsk, conflictRows, countsLine, decidedLine, decisionBody, describeError, lagLine, normalizeStatus, recordLabel, stamp,
} from "../lib/sync-admin-model.js";

/** The sign-in link: a fresh one (prompt=login) for a step-up, back to this page. */
export const signInHref = (fresh) => `/auth/login?${fresh ? "prompt=login&" : ""}returnTo=${encodeURIComponent(`${location.pathname}${location.search}`)}`;

function Problem({ problem }) {
  if (!problem) return null;
  return (
    <div className="hfy-syncadmin__problem" role="alert" data-hfy-problem={problem.kind}>
      <p>{problem.text}</p>
      {problem.kind === "signin" && <a className="hfy-syncadmin__signin" href={signInHref(problem.fresh)}>sign in again</a>}
    </div>
  );
}

function Card({ title, id, children }) {
  return (
    <section className="hfy-syncadmin__card" aria-labelledby={id} data-hfy-card={id.replace("hfy-sync-", "")}>
      <h2 className="hfy-syncadmin__h2" id={id}>{title}</h2>
      {children}
    </section>
  );
}

const Fact = ({ k, v, name }) => <div><dt>{k}</dt><dd data-hfy-fact={name}>{v}</dd></div>;

function Desktop({ desktop }) {
  if (!desktop.length) return <p className="hfy-syncadmin__note" data-hfy-empty="desktop">{COPY.noDesktop}</p>;
  return desktop.map((d) => (
    <dl className="hfy-syncadmin__facts" key={d.id} data-hfy-desktop>
      <Fact k="last run" v={d.run ? `${d.run.action ?? "sync"}, ${d.run.result ?? "unknown"}` : "none yet"} name="run" />
      <Fact k="finished" v={d.run?.at ? `${ago(d.run.at)} (${stamp(d.run.at)})` : "unknown"} name="finished" />
      <Fact k="counts" v={countsLine(d.run?.counts)} name="counts" />
      <Fact k="add-on" v={d.addon ?? "unknown"} name="addon" />
      <Fact k="gramps" v={d.gramps ?? "unknown"} name="gramps" />
    </dl>
  ));
}

function Website({ website: w }) {
  return (
    <>
      <dl className="hfy-syncadmin__facts" data-hfy-website>
        <Fact k="newest change" v={String(w.headSeq)} name="head" />
        <Fact k="on the site" v={String(w.renderedSeq)} name="rendered" />
        <Fact k="lag" v={lagLine(w.lag)} name="lag" />
        <Fact k="render mode" v={w.mode ?? "unknown"} name="mode" />
        <Fact k="saving" v={w.paused ? "paused" : "on"} name="writes" />
      </dl>
      {w.error ? <p className="hfy-syncadmin__bad" data-hfy-render-error>last render error: {w.error}{w.errorAt ? ` (${stamp(w.errorAt)})` : ""}</p> : <p className="hfy-syncadmin__note">no render error.</p>}
    </>
  );
}

function Batches({ batches }) {
  if (!batches.length) return <p className="hfy-syncadmin__note" data-hfy-empty="batches">{COPY.noBatches}</p>;
  return (
    <ul className="hfy-syncadmin__list" data-hfy-batches>
      {batches.map((b) => (
        <li key={b.id} className="hfy-syncadmin__row" data-hfy-batch={b.id}>
          <span className="hfy-syncadmin__strong">{b.ops} {b.ops === 1 ? "change" : "changes"}{b.origin ? ` from the ${b.origin}` : ""}</span>
          <span className="hfy-syncadmin__meta">{ago(b.at)} ({stamp(b.at)}){b.by ? `, by ${b.by}` : ""}{b.from !== null && b.to !== null ? `, seq ${b.from} to ${b.to}` : ""}</span>
        </li>
      ))}
    </ul>
  );
}

function ConflictItem({ conflict, owner, busy, onDecide }) {
  const [choice, setChoice] = useState(null);
  const rows = conflictRows(conflict);
  return (
    <li className="hfy-syncadmin__conflict" data-hfy-conflict={conflict.id}>
      <p className="hfy-syncadmin__strong">{recordLabel(conflict)}</p>
      {rows.map((r, i) => (
        <div className="hfy-syncadmin__path" key={i}>
          <p className="hfy-syncadmin__field">{r.label}</p>
          <dl className="hfy-syncadmin__pair">
            <div><dt>website</dt><dd data-hfy-website-value>{r.website}</dd></div>
            <div><dt>desktop</dt><dd data-hfy-desktop-value>{r.desktop}</dd></div>
          </dl>
        </div>
      ))}
      {owner && !choice && (
        <div className="hfy-syncadmin__actions">
          <button type="button" className="hfy-syncadmin__btn" onClick={() => setChoice("keep_website")} disabled={busy} data-hfy-act="keep-website">{COPY.keepWebsite}</button>
          <button type="button" className="hfy-syncadmin__btn" onClick={() => setChoice("keep_desktop")} disabled={busy} data-hfy-act="keep-desktop">{COPY.keepDesktop}</button>
        </div>
      )}
      {owner && choice && (
        <div className="hfy-syncadmin__confirm" role="group" aria-label="confirm the decision" data-hfy-confirm>
          <p className="hfy-syncadmin__ask">{confirmAsk(conflict, choice)}</p>
          <p className="hfy-syncadmin__meta">{COPY.confirmHelp}</p>
          <div className="hfy-syncadmin__actions">
            <button type="button" className="hfy-syncadmin__btn hfy-syncadmin__btn--primary" onClick={() => onDecide(conflict.id, choice)} disabled={busy} data-hfy-act="confirm">yes, keep it</button>
            <button type="button" className="hfy-syncadmin__btn" onClick={() => setChoice(null)} disabled={busy} data-hfy-act="cancel">not yet</button>
          </div>
        </div>
      )}
      {!owner && <p className="hfy-syncadmin__meta" data-hfy-owner-only>{COPY.ownerOnly}</p>}
    </li>
  );
}

function Status() {
  const [state, setState] = useState({ loading: true, data: null, error: null });
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState(null);
  const [result, setResult] = useState(null);
  const load = useCallback(async () => {
    try {
      const body = await api.get("/sync/admin/status");
      setState({ loading: false, data: normalizeStatus(body), error: null });
    } catch (err) {
      setState({ loading: false, data: null, error: describeError(err) });
    }
  }, []);
  useEffect(() => { load(); }, [load]);

  const decide = async (id, choice) => {
    setBusy(true);
    setProblem(null);
    try {
      await api.post(`/sync/conflicts/${encodeURIComponent(id)}/decision`, decisionBody(choice));
      setResult(decidedLine(choice));
      await load();
    } catch (err) {
      setProblem(describeError(err));
      if (err?.status === 409 || err?.status === 404) load();
    } finally {
      setBusy(false);
    }
  };

  if (state.loading) return <div className="hfy-syncadmin__skeleton" role="status" aria-label="loading" aria-busy="true" />;
  if (state.error) {
    const notAllowed = state.error.text === COPY.notAllowed;
    return notAllowed ? <p className="hfy-syncadmin__note" data-hfy-not-allowed>{COPY.notAllowed}</p> : <Problem problem={state.error} />;
  }
  const s = state.data;
  return (
    <div className="hfy-syncadmin__grid" data-hfy-sync-ready>
      <div className="hfy-syncadmin__col">
        <Card title="desktop" id="hfy-sync-desktop"><Desktop desktop={s.desktop} /></Card>
        <Card title="website" id="hfy-sync-website"><Website website={s.website} /></Card>
        <Card title="recent batches" id="hfy-sync-batches"><Batches batches={s.batches} /></Card>
      </div>
      <div className="hfy-syncadmin__col">
        <Card title={`conflicts (${s.conflicts.length})`} id="hfy-sync-conflicts">
          {result && <p className="hfy-syncadmin__ok" role="status" data-hfy-result>{result}</p>}
          <Problem problem={problem} />
          {!s.conflicts.length && <p className="hfy-syncadmin__note" data-hfy-empty="conflicts">{COPY.noConflicts}</p>}
          {s.conflicts.length > 0 && (
            <ul className="hfy-syncadmin__list" data-hfy-conflicts>
              {s.conflicts.map((c) => <ConflictItem key={c.id} conflict={c} owner={s.owner} busy={busy} onDecide={decide} />)}
            </ul>
          )}
        </Card>
      </div>
    </div>
  );
}

function AdminSync() {
  const session = useEdgeSession();
  const signedIn = session !== undefined && memberSub(session) !== null;
  if (session === undefined) return <section className="hfy-syncadmin" aria-busy="true"><div className="hfy-syncadmin__skeleton" role="status" aria-label="loading" /></section>;
  if (!signedIn) {
    return (
      <section className="hfy-syncadmin">
        <div className="hfy-syncadmin__gate" role="status" data-hfy-gate>
          <p>{COPY.signedOut}</p>
          <a className="hfy-syncadmin__signin" href={signInHref(false)}>sign in</a>
        </div>
      </section>
    );
  }
  return <section className="hfy-syncadmin"><Status /></section>;
}

const off = document.querySelector("[data-sync-off]");
if (off) off.remove();
mountIsland("admin-sync", AdminSync);
