// The lazy chart chunk of /tree/ (HFY-TSK-145, viz-mvp-visual; viz.md section 8). ChartView hosts the framework-free <family-navigator>:
// it sets `graph` and `focus` as properties, turns the element's hfy-focus and hfy-details CustomEvents into the island's calls, and renders
// the details sheet itself (the kit Sheet; the element ships no sheet of its own). Everything the person reads here is also in the always
// rendered focus navigator and generation outline, so a chunk that fails to load costs nothing but the cards.
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { Sheet, useBreakpoint } from "@io-kit/shell/react";
import { bindNavigatorEvents, defineFamilyNavigator } from "./family-navigator.js";
import { COPY, detailsModel } from "./navigator-model.js";
import { PersonName } from "./person-name.jsx";

// Throws if the browser refuses the definition: the lazy import then rejects and the page keeps the outline (the boundary in tree.jsx).
defineFamilyNavigator();

function Details({ graph, id }) {
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
        <section aria-labelledby="hfy-tree-details-parents">
          <h3 id="hfy-tree-details-parents">parents</h3>
          <ul>{d.parents.map((p) => <li key={p.id}><PersonName id={p.id} name={p.name} /> <span className="hfy-tree__dim">{p.label}</span></li>)}</ul>
        </section>
      ) : null}
      <section aria-labelledby="hfy-tree-details-unions">
        <h3 id="hfy-tree-details-unions">partners and children</h3>
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

/** The cards view: <family-navigator> plus the details sheet. `onFocus(id, "cards")` re-centres the page. */
export default function ChartView({ graph, focus, onFocus }) {
  const el = useRef(null);
  const bp = useBreakpoint();
  const [detailsId, setDetailsId] = useState(null);
  const onFocusRef = useRef(onFocus);
  onFocusRef.current = onFocus;
  useLayoutEffect(() => {
    if (!el.current) return;
    el.current.graph = graph;
    el.current.focus = focus;
  }, [graph, focus]);
  useEffect(() => bindNavigatorEvents(el.current, { onFocus: (id) => onFocusRef.current(id, "cards"), onDetails: setDetailsId }), []);
  // A re-centre elsewhere (the outline, Back) closes a sheet about the previous person.
  useEffect(() => { setDetailsId(null); }, [focus]);
  const name = graph.person(focus)?.name;
  return (
    <div className="hfy-tree__chart" data-tree-chart>
      <a className="hfy-tree__skip" href="#hfy-tree-outline">skip to the family outline</a>
      <family-navigator ref={el} />
      <Sheet open={Boolean(detailsId)} onClose={() => setDetailsId(null)} side={bp === "compact" ? "bottom" : "right"} title={<PersonName id={detailsId || focus} name={graph.person(detailsId || focus)?.name || name} />} closeLabel="close" className="hfy-tree-sheet">
        {detailsId ? <Details graph={graph} id={detailsId} /> : null}
      </Sheet>
    </div>
  );
}
