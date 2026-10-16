// /tree/: the family tree page island (HFY-TSK-201, flag familyViz; design viz.md sections 7, 8, 9.4 and 17).
// This task owns the shell of the page: fetching the gated graph with the session-continuity rules (HFY-R66), the page states, the focus
// (?focus, else the viewer, else the default person) kept in sync with the history, and a plain focus card with the person's close
// relatives as re-centring buttons. HFY-TSK-202 (viz-outline-navigator) made that card the FocusNavigator and added the GenerationOutline
// beside it; both always render, are plain semantic HTML and call the same `onFocus`. The chart (HFY-TSK-145, viz-mvp-visual: the
// framework-free <family-navigator> cards view) is a lazy chunk beside them and reads the same graph. HFY-TSK-301 (viz-mvp-visual-fallback)
// adds the cards | outline toggle (?view=, localStorage "hfy:tree-view"; lib/tree-view.js) and the outline-only mode that a chart chunk that
// will not load falls back to (CHART_CHUNK_FAILED).
//
//   GET /person/graph.json  200 render | 401 (after the refresh retry) sign in, back here | 403/404 "being prepared" | bad body: retry
import "./tree.css";
import { Component, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { mountIsland } from "../lib/mount.jsx";
import { memberSub, useEdgeSession } from "../lib/edge-session.js";
import { resolveMerged } from "../lib/merged-person.js";
import { announce, focusParam, focusUrl, loadGraph, resolveFocus, signInHref, yearsLabel } from "../lib/tree-data.js";
import { isRelationWord, relationLabel } from "../lib/family-graph.js";
import { LEVEL_PAGE, focusGroups, outlineModel, placeName } from "../lib/tree-outline.js";
import { initialView, viewParam, viewUrl, writeStoredView } from "../lib/tree-view.js";

export const COPY = {
  prepared: "the family tree is being prepared. you can find anyone through search.",
  error: "the family tree didn't load. try again.",
  signedOut: "sign in to see the family tree.",
  offline: "the family tree needs a connection.",
  notFound: "we couldn't find that person, so here is someone to start from.",
  chartFailed: "the chart didn't load. the outline below has everything."
};

// The cards view is its own chunk (lib/tree-chart.jsx). If the chunk fails to load, or the browser refuses the custom element (the chunk
// defines it as it evaluates, so the import rejects), the page drops to outline-only mode: TreeApp says so in COPY.chartFailed and keeps the
// focus navigator and the outline, which hold the same information (CHART_CHUNK_FAILED, viz.md section 17).
//
// The import is started as soon as the page wants the cards (not when the chart first renders), in parallel with the graph fetch. The focus
// navigator and the outline never wait for it: they are the always-available accessible path and paint as soon as the graph resolves. Until
// the chunk is in, a placeholder holds the chart's place at the height the cards will take (.hfy-tree__skeleton--chart and .hfy-tree__chart
// share a min-height), so a late chunk does not push the navigator down. (No React.lazy: a lazy component whose promise has already resolved
// still renders its fallback once.) A rejected import is cached on purpose: the page stays in outline-only mode for the rest of the page view
// and a reload tries again; nothing on the page offers a retry that could not give a different answer (a refused custom element re-rejects).
let chartImport = null;
const loadChart = () => (chartImport ||= import("../lib/tree-chart.jsx"));

class ChartBoundary extends Component {
  constructor(props) { super(props); this.state = { failed: false }; }
  static getDerivedStateFromError() { return { failed: true }; }
  // A render error inside the chart (the chunk loaded but the element or the sheet threw) is the same fallback.
  componentDidCatch() {
    console.error("HFY tree: CHART_CHUNK_FAILED");
    this.props.onFailed?.();
  }
  render() { return this.state.failed ? null : this.props.children; }
}

/** The graph fetch: the page's session-aware dataFetch when feature-flags.js is there (refresh once on a 401, then sign in with returnTo). */
// The alias probe is a background read: a refusal never sends the visitor to sign in (the graph already loaded).
const quietFetcher = (url, init) => (window.HFYFeatureFlags?.dataFetch ? window.HFYFeatureFlags.dataFetch(url, init, { interactive: false }) : fetch(url, init));
const fetcher = (url, init) => (window.HFYFeatureFlags?.dataFetch ? window.HFYFeatureFlags.dataFetch(url, init) : fetch(url, init));

function State({ children, action }) {
  return (
    <div className="hfy-tree__state" role="status" data-tree-state>
      <p>{children}</p>
      {action}
    </div>
  );
}

function RelButton({ person, onFocus, current = false }) {
  return (
    <button type="button" className="hfy-tree__person" data-person={person.id} aria-current={current ? "true" : undefined} onClick={() => onFocus(person.id)}>
      <span className="hfy-tree__name">{person.name}</span>
      {person.label ? <span className="hfy-tree__rel">{person.label}</span> : null}
    </button>
  );
}

function Group({ title, people, onFocus, empty = null }) {
  if (!people.length && !empty) return null;
  return (
    <section className="hfy-tree__group" aria-labelledby={`hfy-tree-g-${title.replace(/\W+/g, "-")}`}>
      <h3 id={`hfy-tree-g-${title.replace(/\W+/g, "-")}`}>{title}</h3>
      {people.length ? (
        <ul>{people.map((p) => <li key={p.id}><RelButton person={p} onFocus={onFocus} /></li>)}</ul>
      ) : <p className="hfy-tree__dim">{empty}</p>}
    </section>
  );
}

/** The focus card and the relatives as re-centring buttons: plain semantic HTML, always rendered (viz.md 12.3). */
export function FocusNavigator({ graph, focus, viewer, onFocus, via = null }) {
  const p = graph.person(focus);
  const heading = useRef(null);
  const first = useRef(true);
  // Focus moves to the new card's heading after a re-centre (never on the first paint: that would scroll the page on load), except when the
  // cards view asked for it: the element keeps the keyboard on its own new focus card, and this heading is far below it.
  useEffect(() => {
    if (first.current) { first.current = false; return; }
    if (via?.current === "cards") return;
    heading.current?.focus();
  }, [focus]);
  const rawRel = viewer ? relationLabel(graph, viewer, focus) : null;
  const rel = rawRel === "you" || isRelationWord(rawRel) ? rawRel : null;
  const groups = useMemo(() => focusGroups(graph, focus), [graph, focus]);
  if (!p) return null;
  const place = p.living ? null : placeName(graph, p.birthPlace);
  return (
    <section className="hfy-tree__focus" aria-labelledby="hfy-tree-focus-name" data-tree-focus={focus}>
      <h2 id="hfy-tree-focus-name" tabIndex={-1} ref={heading}>{p.name}</h2>
      <p className="hfy-tree__dim">
        {yearsLabel(p)}{place ? ` · born in ${place}` : ""}{rel && rel !== "you" ? ` · your ${rel}` : ""}{rel === "you" ? " · you" : ""}
      </p>
      <p><a className="hfy-tree__link" href={`/person/?id=${encodeURIComponent(focus)}`}>view page</a></p>
      <Group title="parents" people={groups.parents} onFocus={onFocus} empty="parents not recorded yet" />
      {groups.unions.map((u) => (
        <Group key={u.key} title={u.title} people={[...(u.partner ? [u.partner] : []), ...u.children]} onFocus={onFocus} />
      ))}
      <Group title="brothers and sisters" people={groups.siblings} onFocus={onFocus} />
      {groups.grandparents.length ? (
        <details className="hfy-tree__group hfy-tree__fold">
          <summary>grandparents ({groups.grandparents.length})</summary>
          <ul>{groups.grandparents.map((x) => <li key={x.id}><RelButton person={x} onFocus={onFocus} /></li>)}</ul>
        </details>
      ) : null}
    </section>
  );
}

function PeopleList({ graph, ids, focus, onFocus, label }) {
  const [all, setAll] = useState(false);
  const at = ids.indexOf(focus);
  const showAll = all || at >= LEVEL_PAGE;
  const shown = showAll ? ids : ids.slice(0, LEVEL_PAGE);
  const rest = ids.length - shown.length;
  return (
    <>
      <ul>
        {shown.map((id) => {
          const p = graph.person(id);
          return <li key={id}><RelButton person={{ id, name: p.name, label: yearsLabel(p) }} onFocus={onFocus} current={id === focus} /></li>;
        })}
      </ul>
      {rest > 0 ? <button type="button" className="hfy-tree__more" onClick={() => setAll(true)}>show {rest} more<span className="hfy-tree__sr"> in {label}</span></button> : null}
    </>
  );
}

/**
 * The whole tree as native details, one per generation, with relative labels and a last "not yet connected" group (viz.md 12.3).
 * `sheet` is the copy that opens in the kit Sheet behind the "generations" button between 43rem and 64rem (HFY-TSK-299): it carries no
 * id, no data-tree-outline and no heading (the Sheet's title is the heading), so the page keeps exactly one outline.
 */
export function GenerationOutline({ graph, focus, onFocus, sheet = false }) {
  const model = useMemo(() => outlineModel(graph, focus), [graph, focus]);
  const focusLevel = model.levels.find((l) => l.hasFocus)?.index ?? null;
  const inUnconnected = model.unconnected.includes(focus);
  // The level with the focus is open; opening or closing another is the reader's own, kept across re-centres.
  const [open, setOpen] = useState(() => new Set());
  const key = (k) => String(k);
  const isOpen = (k, dflt) => (open.has(`+${k}`) ? true : open.has(`-${k}`) ? false : dflt);
  // React sets details.open itself when the controlled state changes, and that fires toggle too: only a change that differs from the state React last rendered is the reader's own.
  const toggle = (k, dflt) => (e) => {
    const on = e.currentTarget.open;
    if (on === isOpen(k, dflt)) return;
    setOpen((prev) => { const n = new Set(prev); n.delete(`+${k}`); n.delete(`-${k}`); n.add(`${on ? "+" : "-"}${k}`); return n; });
  };
  return (
    <nav className="hfy-tree__outline" {...(sheet ? { "aria-label": "generations in the family", "data-tree-outline-sheet": "" } : { id: "hfy-tree-outline", tabIndex: -1, "aria-label": "generations", "data-tree-outline": "" })}>
      {sheet ? null : <h2>generations</h2>}
      {model.levels.map((l) => (
        <details key={l.index} className="hfy-tree__level" open={isOpen(key(l.index), l.index === focusLevel)} onToggle={toggle(key(l.index), l.index === focusLevel)} data-tree-level={l.index}>
          <summary>{l.label} ({l.ids.length})</summary>
          <PeopleList graph={graph} ids={l.ids} focus={focus} onFocus={onFocus} label={l.label} />
        </details>
      ))}
      {model.unconnected.length ? (
        <details className="hfy-tree__level" open={isOpen("x", inUnconnected)} onToggle={toggle("x", inUnconnected)} data-tree-level="unconnected">
          <summary>not yet connected to the tree ({model.unconnected.length})</summary>
          <PeopleList graph={graph} ids={model.unconnected} focus={focus} onFocus={onFocus} label="not yet connected" />
        </details>
      ) : null}
    </nav>
  );
}

/** The cards | outline switch: two buttons in a group, the current one pressed. Both are always real buttons, 44 px at every width. */
export function ViewToggle({ view, onChoose }) {
  return (
    <div className="hfy-tree__views" role="group" aria-label="view" data-tree-views>
      {["cards", "outline"].map((v) => (
        <button key={v} type="button" className="hfy-tree__view" aria-pressed={view === v ? "true" : "false"} data-tree-view={v} onClick={() => onChoose(v)}>{v}</button>
      ))}
    </div>
  );
}

export function TreeApp() {
  const session = useEdgeSession();
  const sub = memberSub(session);
  const [result, setResult] = useState(null); // null while loading, else loadGraph's answer
  const [attempt, setAttempt] = useState(0);
  const [focus, setFocus] = useState(() => focusParam(location.search));
  const [online, setOnline] = useState(() => navigator.onLine !== false);
  // Who asked for the re-centre: "cards" (the <family-navigator>, which looks after its own focus) or "list" (the lists, the outline, Back).
  const via = useRef("list");
  // "cards" | "outline": ?view=, else what this browser remembered, else the cards (lib/tree-view.js; storage failures are survived there).
  const [view, setView] = useState(() => initialView(location.search));
  const viewRef = useRef(view);
  viewRef.current = view;
  // The cards chunk could not load (or the browser refused the element): outline-only for the rest of this page view.
  const [chartFailed, setChartFailed] = useState(false);
  // The chart component once its chunk has loaded.
  const [Chart, setChart] = useState(null);

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

  useEffect(() => {
    if (view !== "cards" || Chart || chartFailed) return undefined;
    let live = true;
    loadChart().then(
      (m) => { if (live) setChart(() => m.default); },
      () => {
        if (!live) return;
        console.error("HFY tree: CHART_CHUNK_FAILED");
        setChartFailed(true);
      }
    );
    return () => { live = false; };
  }, [view, Chart, chartFailed]);

  // Back and forward restore the previous focus (the page pushes one history entry per re-centre).
  useEffect(() => {
    const onPop = () => {
      via.current = "list";
      setFocus(focusParam(location.search));
      // The view is the reader's choice, not part of a history entry: an older entry's address must not flip it back.
      const v = viewParam(location.search);
      if (v && v !== viewRef.current) history.replaceState(null, "", viewUrl(location, viewRef.current));
    };
    addEventListener("popstate", onPop);
    return () => removeEventListener("popstate", onPop);
  }, []);

  const graph = result?.state === "ready" ? result.graph : null;
  // The session probe resolves after the graph on some loads; hold the first paint until it has, so the viewer's own page is not flashed
  // as the default person. (A null session, authV2 off or unreachable, is "settled": undefined is the only pending value.)
  // merge-alias-redirect: a ?focus= that is not in the graph may be a merged-away id. Its person JSON is the stub {mergedInto}; follow it
  // (lib/merged-person.js) and centre on the new id. Until that is known the page holds its loading state, so the "not found" notice is
  // not flashed for an id that is about to resolve.
  const [alias, setAlias] = useState(null); // {from, to}: the answer for one ?focus value, `to` null when it is not an alias
  const unknownFocus = Boolean(graph && focus && !graph.has(focus));
  useEffect(() => {
    if (!unknownFocus || alias?.from === focus) return undefined;
    const ctl = new AbortController();
    resolveMerged(quietFetcher, focus, { signal: ctl.signal }).then((to) => { if (!ctl.signal.aborted) setAlias({ from: focus, to }); });
    return () => ctl.abort();
  }, [unknownFocus, focus, alias?.from]);
  const aliasPending = unknownFocus && alias?.from !== focus;
  const focusNow = unknownFocus && alias?.from === focus && alias.to && graph.has(alias.to) ? alias.to : focus;
  const resolved = useMemo(() => (graph && session !== undefined && !aliasPending ? resolveFocus(graph, { focus: focusNow, sub }) : null), [graph, session, aliasPending, focusNow, sub]);
  const onFocus = useCallback((id, from = "list") => {
    via.current = from;
    history.pushState(null, "", focusUrl(location, id));
    setFocus(id);
  }, []);
  // A bad ?focus is replaced in the address bar by the person actually shown, so a share link or a reload agrees with the page.
  useEffect(() => {
    if (resolved && resolved.id && resolved.id !== focusParam(location.search)) history.replaceState(null, "", focusUrl(location, resolved.id));
  }, [resolved]);
  const onView = useCallback((v) => {
    setView(v);
    writeStoredView(v);
    history.replaceState(null, "", viewUrl(location, v));
  }, []);
  const [spoken, setSpoken] = useState("");
  const announced = useRef(null);
  useEffect(() => {
    if (!graph || !resolved?.id) return;
    // Nothing is announced on first paint; only a later re-centre is.
    if (announced.current !== null && announced.current !== resolved.id) setSpoken(announce(graph, resolved.id));
    announced.current = resolved.id;
  }, [graph, resolved?.id]);

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
    <div className="hfy-tree hfy-tree--ready" data-tree-mode={chartFailed ? "outline" : view}>
      {resolved.fellBack ? <p className="hfy-tree__notice" role="status" data-tree-notice>{COPY.notFound}</p> : null}
      {chartFailed ? (
        <p className="hfy-tree__notice" role="status" data-tree-chart-failed>{COPY.chartFailed}</p>
      ) : (
        <>
          <ViewToggle view={view} onChoose={onView} />
          {view === "cards" ? (
            <ChartBoundary onFailed={() => setChartFailed(true)}>
              {Chart ? <Chart graph={graph} focus={resolved.id} onFocus={onFocus} viewer={sub} renderOutline={(onPick) => <GenerationOutline graph={graph} focus={resolved.id} onFocus={onPick} sheet />} /> : <div className="hfy-tree__skeleton hfy-tree__skeleton--chart" aria-hidden="true" data-tree-chart-loading />}
            </ChartBoundary>
          ) : null}
        </>
      )}
      <FocusNavigator graph={graph} focus={resolved.id} viewer={sub} onFocus={onFocus} via={via} />
      <GenerationOutline graph={graph} focus={resolved.id} onFocus={onFocus} />
      <p className="hfy-tree__live" aria-live="polite" data-tree-live>{spoken}</p>
    </div>
  );
}

mountIsland("tree", TreeApp);
