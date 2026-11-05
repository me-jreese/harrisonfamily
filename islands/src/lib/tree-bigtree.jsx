// The lazy poster chunk of /tree/ (HFY-TSK-272, viz-v2-bigtree, flag familyVizBigTree; viz ADR 4.5 and 4.7): the `layout` block of graph.json
// drawn as SVG, one figure per connected group of people. Person cards are buttons that open the navigator (tree.jsx re-centres and shows the
// cards view), union nodes are small connectors, and the links are elbows from the coordinates and bend points. There is no layout code here
// (lib/bigtree-model.js only reads the block) and no d3-dag. Navigation (HFY-TSK-309, viz-v2-bigtree-nav): zoom in, zoom out, fit and "reset to me"
// buttons and a minimap each do what a gesture does (Ctrl or Cmd with the wheel zooms, a mouse drag pans, the region scrolls). A plain wheel only
// scrolls, touch is left to the page (touch-action: pan-x pan-y), and Tab moves between cards with the focused card scrolled into view.
//
// Names are never drawn below MIN_NAME_PX (16 px). Each figure measures the scale it is really drawn at (the width it is shown at over the width
// of its layout) and, where a name would be smaller than that, the card shows its face or initials only. The full name stays in the accessible
// name, and the hover or focus label under the heading (PersonName, P2-R46: names outside the SVG link to the person).
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { NAME_UNITS, UNION_R, posterModel, showsName } from "./bigtree-model.js";
import { PersonName } from "./person-name.jsx";

const AVATAR_R = 24;
export const MIN_ZOOM = 0.05;
export const MAX_ZOOM = 2;
export const ZOOM_STEP = 1.25;
const DRAG_PX = 4;
const clampZoom = (z) => Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, z));

function Card({ p, index, w, h, names, onOpen, onHot }) {
  const [faceFailed, setFaceFailed] = useState(false);
  const open = () => onOpen(p.id);
  const lines = p.lines;
  const clip = `hfy-poster-clip-${String(p.id).replace(/[^A-Za-z0-9_-]/g, "_")}-${index}`;
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
          <rect x={w - 138} y={4} width={134} height={24} rx={12} />
          <text x={w - 71} y={21} textAnchor="middle" fontSize={NAME_UNITS}>also ancestor</text>
        </g>
      ) : null}
    </g>
  );
}

/** One connected group: an <svg> at one pixel per layout unit that measures the scale it is shown at. */
function Group({ c, count, card, names, zoom, onOpen, onHot }) {
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
  }, [c.width, zoom]);
  const showNames = names && showsName(scale);
  // Reading and Tab order: top to bottom, then left to right.
  const people = useMemo(() => [...c.people].sort((a, b) => a.y - b.y || a.x - b.x || (a.id < b.id ? -1 : 1)), [c.people]);
  return (
    <figure className="hfy-poster__group" role="group" aria-label={`family group ${c.index + 1} of ${count}, ${c.people.length} ${c.people.length === 1 ? "person" : "people"}`} data-poster-group={c.index}>
      <svg ref={ref} className="hfy-poster__svg" viewBox={`0 0 ${c.width} ${c.height}`} width={c.width * zoom} height={c.height * zoom} data-scale={scale.toFixed(3)} data-names={showNames ? "on" : "off"} focusable="false">
        <g className="hfy-poster__links" aria-hidden="true">
          {c.links.map((l) => <path key={l.key} className="hfy-poster__link" d={l.d} fill="none" />)}
        </g>
        <g className="hfy-poster__unions" aria-hidden="true">
          {c.unions.map((u) => <circle key={u.id} className="hfy-poster__union" cx={u.x} cy={u.y} r={UNION_R} data-union={u.id} />)}
        </g>
        {people.map((p) => <Card key={p.id} p={p} index={c.index} w={card[0]} h={card[1]} names={showNames} onOpen={onOpen} onHot={onHot} />)}
      </svg>
    </figure>
  );
}

const pct = (z) => `${Math.round(z * 100)}%`;

