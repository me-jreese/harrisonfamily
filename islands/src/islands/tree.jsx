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
import { createPortal } from "react-dom";
import { mountIsland } from "../lib/mount.jsx";
import { memberSub, useEdgeSession } from "../lib/edge-session.js";
import { resolveMerged } from "../lib/merged-person.js";
import { announce, focusParam, focusUrl, loadGraph, resolveFocus, signInHref, yearsLabel } from "../lib/tree-data.js";
import { isRelationWord, relationLabel } from "../lib/family-graph.js";
import { LEVEL_PAGE, focusGroups, outlineModel, placeName } from "../lib/tree-outline.js";
import { FACES_VIEW, FAMILY_VIEW, LIFELINES_VIEW, TABLE_VIEW, TREE_COPY, firstNameOf, initialView, treeAsked, treeTabIsNew, treeUrl, viewParam, viewUrl, writeStoredView } from "../lib/tree-view.js";
import { layoutOf } from "../lib/bigtree-model.js";
import { useFlags } from "../lib/use-flags.js";
import { useMedia } from "../lib/use-media.js";

export const COPY = {
  prepared: "the family tree is being prepared. you can find anyone through search.",
  error: "the family tree didn't load. try again.",
  signedOut: "sign in to see the family tree.",
  offline: "the family tree needs a connection.",
  notFound: "we couldn't find that person, so here is someone to start from.",
  chartFailed: "the chart didn't load. the outline below has everything.",
  bigTreePrepared: "the whole-family view is being prepared.",
  bigTreeFailed: "the whole-family view didn't load. the outline below has everything.",
  treeFailed: "the big tree didn't load. the cards below have everyone."
};
const OUTLINE_ID = "hfy-tree-outline";

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
// The lifelines view (HFY-TSK-269, flag familyVizTime) is its own lazy chunk, loaded only when that view opens. If it fails to load the page
// falls back to the cards, which hold the same people.
let lifelinesImport = null;
const loadLifelines = () => (lifelinesImport ||= import("../lib/tree-lifelines.jsx"));

// HFY-TSK-307 (flag familyVizKinship): the "how are we related?" panel is its own lazy chunk (lib/tree-kinship.jsx), fetched when the pill is first
// opened. Unlike the chart, a failed load is retryable: the pill says so and the next open tries again.
let kinshipImport = null;
// The failure line is the model's COPY.loadFailed; kept as a literal so the pill does not pull the model in eagerly (tests/kinship-ui.test.mjs pins them equal).
const LOAD_FAILED = "this didn't load. try again.";
const loadKinship = () => (kinshipImport ||= import("../lib/tree-kinship.jsx").catch((e) => { kinshipImport = null; throw e; }));

/** The pill and, once opened, the panel. Rendered only for a signed-in member who is in the graph, with familyVizKinship on. */
export function KinshipSlot({ graph, viewer, focus, onFocus }) {
  // `?kin=1` (the big hourglass tree's "how are we related?") opens the panel at once, for the person in the address.
  const [open, setOpen] = useState(() => new URLSearchParams(location.search).get("kin") === "1");
  const [Panel, setPanel] = useState(null);
  const [failed, setFailed] = useState(false);
  const pill = useRef(null);
  const wasOpen = useRef(false);
  useEffect(() => {
    if (!open || Panel) return undefined;
    let live = true;
    setFailed(false);
    loadKinship().then((m) => { if (live) setPanel(() => m.default); }, () => { if (live) { setFailed(true); setOpen(false); } });
    return () => { live = false; };
  }, [open, Panel]);
  // Closing puts the keyboard back on the pill.
  useEffect(() => {
    if (wasOpen.current && !open) pill.current?.focus();
    wasOpen.current = open;
  }, [open]);
  return (
    <div className="hfy-tree__kin" data-tree-kin>
      <button type="button" ref={pill} className="hfy-tree__view hfy-kin__pill" aria-expanded={open ? "true" : "false"} aria-controls="hfy-kin-region" data-tree-kin-pill onClick={() => setOpen((v) => !v)}>how are we related?</button>
      {failed ? <p className="hfy-tree__dim" role="status">{LOAD_FAILED}</p> : null}
      <div id="hfy-kin-region">
        {open && Panel ? <Panel graph={graph} viewer={viewer} focus={focus} onFocus={onFocus} /> : null}
      </div>
    </div>
  );
}

