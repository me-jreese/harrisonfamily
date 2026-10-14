// The lazy chart chunk of /tree/ (HFY-TSK-145, viz-mvp-visual; viz.md section 8). ChartView hosts the framework-free <family-navigator>:
// it sets `graph` and `focus` as properties, turns the element's hfy-focus and hfy-details CustomEvents into the island's calls, and renders
// the details sheet itself (the kit Sheet; the element ships no sheet of its own). Everything the person reads here is also in the always
// rendered focus navigator and generation outline, so a chunk that fails to load costs nothing but the cards.
//
// Person links (HFY-TSK-201 addendum: names outside the SVG use PersonName): the cards are re-centre buttons and a link cannot sit inside a
// button, so card names are plain text by design (see lib/family-navigator.js). The Sheet carries the links: its title, the parents, the
// partner and the children are PersonName, and "view page" goes to the person. The skip link below is the one navigation aid this chunk adds
// (the outline anchor it targets is in tree.jsx); viz-mvp-visual-nav may restyle or replace it.
//
// From 43rem (HFY-TSK-299, viz-mvp-visual-desktop; ADR 4.5, viz.md 9.1 and 9.2) the element draws the four-row grid and this chunk adds the
// detail panel beside it, which shows the focus person (the focus card then moves the keyboard to the panel instead of opening the Sheet).
// Between 43rem and 64rem it also adds a "generations" button that opens the page's outline in the kit Sheet (the page passes `renderOutline`).
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { Sheet, useBreakpoint } from "@io-kit/shell/react";
import { WIDE_QUERY, bindNavigatorEvents, defineFamilyNavigator } from "./family-navigator.js";
import { isRelationWord, relationLabel } from "./family-graph.js";
import { COPY, detailsModel, faceUrl, initials } from "./navigator-model.js";
import { PersonName } from "./person-name.jsx";

// Throws if the browser refuses the definition: the lazy import then rejects and the page keeps the outline (the boundary in tree.jsx).
defineFamilyNavigator();

/** True while `query` matches; false when matchMedia is missing. */
function useMedia(query) {
  const [on, setOn] = useState(() => (typeof matchMedia === "function" ? matchMedia(query).matches : false));
  useEffect(() => {
    if (typeof matchMedia !== "function") return undefined;
    const mq = matchMedia(query);
    const update = () => setOn(mq.matches);
    update();
    mq.addEventListener?.("change", update);
    return () => mq.removeEventListener?.("change", update);
  }, [query]);
  return on;
}

// Between the two layouts' widths: the outline is behind the "generations" button here (viz.md 9.2).
const MEDIUM_QUERY = `${WIDE_QUERY} and (max-width: 63.99rem)`;

function Details({ graph, id, idp = "hfy-tree-details" }) {
  const d = useMemo(() => detailsModel(graph, id), [graph, id]);
  if (!d) return null;
  const places = [d.born ? ["born", d.born] : null, d.died ? ["died", d.died] : null].filter(Boolean);
  return (
    <div className="hfy-tree-details" data-tree-details={id}>
      <dl className="hfy-tree-details__facts">
        <dt>years</dt>
        <dd>{d.years}</dd>
        {places.map(([k, v]) => <div key={k} className="hfy-tree-details__fact"><dt>{k}</dt><dd>{v}</dd></div>)}
      </dl>
      <p><a className="hfy-tree__link" href={d.href}>{COPY.viewPage}</a></p>
      {d.parents.length ? (
        <section aria-labelledby={`${idp}-parents`}>
          <h3 id={`${idp}-parents`}>parents</h3>
          <ul>{d.parents.map((p) => <li key={p.id}><PersonName id={p.id} name={p.name} /> <span className="hfy-tree__dim">{p.label}</span></li>)}</ul>
        </section>
      ) : null}
      <section aria-labelledby={`${idp}-unions`}>
        <h3 id={`${idp}-unions`}>partners and children</h3>
        {d.unions.length ? d.unions.map((u) => (
          <div key={u.id} className="hfy-tree-details__union" data-tree-union={u.id}>
            <p>
              {u.partner ? <>with <PersonName id={u.partner.id} name={u.partner.name} /> <span className="hfy-tree__dim">{u.partner.label}</span></> : COPY.partnerMissing}
            </p>
            {u.children.length ? (
              <ul>{u.children.map((c) => <li key={c.id}><PersonName id={c.id} name={c.name} /> <span className="hfy-tree__dim">{c.label}</span></li>)}</ul>
            ) : <p className="hfy-tree__dim">{COPY.childrenNone}</p>}
          </div>
        )) : <p className="hfy-tree__dim">{COPY.noUnions}</p>}
      </section>
    </div>
  );
}

