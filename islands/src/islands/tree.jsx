// /tree/: the family tree page island (HFY-TSK-201, flag familyViz; design viz.md sections 7, 8, 9.4 and 17).
// This task owns the shell of the page: fetching the gated graph with the session-continuity rules (HFY-R66), the page states, the focus
// (?focus, else the viewer, else the default person) kept in sync with the history, and a plain focus card with the person's close
// relatives as re-centring buttons. The generation outline and focus navigator (viz-outline-navigator) replace <FocusStage> and the
// chart (viz-mvp-visual) is a lazy chunk beside it; both read the same graph and call the same `onFocus`.
//
//   GET /person/graph.json  200 render | 401 (after the refresh retry) sign in, back here | 403/404 "being prepared" | bad body: retry
import "./tree.css";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { mountIsland } from "../lib/mount.jsx";
import { memberSub, useEdgeSession } from "../lib/edge-session.js";
import { announce, focusParam, focusUrl, loadGraph, resolveFocus, signInHref, yearsLabel } from "../lib/tree-data.js";
import { relationLabel } from "../lib/family-graph.js";

export const COPY = {
  prepared: "the family tree is being prepared. you can find anyone through search.",
  error: "the family tree didn't load. try again.",
  signedOut: "sign in to see the family tree.",
  offline: "the family tree needs a connection.",
  notFound: "we couldn't find that person, so here is someone to start from."
};

/** The graph fetch: the page's session-aware dataFetch when feature-flags.js is there (refresh once on a 401, then sign in with returnTo). */
const fetcher = (url, init) => (window.HFYFeatureFlags?.dataFetch ? window.HFYFeatureFlags.dataFetch(url, init) : fetch(url, init));

function State({ children, action }) {
  return (
    <div className="hfy-tree__state" role="status" data-tree-state>
      <p>{children}</p>
      {action}
    </div>
  );
}

function Group({ title, people, onFocus }) {
  if (!people.length) return null;
  return (
    <section className="hfy-tree__group" aria-label={title}>
      <h3>{title}</h3>
      <ul>
        {people.map(({ id, name }) => (
          <li key={id}><button type="button" className="hfy-tree__person" data-person={id} onClick={() => onFocus(id)}>{name}</button></li>
        ))}
      </ul>
    </section>
  );
}

/** The focus card and the close relatives. The seam the outline and navigator task replaces. */
export function FocusStage({ graph, focus, viewer, onFocus }) {
  const p = graph.person(focus);
  const heading = useRef(null);
  const first = useRef(true);
  // Focus moves to the new card's heading after a re-centre (never on the first paint: that would scroll the page on load).
  useEffect(() => {
    if (first.current) { first.current = false; return; }
    heading.current?.focus();
  }, [focus]);
  const name = (id) => ({ id, name: graph.person(id).name });
  const rel = viewer ? relationLabel(graph, viewer, focus) : null;
  const groups = useMemo(() => ({
    parents: graph.parents(focus).map((x) => name(x.id)),
    partners: graph.partners(focus).map((x) => name(x.id)),
    children: graph.children(focus).map((x) => name(x.id)),
    siblings: graph.siblings(focus).map((x) => name(x.id))
  }), [graph, focus]);
  if (!p) return null;
  return (
    <section className="hfy-tree__focus" aria-labelledby="hfy-tree-focus-name" data-tree-focus={focus}>
      <h2 id="hfy-tree-focus-name" tabIndex={-1} ref={heading}>{p.name}</h2>
      <p className="hfy-tree__dim">{yearsLabel(p)}{rel && rel !== "you" ? ` · your ${rel}` : ""}{rel === "you" ? " · you" : ""}</p>
      <p><a className="hfy-tree__link" href={`/person/?id=${encodeURIComponent(focus)}`}>view page</a></p>
      <Group title="parents" people={groups.parents} onFocus={onFocus} />
      <Group title="partners" people={groups.partners} onFocus={onFocus} />
      <Group title="children" people={groups.children} onFocus={onFocus} />
      <Group title="brothers and sisters" people={groups.siblings} onFocus={onFocus} />
    </section>
  );
}