// The whole-family poster (HFY-TSK-272, familyVizBigTree, from 64rem) is a second lazy chunk, requested only when that view is open AND the graph
// has a usable `layout` block: without one the page says it is being prepared and loads nothing more. It is never imported otherwise.
let bigTreeImport = null;
const loadBigTree = () => (bigTreeImport ||= import("../lib/tree-bigtree.jsx"));
// The faces tab (HFY-TSK-308, familyVizFaces) is a lazy chunk too (lib/tree-faces.jsx), loaded only when that view opens. If it fails to load the
// page falls back to the cards, which hold the same people.
let facesImport = null;
const loadFaces = () => (facesImport ||= import("../lib/tree-faces.jsx"));
const BIGTREE_QUERY = "(min-width: 64rem)";
// The big hourglass tree (HFY-TSK-379, familyVizHourglass, ?view=tree) is a plain-DOM lazy chunk too (lib/tree-hourglass-big.js), loaded only when that view
// is asked for with the flag on. It draws a full-screen view of its own, so the page's toggle, navigator and outline are not rendered beside it; a chunk that
// will not load drops the page to the cards (the same people), with a line that says so.
let hourglassImport = null;
const loadHourglass = () => (hourglassImport ||= import("../lib/tree-hourglass-big.js"));

/** The big hourglass tree: the chunk draws into the host; `go` is its way to put a new middle person in the address and the page's state. */
function HourglassView({ graph, focus, from, notice, links, sync, onFailed }) {
  const host = useRef(null);
  // The big tree's top bar, once drawn: the "centred on" chip is this page's, drawn into it (a portal), so the hourglass chunk and its byte budget stay as they were.
  const [top, setTop] = useState(null);
  // The newest props, read when the chunk mounts: a graph that reloads remounts on whoever is in the middle now, not on the first person.
  const now = useRef(null);
  now.current = { focus, from, notice, links, sync, onFailed };
  useEffect(() => {
    let live = true;
    let api = null;
    const fail = (e) => { if (live) { console.error("HFY tree: HOURGLASS_CHUNK_FAILED", e); now.current.onFailed(); } };
    loadHourglass().then((m) => {
      if (!live) return;
      const o = now.current;
      api = m.mountBig(host.current, { graph, focus: o.focus, from: o.from, ggp: new URLSearchParams(location.search).get("ggp") === "1", links: o.links, notice: o.notice, sync: o.sync });
      setTop(host.current.querySelector(".hfy-bt__top"));
    }).catch(fail);
    return () => { live = false; api?.destroy(); setTop(null); };
  }, [graph]);
  const name = graph.person(focus)?.name;
  return (
    <>
      <div ref={host} className="hfy-bt-host" data-tree-hourglass />
      {top && name ? createPortal(<CentredChip name={name} href={`${viewUrl({ pathname: location.pathname, search: `?focus=${focus}`, hash: "" }, "cards")}#${OUTLINE_ID}`} />, top) : null}
    </>
  );
}

/** Put the keyboard on the page's generation outline, which lists everyone and re-centres on a choice: the page's own way to pick another person. */
function showOutline() {
  const o = document.getElementById(OUTLINE_ID);
  if (!o) return false;
  o.focus();
  o.scrollIntoView?.({ block: "start" });
  return true;
}

/**
 * "centred on {name}" and "change" (HFY-TSK-379 pass 4, T-Both): the person every view of the page is about. "change" has no board-defined target. The page has
 * no search of its own; the one place that lists everyone and re-centres on a pick is the generation outline, so "change" goes there: it takes the keyboard to the
 * outline when the page has one (the family views), and in the big tree, which has none, it is a link to the cards view for the same person that opens on the outline.
 */