/** The minimap: every card as a small box on the whole poster, the visible part framed. Press or drag on it to move the view there. */
function Minimap({ geo, view, onGo }) {
  const ref = useRef(null);
  const drag = useRef(false);
  const go = (e) => {
    const r = ref.current.getBoundingClientRect();
    if (!r.width || !r.height || !geo.w || !geo.h) return;
    // The drawing is letterboxed (xMinYMin meet) when the element is capped in height: map with the drawn scale, not the element box.
    const k = Math.min(r.width / geo.w, r.height / geo.h);
    onGo((e.clientX - r.left) / k, (e.clientY - r.top) / k);
  };
  return (
    <div className="hfy-poster__mini" role="group" aria-label="minimap of the whole family: press or drag to move there" data-poster-mini>
      <svg
        ref={ref}
        className="hfy-poster__minisvg"
        viewBox={`0 0 ${geo.w || 1} ${geo.h || 1}`}
        preserveAspectRatio="xMinYMin meet"
        aria-hidden="true"
        focusable="false"
        onPointerDown={(e) => { if (e.button !== 0) return; drag.current = true; e.currentTarget.setPointerCapture?.(e.pointerId); go(e); }}
        onPointerMove={(e) => { if (drag.current) go(e); }}
        onPointerUp={() => { drag.current = false; }}
        onPointerCancel={() => { drag.current = false; }}
      >
        {geo.cards.map((c) => <rect key={c.id} className="hfy-poster__minicard" x={c.x} y={c.y} width={c.w} height={c.h} />)}
        <rect className="hfy-poster__miniview" x={view.x} y={view.y} width={view.w} height={view.h} data-poster-miniview />
      </svg>
    </div>
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
  const [zoom, setZoomState] = useState(1);
  const zoomRef = useRef(1);
  const pending = useRef(null);
  const raf = useRef(0);
  const later = useCallback((fn) => { cancelAnimationFrame(raf.current); raf.current = requestAnimationFrame(fn); }, []);
  useEffect(() => () => cancelAnimationFrame(raf.current), []);
  const scrollRef = useRef(null);
  const [geo, setGeo] = useState({ w: 0, h: 0, cards: [] });
  const [view, setView] = useState({ x: 0, y: 0, w: 0, h: 0 });

  const readView = useCallback(() => {
    const el = scrollRef.current;
    if (el) setView({ x: el.scrollLeft, y: el.scrollTop, w: el.clientWidth, h: el.clientHeight });
  }, []);

  // Zoom to z, keeping the point under (ax, ay) (region coordinates) where it is. The scroll is fixed up once the new size is laid out.
  const zoomTo = useCallback((z, ax, ay) => {
    const el = scrollRef.current;
    const z1 = clampZoom(z);
    const z0 = zoomRef.current;
    if (!el || z1 === z0) return;
    const prev = pending.current;
    pending.current = { ax: ax ?? el.clientWidth / 2, ay: ay ?? el.clientHeight / 2, left: prev ? prev.left : el.scrollLeft, top: prev ? prev.top : el.scrollTop, r: (prev ? prev.r : 1) * (z1 / z0) };
    zoomRef.current = z1;
    setZoomState(z1);
  }, []);
  useLayoutEffect(() => {
    const el = scrollRef.current;
    const p = pending.current;
    pending.current = null;
    if (el && p) {
      el.scrollLeft = (p.left + p.ax) * p.r - p.ax;
      el.scrollTop = (p.top + p.ay) * p.r - p.ay;
    }
  }, [zoom]);

  // Geometry for the minimap: where each figure sits in the scrolled content, and each card within it.
  const measure = useCallback(() => {
    const el = scrollRef.current;
    if (!el || !model) return;
    const cards = [];
    el.querySelectorAll("[data-poster-group]").forEach((fig) => {
      const c = model.components[Number(fig.dataset.posterGroup)] || model.components.find((x) => String(x.index) === fig.dataset.posterGroup);
      if (!c) return;
      for (const p of c.people) cards.push({ id: p.id, x: fig.offsetLeft + (p.x - model.card[0] / 2) * zoomRef.current, y: fig.offsetTop + (p.y - model.card[1] / 2) * zoomRef.current, w: model.card[0] * zoomRef.current, h: model.card[1] * zoomRef.current });
    });
    setGeo({ w: el.scrollWidth, h: el.scrollHeight, cards });
    readView();
  }, [model, readView]);
  useLayoutEffect(() => { measure(); }, [measure, zoom]);
  useEffect(() => {
    const el = scrollRef.current;
    if (!el || typeof ResizeObserver !== "function") return undefined;
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, [measure]);

  // Ctrl or Cmd with the wheel zooms about the pointer; a plain wheel is left to scroll the region (and the page at its ends).
  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return undefined;
    const onWheel = (e) => {
      if (!(e.ctrlKey || e.metaKey)) return;
      e.preventDefault();
      const r = el.getBoundingClientRect();
      zoomTo(zoomRef.current * Math.exp(-Math.max(-100, Math.min(100, e.deltaY)) / 200), e.clientX - r.left, e.clientY - r.top);
    };
    el.addEventListener("wheel", onWheel, { passive: false });
    return () => el.removeEventListener("wheel", onWheel);
  }, [zoomTo, model]);

  const fit = useCallback(() => {
    const el = scrollRef.current;
    if (!el || !model) return;
    const cs = getComputedStyle(el);
    const inner = el.clientWidth - parseFloat(cs.paddingLeft || "0") - parseFloat(cs.paddingRight || "0");
    const widest = Math.max(...model.components.map((c) => c.width));
    zoomTo(inner / widest, 0, 0);
    el.scrollLeft = 0;
    el.scrollTop = 0;
    pending.current = pending.current && { ...pending.current, left: 0, top: 0, ax: 0, ay: 0 };
    later(() => { el.scrollLeft = 0; el.scrollTop = 0; readView(); });
  }, [model, zoomTo, readView, later]);

  // Back to the real size with the viewer's own card in the middle (the top left when the viewer is not on the poster).
  const reset = useCallback(() => {
    const el = scrollRef.current;
    if (!el) return;
    zoomRef.current = 1;
    pending.current = null;
    setZoomState(1);
    later(() => {
      const card = viewer ? el.querySelector(`[data-person="${String(viewer).replace(/["\\]/g, "")}"]`) : null;
      if (card) {
        const a = card.getBoundingClientRect();
        const r = el.getBoundingClientRect();
        el.scrollLeft += a.left + a.width / 2 - (r.left + r.width / 2);
        el.scrollTop += a.top + a.height / 2 - (r.top + r.height / 2);
      } else { el.scrollLeft = 0; el.scrollTop = 0; }
      readView();
    });
  }, [viewer, readView, later]);

  const goTo = useCallback((x, y) => {
    const el = scrollRef.current;
    if (!el) return;
    el.scrollLeft = x - el.clientWidth / 2;
    el.scrollTop = y - el.clientHeight / 2;
    readView();
  }, [readView]);

  // A mouse drag pans the region (a touch is never captured; a drag that moved is not a click on a card).
  const drag = useRef(null);
  const onPointerDown = (e) => {
    if (e.pointerType !== "mouse" || e.button !== 0) return;
    const el = scrollRef.current;
    el.dataset.pressing = "true";
    drag.current = { x: e.clientX, y: e.clientY, left: el.scrollLeft, top: el.scrollTop, moved: false, id: e.pointerId };
  };
  const onPointerMove = (e) => {
    const d = drag.current;
    if (!d || e.pointerId !== d.id) return;
    const el = scrollRef.current;
    if (!d.moved && Math.hypot(e.clientX - d.x, e.clientY - d.y) < DRAG_PX) return;
    if (!d.moved) { d.moved = true; el.setPointerCapture?.(e.pointerId); el.dataset.panning = "true"; }
    el.scrollLeft = d.left - (e.clientX - d.x);
    el.scrollTop = d.top - (e.clientY - d.y);
  };
  const endDrag = (e) => {
    const d = drag.current;
    if (!d || e.pointerId !== d.id) return;
    drag.current = null;
    const el = scrollRef.current;
    delete el.dataset.panning;
    delete el.dataset.pressing;
    if (d.moved) { el.releasePointerCapture?.(e.pointerId); const eat = (ev) => { ev.stopPropagation(); ev.preventDefault(); }; el.addEventListener("click", eat, { capture: true, once: true }); setTimeout(() => el.removeEventListener("click", eat, true), 0); }
  };

  // The focused card is scrolled into view (Tab order is top to bottom, then left to right).
  const onFocus = (e) => {
    const card = e.target.closest?.("[data-person]");
    const el = scrollRef.current;
    if (!card || !el) return;
    const a = card.getBoundingClientRect();
    const r = el.getBoundingClientRect();
    const m = 16;
    if (a.left < r.left + m) el.scrollLeft -= r.left + m - a.left;
    else if (a.right > r.right - m) el.scrollLeft += a.right - (r.right - m);
    if (a.top < r.top + m) el.scrollTop -= r.top + m - a.top;
    else if (a.bottom > r.bottom - m) el.scrollTop += a.bottom - (r.bottom - m);
  };
  const onKeyDown = (e) => {
    if (e.target !== e.currentTarget || e.ctrlKey || e.metaKey || e.altKey) return;
    if (e.key === "+" || e.key === "=") { e.preventDefault(); zoomTo(zoomRef.current * ZOOM_STEP); }
    else if (e.key === "-") { e.preventDefault(); zoomTo(zoomRef.current / ZOOM_STEP); }
    else if (e.key === "0") { e.preventDefault(); reset(); }
  };

  if (!model) return null;
  const byId = new Map(model.components.flatMap((c) => c.people).map((p) => [p.id, p]));
  const h = hot ? byId.get(hot) : null;
  return (
    <section className="hfy-poster" aria-labelledby="hfy-poster-title" data-tree-poster>
      <h2 id="hfy-poster-title" className="hfy-poster__title">the whole family</h2>
      <p className="hfy-poster__label" data-poster-label>
        {h ? <><PersonName id={h.id} name={h.name} /> <span className="hfy-tree__dim">{[h.years, h.badge].filter(Boolean).join(" · ")}</span></> : <span className="hfy-tree__dim">point at a card, or tab to it, to read the full name. choosing a card opens the family navigator on that person.</span>}
      </p>
      <div className="hfy-poster__tools" role="group" aria-label="move around the whole family" data-poster-tools>
        <button type="button" className="hfy-poster__btn" data-poster-zoom-in aria-disabled={zoom >= MAX_ZOOM ? "true" : undefined} onClick={() => zoomTo(zoomRef.current * ZOOM_STEP)}>zoom in</button>
        <button type="button" className="hfy-poster__btn" data-poster-zoom-out aria-disabled={zoom <= MIN_ZOOM ? "true" : undefined} onClick={() => zoomTo(zoomRef.current / ZOOM_STEP)}>zoom out</button>
        <button type="button" className="hfy-poster__btn" data-poster-fit onClick={fit}>fit</button>
        <button type="button" className="hfy-poster__btn" data-poster-reset aria-label={viewer && byId.has(viewer) ? "reset to me: real size, centred on my card" : "reset: real size, back to the start"} onClick={reset}>reset to me</button>
        <output className="hfy-poster__zoom" aria-live="polite" data-poster-zoom>{pct(zoom)}</output>
      </div>
      <Minimap geo={geo} view={view} onGo={goTo} />
      <div
        ref={scrollRef}
        className="hfy-poster__scroll"
        role="region"
        aria-label="the whole family, scrolls in both directions. ctrl or cmd with the wheel zooms; + and - zoom, 0 resets"
        tabIndex={0}
        data-poster-scroll
        data-zoom={zoom.toFixed(3)}
        onScroll={readView}
        onFocus={onFocus}
        onKeyDown={onKeyDown}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={endDrag}
        onPointerCancel={endDrag}
      >
        {model.components.map((c) => <Group key={c.index} c={c} count={model.components.length} card={model.card} names zoom={zoom} onOpen={onOpen} onHot={onHot} />)}
      </div>
      {model.notShown ? <p className="hfy-tree__dim" data-poster-notshown>{model.notShown} {model.notShown === 1 ? "person has" : "people have"} no recorded relatives yet, so they are left off this view. the outline lists everyone.</p> : null}
    </section>
  );
}