export function TreeApp() {
  const session = useEdgeSession();
  const sub = memberSub(session);
  const [result, setResult] = useState(null); // null while loading, else loadGraph's answer
  const [attempt, setAttempt] = useState(0);
  const [focus, setFocus] = useState(() => focusParam(location.search));
  const [online, setOnline] = useState(() => navigator.onLine !== false);

  useEffect(() => {
    const on = () => setOnline(true);
    const off = () => setOnline(false);
    addEventListener("online", on);
    addEventListener("offline", off);
    return () => { removeEventListener("online", on); removeEventListener("offline", off); };
  }, []);

  useEffect(() => {
    if (!online) return undefined;
    const ctl = new AbortController();
    setResult(null);
    loadGraph(fetcher, { signal: ctl.signal }).then((r) => { if (!ctl.signal.aborted) setResult(r); });
    return () => ctl.abort();
  }, [attempt, online]);

  // Back and forward restore the previous focus (the page pushes one history entry per re-centre).
  useEffect(() => {
    const onPop = () => setFocus(focusParam(location.search));
    addEventListener("popstate", onPop);
    return () => removeEventListener("popstate", onPop);
  }, []);

  const graph = result?.state === "ready" ? result.graph : null;
  // The session probe resolves after the graph on some loads; hold the first paint until it has, so the viewer's own page is not flashed
  // as the default person. (A null session, authV2 off or unreachable, is "settled": undefined is the only pending value.)
  const resolved = useMemo(() => (graph && session !== undefined ? resolveFocus(graph, { focus, sub }) : null), [graph, session, focus, sub]);
  const onFocus = useCallback((id) => {
    history.pushState(null, "", focusUrl(location, id));
    setFocus(id);
  }, []);
  // A bad ?focus is replaced in the address bar by the person actually shown, so a share link or a reload agrees with the page.
  useEffect(() => {
    if (resolved && resolved.id && resolved.id !== focusParam(location.search)) history.replaceState(null, "", focusUrl(location, resolved.id));
  }, [resolved]);
  const [spoken, setSpoken] = useState("");
  useEffect(() => { if (graph && resolved?.id) setSpoken(announce(graph, resolved.id)); }, [graph, resolved?.id]);

  if (!online) return <div className="hfy-tree"><State>{COPY.offline}</State></div>;
  if (result === null) return <div className="hfy-tree" aria-busy="true"><div className="hfy-tree__skeleton" data-tree-loading /></div>;
  if (result.state === "signin") {
    return <div className="hfy-tree"><State action={<a className="hfy-tree__action" href={signInHref(location)}>sign in</a>}>{COPY.signedOut}</State></div>;
  }
  if (result.state === "prepared") return <div className="hfy-tree"><State>{COPY.prepared}</State></div>;
  if (result.state === "error") {
    console.error(`HFY tree: ${result.code}`);
    return <div className="hfy-tree"><State action={<button type="button" className="hfy-tree__action" onClick={() => setAttempt((n) => n + 1)}>try again</button>}>{COPY.error}</State></div>;
  }
  if (!resolved) return <div className="hfy-tree" aria-busy="true"><div className="hfy-tree__skeleton" data-tree-loading /></div>;
  if (!resolved.id) return <div className="hfy-tree"><State>{COPY.prepared}</State></div>;
  return (
    <div className="hfy-tree">
      {resolved.fellBack ? <p className="hfy-tree__notice" role="status" data-tree-notice>{COPY.notFound}</p> : null}
      <FocusStage graph={graph} focus={resolved.id} viewer={sub} onFocus={onFocus} />
      <p className="hfy-tree__live" role="status" aria-live="polite" data-tree-live>{spoken}</p>
    </div>
  );
}

mountIsland("tree", TreeApp);