function CentredChip({ name, href = `#${OUTLINE_ID}`, local = false }) {
  return (
    <p className="hfy-ctx" data-tree-ctx>
      <span>{TREE_COPY.centred} <b>{name}</b></span>
      <a className="hfy-ctx__change" href={href} aria-label={TREE_COPY.changeAria} data-tree-ctx-change onClick={local ? (e) => { if (showOutline()) e.preventDefault(); } : undefined}>{TREE_COPY.change}</a>
    </p>
  );
}

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
export function ViewToggle({ view, onChoose, lifelines = false, whole = false, facesTab = false, treeHref = null }) {
  return (
    <div className="hfy-tree__views" role="group" aria-label="view" data-tree-views>
      {["cards", "outline", ...(lifelines ? [LIFELINES_VIEW, TABLE_VIEW] : []), ...(facesTab ? [FACES_VIEW] : []), ...(whole ? [FAMILY_VIEW] : [])].map((v) => (
        <button key={v} type="button" className="hfy-tree__view" aria-pressed={view === v ? "true" : "false"} data-tree-view={v} onClick={() => onChoose(v)}>{v === FAMILY_VIEW ? "whole family" : v}</button>
      ))}
      {treeHref ? (
        // familyVizHourglass: the last tab opens the big tree for the person in the middle (a real address, so Back returns here); it is a link, not a pressed button, because it leaves this view.
        <a className="hfy-tree__view hfy-tree__view--tree" href={treeHref} data-tree-view="tree">{TREE_COPY.tab}{treeTabIsNew() ? <span className="hfy-tree__new">{TREE_COPY.fresh}</span> : null}</a>
      ) : null}
    </div>
  );
}

