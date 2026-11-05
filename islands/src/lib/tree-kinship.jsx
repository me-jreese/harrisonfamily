// The lazy "how are we related?" chunk of /tree/ (HFY-TSK-307, viz-v2-kinship-ui; flag familyVizKinship). tree.jsx draws the pill and loads this
// only when the pill is first opened. It shows a vertical chain of cards from the viewer up to the common ancestor and down to the person on
// the focus card, then one plain sentence; with pedigree collapse every route is listed. Two shortcuts, "my grandparents" and "my cousins",
// open a list of the viewer's relatives, and choosing one re-centres the navigator (`onFocus`). Every card is a button.
//
// Person links (HFY-TSK-307 addendum, P2-R46): a card is a re-centre button and a link cannot sit inside a button, so card names are plain text
// by design, as in the navigator cards (lib/family-navigator.js). The sentence names the person with PersonName, which links to the page.
import { useEffect, useMemo, useRef, useState } from "react";
import { PersonName } from "./person-name.jsx";
import { COPY, COUSIN_CAP, cousinsOf, grandparentsOf, kinshipModel } from "./kinship-model.js";

function Card({ graph, id, label, current, onFocus }) {
  const p = graph.person(id);
  if (!p) return null;
  return (
    <button type="button" className="hfy-tree__person hfy-kin__card" data-person={id} aria-current={current ? "true" : undefined} onClick={() => onFocus(id)}>
      <span className="hfy-tree__name">{p.name}</span>
      {label ? <span className="hfy-tree__rel">{label}</span> : null}
    </button>
  );
}

function Route({ graph, route, index, total, focus, onFocus }) {
  const label = total > 1 ? `route ${index + 1} of ${total}` : "from you to them";
  return (
    <li className="hfy-kin__route" data-kin-route={index}>
      {total > 1 ? <p className="hfy-kin__route-title">{label}</p> : null}
      <ol className="hfy-kin__chain" aria-label={label}>
        {route.steps.map((s, i) => (
          <li key={s.ids.join("+")} className="hfy-kin__step" data-kin-step={i}>
            {s.cards.map((c) => <Card key={c.id} graph={graph} id={c.id} label={c.label} current={i === route.steps.length - 1 && c.id === focus} onFocus={onFocus} />)}
          </li>
        ))}
      </ol>
    </li>
  );
}

function Relatives({ list, empty, id, onFocus }) {
  const [all, setAll] = useState(false);
  if (!list.length) return <p className="hfy-tree__dim" id={id}>{empty}</p>;
  const shown = all ? list : list.slice(0, COUSIN_CAP);
  return (
    <div id={id}>
      <ul className="hfy-kin__list">
        {shown.map((r) => (
          <li key={r.id}>
            <button type="button" className="hfy-tree__person" data-person={r.id} onClick={() => onFocus(r.id)}>
              <span className="hfy-tree__name">{r.name}</span>
              {r.label ? <span className="hfy-tree__rel">{r.label}</span> : null}
            </button>
          </li>
        ))}
      </ul>
      {list.length > shown.length ? <button type="button" className="hfy-tree__more" onClick={() => setAll(true)}>show {list.length - shown.length} more</button> : null}
    </div>
  );
}

export default function KinshipPanel({ graph, viewer, focus, onFocus, headingRef }) {
  const model = useMemo(() => kinshipModel(graph, viewer, focus), [graph, viewer, focus]);
  const grandparents = useMemo(() => grandparentsOf(graph, viewer), [graph, viewer]);
  const cousins = useMemo(() => cousinsOf(graph, viewer), [graph, viewer]);
  const [open, setOpen] = useState(null); // "grandparents" | "cousins" | null
  const mine = useRef(null);
  const heading = headingRef || mine;
  useEffect(() => { heading.current?.focus(); }, []);
  const name = graph.person(focus)?.name || "";
  // Re-centring re-renders the chain, so the button that was clicked may be gone; the navigator then moves focus to its own new heading
  // (FocusNavigator in islands/tree.jsx), so the keyboard is never dropped to the body.
  const toggle = (k) => setOpen((cur) => (cur === k ? null : k));
  return (
    <section className="hfy-kin" aria-labelledby="hfy-kin-title" data-kin-panel>
      <h2 id="hfy-kin-title" tabIndex={-1} ref={heading}>{COPY.title}</h2>
      {model.routes.length ? (
        <ol className="hfy-kin__routes" aria-label="routes from you">
          {model.routes.map((r, i) => <Route key={r.key} graph={graph} route={r} index={i} total={model.routes.length} focus={focus} onFocus={onFocus} />)}
        </ol>
      ) : null}
      {model.hidden ? <p className="hfy-tree__dim" data-kin-hidden>{COPY.moreRoutes(model.hidden)}</p> : null}
      <p className="hfy-kin__sentence" data-kin-sentence>
        {model.state === "self" ? COPY.self : model.state === "missing" ? COPY.missing : <><PersonName id={focus} name={name} /> {model.phrase}</>}
      </p>
      <div className="hfy-kin__shortcuts" role="group" aria-label="jump to">
        <button type="button" className="hfy-tree__view" data-kin-shortcut="grandparents" aria-expanded={open === "grandparents" ? "true" : "false"} aria-controls="hfy-kin-grandparents" onClick={() => toggle("grandparents")}>{COPY.grandparents}</button>
        <button type="button" className="hfy-tree__view" data-kin-shortcut="cousins" aria-expanded={open === "cousins" ? "true" : "false"} aria-controls="hfy-kin-cousins" onClick={() => toggle("cousins")}>{COPY.cousins}</button>
      </div>
      {open === "grandparents" ? <Relatives list={grandparents} empty={COPY.grandparentsNone} id="hfy-kin-grandparents" onFocus={onFocus} /> : null}
      {open === "cousins" ? <Relatives list={cousins} empty={COPY.cousinsNone} id="hfy-kin-cousins" onFocus={onFocus} /> : null}
    </section>
  );
}
