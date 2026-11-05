// The lazy poster chunk of /tree/ (HFY-TSK-272, viz-v2-bigtree, flag familyVizBigTree; viz ADR 4.5 and 4.7): the `layout` block of graph.json
// drawn as SVG, one figure per connected group of people. Person cards are buttons that open the navigator (tree.jsx re-centres and shows the
// cards view), union nodes are small connectors, and the links are elbows from the coordinates and bend points. There is no layout code here
// (lib/bigtree-model.js only reads the block) and no d3-dag. Zoom, pan and the minimap are a later task (viz-v2-bigtree-nav): this one draws
// at one pixel per layout unit and scrolls inside its own region.
//
// Names are never drawn below MIN_NAME_PX (16 px). Each figure measures the scale it is really drawn at (the width it is shown at over the width
// of its layout) and, where a name would be smaller than that, the card shows its face or initials only. The full name stays in the accessible
// name, and the hover or focus label under the heading (PersonName, P2-R46: names outside the SVG link to the person).
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { NAME_UNITS, UNION_R, posterModel, showsName } from "./bigtree-model.js";
import { PersonName } from "./person-name.jsx";

const AVATAR_R = 24;

function Card({ p, w, h, names, onOpen, onHot }) {
  const [faceFailed, setFaceFailed] = useState(false);
  const open = () => onOpen(p.id);
  const lines = p.lines;
  const clip = `hfy-poster-clip-${p.id}`;
  return (
    <g
      className="hfy-poster__card"
      role="button"
      tabIndex={0}
      aria-label={p.label}
      data-person={p.id}
      data-card-mode={names ? "name" : "face"}
      transform={`translate(${p.x - w / 2} ${p.y - h / 2})`}
      onClick={open}
      onKeyDown={(e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); open(); } }}
      onPointerEnter={() => onHot(p.id)}
      onPointerLeave={() => onHot(null)}
      onFocus={() => onHot(p.id)}
      onBlur={() => onHot(null)}
    >
      <rect className="hfy-poster__box" width={w} height={h} rx={8} />
      {names ? (
        <text className="hfy-poster__name" fontSize={NAME_UNITS} textAnchor="middle" x={w / 2} y={lines.length > 1 ? h / 2 - 4 : h / 2 + 5} aria-hidden="true">
          {lines.map((l, i) => <tspan key={i} x={w / 2} dy={i === 0 ? 0 : NAME_UNITS + 2}>{l}</tspan>)}
        </text>
      ) : (
        <g aria-hidden="true">
          <circle className="hfy-poster__avatar" cx={w / 2} cy={h / 2} r={AVATAR_R} />
          {p.face && !faceFailed ? (
            <>
              <clipPath id={clip}><circle cx={w / 2} cy={h / 2} r={AVATAR_R} /></clipPath>
              <image href={p.face} x={w / 2 - AVATAR_R} y={h / 2 - AVATAR_R} width={AVATAR_R * 2} height={AVATAR_R * 2} clipPath={`url(#${clip})`} onError={() => setFaceFailed(true)} />
            </>
          ) : <text className="hfy-poster__initials" textAnchor="middle" x={w / 2} y={h / 2 + 6} fontSize={NAME_UNITS}>{p.initials}</text>}
        </g>
      )}
      {p.badge ? (
        <g className="hfy-poster__badge" data-badge aria-hidden="true">
          <rect x={w - 138} y={-12} width={134} height={24} rx={12} />
          <text x={w - 71} y={5} textAnchor="middle" fontSize={NAME_UNITS}>also ancestor</text>
        </g>
      ) : null}
    </g>
  );
}

/** One connected group: an <svg> at one pixel per layout unit that measures the scale it is shown at. */
function Group({ c, count, card, names, onOpen, onHot }) {
  const ref = useRef(null);
  const [scale, setScale] = useState(1);
  useEffect(() => {
    const el = ref.current;
    if (!el || typeof ResizeObserver !== "function") return undefined;
    const measure = () => { const w = el.getBoundingClientRect().width; if (w > 0) setScale(w / c.width); };
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    measure();
    return () => ro.disconnect();
  }, [c.width]);
  const showNames = names && showsName(scale);
  // Reading and Tab order: top to bottom, then left to right.
  const people = useMemo(() => [...c.people].sort((a, b) => a.y - b.y || a.x - b.x || (a.id < b.id ? -1 : 1)), [c.people]);
  return (
    <figure className="hfy-poster__group" role="group" aria-label={`family group ${c.index + 1} of ${count}, ${c.people.length} ${c.people.length === 1 ? "person" : "people"}`} data-poster-group={c.index}>
      <svg ref={ref} className="hfy-poster__svg" viewBox={`0 0 ${c.width} ${c.height}`} width={c.width} height={c.height} data-scale={scale.toFixed(3)} data-names={showNames ? "on" : "off"} focusable="false">
        <g className="hfy-poster__links" aria-hidden="true">
          {c.links.map((l) => <path key={l.key} className="hfy-poster__link" d={l.d} fill="none" />)}
        </g>
        <g className="hfy-poster__unions" aria-hidden="true">
          {c.unions.map((u) => <circle key={u.id} className="hfy-poster__union" cx={u.x} cy={u.y} r={UNION_R} data-union={u.id} />)}
        </g>
        {people.map((p) => <Card key={p.id} p={p} w={card[0]} h={card[1]} names={showNames} onOpen={onOpen} onHot={onHot} />)}
      </svg>
    </figure>
  );
}

/**
 * The whole-family view. `onOpen(id)` opens the navigator on that person. `viewer` (the member's Gramps id, or null) is who "your ancestor"
 * means. Draws nothing and says nothing when the graph has no usable layout block (the page does not even load this chunk then).
 */
export default function BigTree({ graph, viewer = null, onOpen }) {
  const model = useMemo(() => posterModel(graph, viewer), [graph, viewer]);
  const [hot, setHot] = useState(null);
  const onHot = useCallback((id) => setHot(id), []);
  if (!model) return null;
  const byId = new Map(model.components.flatMap((c) => c.people).map((p) => [p.id, p]));
  const h = hot ? byId.get(hot) : null;
  return (
    <section className="hfy-poster" aria-labelledby="hfy-poster-title" data-tree-poster>
      <h2 id="hfy-poster-title" className="hfy-poster__title">the whole family</h2>
      <p className="hfy-poster__label" data-poster-label>
        {h ? <><PersonName id={h.id} name={h.name} /> <span className="hfy-tree__dim">{[h.years, h.badge].filter(Boolean).join(" · ")}</span></> : <span className="hfy-tree__dim">point at a card, or tab to it, to read the full name. choosing a card opens the family navigator on that person.</span>}
      </p>
      <div className="hfy-poster__scroll" role="region" aria-label="the whole family, scrolls sideways" tabIndex={0} data-poster-scroll>
        {model.components.map((c) => <Group key={c.index} c={c} count={model.components.length} card={model.card} names onOpen={onOpen} onHot={onHot} />)}
      </div>
      {model.notShown ? <p className="hfy-tree__dim" data-poster-notshown>{model.notShown} {model.notShown === 1 ? "person has" : "people have"} no recorded relatives yet, so they are left off this view. the outline lists everyone.</p> : null}
    </section>
  );
}