export function TreeApp() {
  const session = useEdgeSession();
  // familyVizFaces (HFY-TSK-271): "pictured with" chips in the details; an absent key or unresolved flags is off.
  const flags = useFlags();
  const faces = flags?.familyVizFaces === true;
  const wide = useMedia(BIGTREE_QUERY);
  // The whole-family view is on offer from 64rem with familyVizBigTree. Below that, or with the flag off, a remembered or addressed
  // "family" reads as the cards. While the flags are still on their way it waits (flags === undefined) instead of loading the cards.
  const bigOffered = flags?.familyVizBigTree === true && wide;
  const sub = memberSub(session);
  const [result, setResult] = useState(null); // null while loading, else loadGraph's answer
  const [attempt, setAttempt] = useState(0);
  const [focus, setFocus] = useState(() => focusParam(location.search));
  const [online, setOnline] = useState(() => navigator.onLine !== false);
  // Who asked for the re-centre: "cards" (the <family-navigator>, which looks after its own focus) or "list" (the lists, the outline, Back).
  const via = useRef("list");
  // "cards" | "outline": ?view=, else what this browser remembered, else the cards (lib/tree-view.js; storage failures are survived there).
  const [view, setView] = useState(() => initialView(location.search));
  const pendingFamily = view === FAMILY_VIEW && flags === undefined;
  const viewRef = useRef(view);
  const fromLifeline = useRef(false);
  viewRef.current = view;
  // The cards chunk could not load (or the browser refused the element): outline-only for the rest of this page view.
  const [chartFailed, setChartFailed] = useState(false);
  // The chart component once its chunk has loaded.
  const [Chart, setChart] = useState(null);
  // familyVizTime (HFY-TSK-269): the lifelines view. `shown` is what the page draws: "lifelines" only with the flag on and its chunk loadable;
  // while the flags are still on their way a ?view=lifelines holds a placeholder rather than flashing the cards.
  const timeOn = flags?.familyVizTime === true;
  const [Lifelines, setLifelines] = useState(null);
  const [lifelinesFailed, setLifelinesFailed] = useState(false);
  // familyVizHourglass (HFY-TSK-379): `?view=tree` is the big tree. With the flag off it is an unknown view (view above is then what it always was);
  // while the flags are on their way it holds a placeholder rather than flashing the cards.
  const [treeAskedNow] = useState(() => treeAsked(location.search));
  const [treeFailed, setTreeFailed] = useState(false);
  const treeOn = treeAskedNow && flags?.familyVizHourglass === true && !treeFailed;
  const treePending = treeAskedNow && flags === undefined;
  const [FacesTab, setFacesTab] = useState(null);
  const [facesFailed, setFacesFailed] = useState(false);
  const shown = treeOn ? "tree" : treePending ? "treePending" : view === FACES_VIEW ? (facesFailed ? "cards" : faces ? FACES_VIEW : flags === undefined ? "pending" : "cards") : view === LIFELINES_VIEW || view === TABLE_VIEW ? (lifelinesFailed ? "cards" : timeOn ? view : flags === undefined ? "pending" : "cards") : view === FAMILY_VIEW && !bigOffered ? "cards" : view;

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
    if (shown !== "cards" || pendingFamily || Chart || chartFailed) return undefined;
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
  }, [shown, pendingFamily, Chart, chartFailed]);

  useEffect(() => {
    if ((shown !== LIFELINES_VIEW && shown !== TABLE_VIEW) || Lifelines) return undefined;
    let live = true;
    loadLifelines().then(
      (m) => { if (live) setLifelines(() => m.default); },
      () => {
        if (!live) return;
        console.error("HFY tree: LIFELINES_CHUNK_FAILED");
        setLifelinesFailed(true);
      }
    );
    return () => { live = false; };
  }, [shown, Lifelines]);

  useEffect(() => {
    if (shown !== FACES_VIEW || FacesTab) return undefined;
    let live = true;
    loadFaces().then(
      (m) => { if (live) setFacesTab(() => m.default); },
      () => {
        if (!live) return;
        console.error("HFY tree: FACES_CHUNK_FAILED");
        setFacesFailed(true);
      }
    );
    return () => { live = false; };
  }, [shown, FacesTab]);

  const hasLayout = useMemo(() => Boolean(result?.state === "ready" && layoutOf(result.graph)), [result]);
  const [BigTree, setBigTree] = useState(null);
  const [bigFailed, setBigFailed] = useState(false);
  useEffect(() => {
    if (shown !== FAMILY_VIEW || !hasLayout || BigTree || bigFailed) return undefined;
    let live = true;
    loadBigTree().then(
      (m) => { if (live) setBigTree(() => m.default); },
      () => { if (live) { console.error("HFY tree: BIGTREE_CHUNK_FAILED"); setBigFailed(true); } }
    );
    return () => { live = false; };
  }, [shown, hasLayout, BigTree, bigFailed]);

  // Back and forward restore the previous focus (the page pushes one history entry per re-centre).
  useEffect(() => {
    const onPop = () => {
      via.current = "list";
      setFocus(focusParam(location.search));
      // The view is the reader's choice, not part of a history entry: an older entry's address must not flip it back.
      const v = viewParam(location.search);
      if (fromLifeline.current && (v === LIFELINES_VIEW || v === TABLE_VIEW)) {
        fromLifeline.current = false;
        setView(v);
        return;
      }
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
    fromLifeline.current = false;
    setView(v);
    writeStoredView(v);
    history.replaceState(null, "", viewUrl(location, v));
  }, []);
  // Choosing a lifeline opens the navigator (the cards view) on that person. The view is switched in the address without storing it: the reader's
  // remembered view stays what they picked on the toggle.
  // The lifelines entry in the history is left as it was and a new entry is pushed for the cards, so Back returns to the focus and the lifelines the
  // reader was on (`fromLifeline` lets the popstate handler restore that one view change). Focus moves to the navigator's heading, because the
  // lifeline button that was clicked is gone.
  const onLifeline = useCallback((id) => {
    via.current = "list";
    fromLifeline.current = true;
    const next = new URL(focusUrl(location, id), location.origin);
    history.pushState(null, "", viewUrl(next, "cards"));
    setView("cards");
    setFocus(id);
    setTimeout(() => document.getElementById("hfy-tree-focus-name")?.focus(), 0);
  }, []);
  // The big tree's "change" opens the cards view at the generation outline (#hfy-tree-outline): once the page is drawn, with familyVizHourglass on, the keyboard goes there.
  const hashHandled = useRef(false);
  useEffect(() => {
    if (hashHandled.current || flags === undefined || !resolved?.id || shown === "tree" || shown === "treePending") return;
    hashHandled.current = true;
    if (flags.familyVizHourglass === true && location.hash === `#${OUTLINE_ID}`) showOutline();
  }, [flags, resolved?.id, shown]);
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
  if (shown === "treePending") return <div className="hfy-tree" aria-busy="true"><div className="hfy-tree__skeleton" data-tree-loading /></div>;
  if (shown === "tree") {
    const links = { kin: flags.familyVizKinship === true && Boolean(sub) && graph.has(sub), poster: bigOffered && hasLayout, table: timeOn };
    return <HourglassView graph={graph} focus={resolved.id} from={new URLSearchParams(location.search).get("from")} notice={resolved.fellBack ? COPY.notFound : ""} links={links} sync={setFocus} onFailed={() => setTreeFailed(true)} />;
  }
  // familyVizHourglass (HFY-TSK-379 pass 4): the "tree" tab, the "centred on" chip and the cards' "see {first} in the tree" link; with the flag off none of them exists.
  const hourglass = flags?.familyVizHourglass === true;
  const bigHref = hourglass ? treeUrl(location, resolved.id) : null;
  return (
    <div className="hfy-tree hfy-tree--ready" data-tree-mode={shown === FAMILY_VIEW ? FAMILY_VIEW : chartFailed ? "outline" : shown}>
      {resolved.fellBack ? <p className="hfy-tree__notice" role="status" data-tree-notice>{COPY.notFound}</p> : null}
      {hourglass && graph.person(resolved.id) ? <CentredChip name={graph.person(resolved.id).name} local /> : null}
      {treeFailed ? <p className="hfy-tree__notice" role="status" data-tree-hourglass-failed>{COPY.treeFailed}</p> : null}
      {chartFailed && shown !== FAMILY_VIEW ? (
        <p className="hfy-tree__notice" role="status" data-tree-chart-failed>{COPY.chartFailed}</p>
      ) : (
        <>
          <ViewToggle view={shown === "pending" ? view : shown} onChoose={onView} lifelines={timeOn || (shown === "pending" && view !== FACES_VIEW)} whole={bigOffered} facesTab={faces} treeHref={bigHref} />
          {shown === "pending" && view === FACES_VIEW ? <div className="hfy-tree__skeleton hfy-tree__skeleton--chart" aria-hidden="true" data-tree-faces-loading /> : null}
          {shown === FACES_VIEW ? (
            FacesTab ? <FacesTab graph={graph} fetcher={fetcher} /> : <div className="hfy-tree__skeleton hfy-tree__skeleton--chart" aria-hidden="true" data-tree-faces-loading />
          ) : null}
          {shown === LIFELINES_VIEW || shown === TABLE_VIEW || (shown === "pending" && view !== FACES_VIEW) ? (
            Lifelines && (shown === LIFELINES_VIEW || shown === TABLE_VIEW)
              ? <Lifelines mode={shown} graph={graph} focus={resolved.id} onPick={onLifeline} onRecentre={onFocus} />
              : <div className="hfy-tree__skeleton hfy-tree__skeleton--lifelines" aria-hidden="true" data-tree-lifelines-loading />
          ) : null}
          {shown === FAMILY_VIEW ? (
            !hasLayout ? <p className="hfy-tree__notice" role="status" data-tree-poster-prepared>{COPY.bigTreePrepared}</p>
              : bigFailed ? <p className="hfy-tree__notice" role="status" data-tree-poster-failed>{COPY.bigTreeFailed}</p>
              : BigTree ? <BigTree graph={graph} viewer={sub} onOpen={(id) => { setView("cards"); history.replaceState(null, "", viewUrl(location, "cards")); onFocus(id, "list"); }} />
              : <div className="hfy-tree__skeleton hfy-tree__skeleton--chart" aria-hidden="true" data-tree-poster-loading />
          ) : null}
          {shown === "cards" && bigHref ? (
            <p className="hfy-tree__seetree" data-tree-seetree>
              <a className="hfy-tree__see" href={treeUrl(location, resolved.id, resolved.id)}>
                <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M12 3v6M6 9h12M6 9v4M18 9v4M12 15v6M4 13h4v4H4zM16 13h4v4h-4z" /></svg>
                {TREE_COPY.see(firstNameOf(graph.person(resolved.id)))}
              </a>
            </p>
          ) : null}
          {shown === "cards" ? (
            <ChartBoundary onFailed={() => setChartFailed(true)}>
              {Chart ? <Chart graph={graph} focus={resolved.id} onFocus={onFocus} viewer={sub} faces={faces} renderOutline={(onPick) => <GenerationOutline graph={graph} focus={resolved.id} onFocus={onPick} sheet />} /> : <div className="hfy-tree__skeleton hfy-tree__skeleton--chart" aria-hidden="true" data-tree-chart-loading />}
            </ChartBoundary>
          ) : null}
        </>
      )}
      {flags?.familyVizKinship === true && sub && graph.has(sub) ? <KinshipSlot graph={graph} viewer={sub} focus={resolved.id} onFocus={onFocus} /> : null}
      <FocusNavigator graph={graph} focus={resolved.id} viewer={sub} onFocus={onFocus} via={via} />
      <GenerationOutline graph={graph} focus={resolved.id} onFocus={onFocus} />
      <p className="hfy-tree__live" aria-live="polite" data-tree-live>{spoken}</p>
    </div>
  );
}

mountIsland("tree", TreeApp);
