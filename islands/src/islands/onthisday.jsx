// On this day: the homepage module (HFY-TSK-218, flag onThisDay; HFY-PLN-002 surfaces 4.5). For a signed-in member, one card after
// section.home-hero with the day's family history (the day, week or year tier), the remembering group last, a past-year post, or a
// prompt. Signed out, on a 503 or any failure it renders nothing: no error banner on the public homepage. Everything the API serves
// is a member-editable string, so it is only ever placed as a React text child (a text node), never as HTML.
import "../posts.css";
import "./onthisday.css";
import { useEffect, useState } from "react";
import { api, edgeSignedOut } from "../lib/api.js";
import { getMe } from "../lib/me.js";
import { memberSub, useEdgeSession } from "../lib/edge-session.js";
import { mountAt } from "../lib/mount.jsx";
import { useFlags } from "../lib/use-flags.js";
import { PersonName } from "../lib/person-name.jsx";
import { FOOTER_LINK, HIDE_LABEL, HIDE_NO, HIDE_QUESTION, HIDE_YES, REMEMBERING_LABEL, agoLine, canHide, promptParts, queryFor, viewOf } from "../lib/onthisday-model.js";

const GLYPHS = {
  marriage: <circle cx="12" cy="12" r="7" />,
  graduation: <path d="M2 9l10-5 10 5-10 5zM6 11.5V16c0 1.5 3 3 6 3s6-1.5 6-3v-4.5" />,
  degree: <path d="M2 9l10-5 10 5-10 5zM6 11.5V16c0 1.5 3 3 6 3s6-1.5 6-3v-4.5" />,
  education: <path d="M2 9l10-5 10 5-10 5zM6 11.5V16c0 1.5 3 3 6 3s6-1.5 6-3v-4.5" />,
  residence: <path d="M3 11l9-7 9 7M5 10v9h14v-9" />,
  birth: <circle cx="12" cy="12" r="4" />,
  death: <path d="M12 21c-5 0-8-4-8-9 4 0 8 1 8 9zm0 0c5 0 8-4 8-9-4 0-8 1-8 9z" />,
  burial: <path d="M12 21c-5 0-8-4-8-9 4 0 8 1 8 9zm0 0c5 0 8-4 8-9-4 0-8 1-8 9z" />
};

function Glyph({ kind }) {
  return (
    <svg className="hfy-otd__glyph" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" focusable="false">
      {GLYPHS[kind] ?? GLYPHS.birth}
    </svg>
  );
}

/** Parts as text nodes: a person run is a PersonName (a link with an id), a text run is plain text. */
function Parts({ parts }) {
  return parts.map((p, i) => (p.name !== undefined ? <PersonName key={i} id={p.grampsId} name={p.name} className="hfy-otd__name" /> : <span key={i}>{p.text}</span>));
}

function Row({ row, hideable, onHidden }) {
  const [asking, setAsking] = useState(false);
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState(false);
  const hide = async () => {
    setBusy(true);
    setFailed(false);
    try {
      await api.post("/onthisday/hide", { itemId: row.id });
      onHidden(row.id);
    } catch {
      setBusy(false);
      setFailed(true);
    }
  };
  return (
    <li className="hfy-otd__row" data-tone={row.tone} data-kind={row.kind} data-hfy-otd-row>
      <Glyph kind={row.kind} />
      <div className="hfy-otd__body">
        <p className="hfy-otd__line"><Parts parts={row.parts} /></p>
        <p className="hfy-otd__ago">{agoLine(row)}</p>
        {asking ? (
          <div className="hfy-otd__confirm" role="group" aria-label={HIDE_QUESTION}>
            <span className="hfy-otd__ask">{failed ? "that didn't work. try again?" : HIDE_QUESTION}</span>
            <button type="button" className="hfy-otd__btn" disabled={busy} onClick={hide}>{HIDE_YES}</button>
            <button type="button" className="hfy-otd__btn" disabled={busy} onClick={() => { setAsking(false); setFailed(false); }}>{HIDE_NO}</button>
          </div>
        ) : null}
      </div>
      {hideable && !asking ? (
        <button type="button" className="hfy-otd__more" aria-label={HIDE_LABEL} title={HIDE_LABEL} onClick={() => setAsking(true)}>
          <svg viewBox="0 0 24 24" width="24" height="24" fill="currentColor" aria-hidden="true" focusable="false"><circle cx="5" cy="12" r="1.75" /><circle cx="12" cy="12" r="1.75" /><circle cx="19" cy="12" r="1.75" /></svg>
        </button>
      ) : null}
    </li>
  );
}