/** The detail panel (viz.md 9.1): the focus person at a glance, then the same lists the Sheet shows. Rendered from 43rem only. */
function Panel({ graph, id, viewer, headingRef }) {
  const p = graph.person(id);
  const d = useMemo(() => detailsModel(graph, id), [graph, id]);
  const [faceFailed, setFaceFailed] = useState(false);
  useEffect(() => { setFaceFailed(false); }, [id]);
  if (!p || !d) return null;
  const face = faceFailed ? null : faceUrl(p.face);
  const rawRel = viewer ? relationLabel(graph, viewer, id) : null;
  const rel = rawRel === "you" ? "that's you" : isRelationWord(rawRel) ? `how you're related: ${rawRel}` : null;
  return (
    <section className="hfy-tree__panel" aria-labelledby="hfy-tree-panel-name" data-tree-panel={id}>
      <div className="hfy-tree__panel-head">
        <span className="hfy-nav__avatar hfy-tree__panel-avatar" data-pair="focus" aria-hidden="true">
          {face ? <img className="hfy-nav__face" src={face} alt="" width={160} height={160} decoding="async" onError={() => setFaceFailed(true)} /> : initials(p)}
        </span>
        <h3 id="hfy-tree-panel-name" className="hfy-tree__panel-name" tabIndex={-1} ref={headingRef}><PersonName id={id} name={p.name} /></h3>
      </div>
      {d.counts.map((line) => <p key={line} className="hfy-tree__panel-counts">{line}</p>)}
      {rel ? <p className="hfy-tree__panel-counts" data-tree-panel-relation>{rel}</p> : null}
      <Details graph={graph} id={id} idp="hfy-tree-panel" />
    </section>
  );
}

/**
 * The cards view: <family-navigator>, the detail panel (from 43rem) or the details sheet (below it), and between 43rem and 64rem the
 * "generations" Sheet. `onFocus(id, "cards")` re-centres the page; `renderOutline(onPick)` draws the page's outline for that Sheet.
 */
export default function ChartView({ graph, focus, onFocus, viewer = null, renderOutline = null }) {
  const el = useRef(null);
  const bp = useBreakpoint();
  const [detailsId, setDetailsId] = useState(null);
  const [gens, setGens] = useState(false);
  const wide = useMedia(WIDE_QUERY);
  const medium = useMedia(MEDIUM_QUERY);
  const panelHeading = useRef(null);
  const wideRef = useRef(wide);
  wideRef.current = wide;
  const onFocusRef = useRef(onFocus);
  onFocusRef.current = onFocus;
  useLayoutEffect(() => {
    if (!el.current) return;
    el.current.graph = graph;
    el.current.focus = focus;
  }, [graph, focus]);
  // The focus card asks for the details: beside the panel that means "take me to it"; on a phone it opens the Sheet.
  useEffect(() => bindNavigatorEvents(el.current, {
    onFocus: (id) => onFocusRef.current(id, "cards"),
    onDetails: (id) => { if (wideRef.current && panelHeading.current) panelHeading.current.focus(); else setDetailsId(id); }
  }), []);
  // Crossing into the grid layout puts the phone's Sheet away; leaving the medium band closes the generations Sheet.
  useEffect(() => { if (wide) setDetailsId(null); }, [wide]);
  useEffect(() => { if (!medium) setGens(false); }, [medium]);
  // A re-centre elsewhere (the outline, Back) closes a sheet about the previous person.
  useEffect(() => { setDetailsId(null); }, [focus]);
  const name = graph.person(focus)?.name;
  return (
    <div className="hfy-tree__chart" data-tree-chart>
      <a className="hfy-tree__skip" href="#hfy-tree-outline">skip to the family outline</a>
      {medium && renderOutline ? (
        <div className="hfy-tree__tools">
          <button type="button" className="hfy-tree__generations" aria-haspopup="dialog" aria-expanded={gens ? "true" : "false"} data-tree-generations onClick={() => setGens(true)}>generations</button>
        </div>
      ) : null}
      <family-navigator ref={el} />
      {wide ? <Panel graph={graph} id={focus} viewer={viewer} headingRef={panelHeading} /> : null}
      {medium && renderOutline ? (
        <Sheet open={gens} onClose={() => setGens(false)} side="right" title="generations" closeLabel="close" className="hfy-tree-sheet">
          <div className="hfy-tree hfy-tree__sheet-outline">{renderOutline((id) => { setGens(false); onFocusRef.current(id, "cards"); })}</div>
        </Sheet>
      ) : null}
      <Sheet open={Boolean(detailsId)} onClose={() => setDetailsId(null)} side={bp === "compact" ? "bottom" : "right"} title={<PersonName id={detailsId || focus} name={graph.person(detailsId || focus)?.name || name} />} closeLabel="close" className="hfy-tree-sheet">
        {detailsId ? <Details graph={graph} id={detailsId} /> : null}
      </Sheet>
    </div>
  );
}