function Archive({ post }) {
  return (
    <div className="hfy-otd__archive" data-hfy-otd-archive>
      {post.photo ? <img className="hfy-otd__thumb" src={post.photo.url} alt={post.photo.alt} loading="lazy" /> : null}
      <div className="hfy-otd__body">
        <p className="hfy-otd__line"><Parts parts={post.parts} /></p>
        {post.excerpt ? <p className="hfy-otd__excerpt">{post.excerpt}</p> : null}
        <a className="hfy-otd__open" href={`/posts/?id=${encodeURIComponent(post.id)}`}>open the post</a>
      </div>
    </div>
  );
}

function Prompt({ prompt, flags }) {
  const { variant, parts } = promptParts(prompt, flags);
  return (
    <p className="hfy-otd__prompt" data-hfy-otd-prompt={variant}>
      <Parts parts={parts} />
    </p>
  );
}

function Card({ view, flags, viewer }) {
  const [hidden, setHidden] = useState(() => new Set());
  const keep = (r) => !hidden.has(r.id);
  const rows = view.rows.filter(keep);
  const remembering = view.remembering.filter(keep);
  const onHidden = (id) => setHidden((s) => new Set(s).add(id));
  const showPrompt = view.prompt && (rows.length + remembering.length < 2) && !view.post;
  if (!rows.length && !remembering.length && !view.post && !showPrompt) return null;
  const renderRows = (list) => list.map((r) => <Row key={r.id} row={r} hideable={canHide(r, viewer)} onHidden={onHidden} />);
  return (
    <section className="hfy-otd" aria-labelledby="hfy-otd-h" data-hfy-onthisday data-tier={view.tier}>
      <div className="container hfy-otd__inner">
        <div className="hfy-otd__head">
          <h2 className="hfy-h hfy-otd__h" id="hfy-otd-h">{view.heading}</h2>
          {view.dateText ? <p className="hfy-otd__date">{view.dateText}</p> : null}
        </div>
        {rows.length ? <ul className="hfy-otd__rows">{renderRows(rows)}</ul> : null}
        {remembering.length ? (
          <div className="hfy-otd__remembering" data-hfy-otd-remembering>
            <h3 className="hfy-otd__label">{REMEMBERING_LABEL}</h3>
            <ul className="hfy-otd__rows">{renderRows(remembering)}</ul>
          </div>
        ) : null}
        {view.post ? <Archive post={view.post} /> : null}
        {showPrompt ? <Prompt prompt={view.prompt} flags={flags} /> : null}
        <a className="hfy-otd__footer" href={FOOTER_LINK.href}>{FOOTER_LINK.text}</a>
      </div>
    </section>
  );
}

/** undefined while loading, null when there is nothing to show (signed out, 503, any failure), else the view. */
function useOnThisDay(enabled) {
  const [state, setState] = useState(undefined);
  useEffect(() => {
    if (!enabled) return undefined;
    let live = true;
    (async () => {
      try {
        if (await edgeSignedOut()) throw new Error("signed out");
        const [body, me] = await Promise.all([api.get("/onthisday", { query: queryFor() }), getMe()]);
        if (live) setState({ view: viewOf(body), admin: me.admin === true });
      } catch {
        if (live) setState({ view: null, admin: false });
      }
    })();
    return () => { live = false; };
  }, [enabled]);
  return state;
}

export function OnThisDay() {
  const session = useEdgeSession();
  const sub = memberSub(session);
  const flags = useFlags();
  const state = useOnThisDay(Boolean(sub));
  if (!sub) return null;
  if (state === undefined) {
    return (
      <section className="hfy-otd" aria-busy="true" aria-label="on this day" data-hfy-onthisday-loading>
        <div className="container hfy-otd__inner"><div className="hfy-otd__skeleton" /></div>
      </section>
    );
  }
  if (!state.view) return null;
  return <Card view={state.view} flags={flags ?? {}} viewer={{ admin: state.admin, sub }} />;
}

const run = () => {
  const hero = document.querySelector("section.home-hero");
  if (!hero) return;
  mountAt((h) => hero.insertAdjacentElement("afterend", h), <OnThisDay />, "hfy-onthisday");
};
if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", run, { once: true }); else run();
