// The lazy faces tab of /tree/ (HFY-TSK-308, viz-v2-faces-tab, flag familyVizFaces; viz ADR 4.4, BRD2 R-22 and R-29): a mosaic of the builder's 160 px
// face crops grouped by `photoEdges` entry. Choosing a face highlights every photo that person is in. A person whose face is null (RECT_INVALID, a
// placeholder or missing media) shows initials, and so does a crop that fails to load: never a crop guessed from the region. Names are PersonName
// (P2-R46); the face itself is a button, so the name link sits beside it, not inside it.
//
// Opening a photo reads the gated person JSON of someone in it (the page's own source of mediaGallery[].tags[]) and hands the photo to
// surf-photo-tags-ui (lib/photo-tags-ui.js showLightbox): its tag display (containedRect, hover, tap, keyboard) draws the regions and the names list.
// This file has no region geometry. At most 24 faces are in the first view, each fetched only when it scrolls near (IntersectionObserver).
import { useEffect, useMemo, useRef, useState } from "react";
import { PersonName } from "./person-name.jsx";
import { clearLightbox, showLightbox } from "./photo-tags-ui.js";
import { FIRST_VIEW_FACES, TRY_PEOPLE, facePeople, facesGroups, firstViewCount, galleryItem, mediaOf, photoSrc } from "./faces-model.js";

let owner = null; // the viewer that drew the shared photo-tags display last; another host's display is never cleared by a viewer that unmounts later

export const COPY = {
  title: "faces",
  note: "choose a face to see every photo that person is in.",
  none: "no tagged photos are in the family tree yet.",
  photo: (n) => `photo ${n}`,
  people: (n) => (n === 1 ? "1 person" : `${n} people`),
  open: "open photo",
  close: "close photo",
  outline: "people in this photo",
  hits: (name, n) => `${name} is in ${n === 1 ? "1 photo" : `${n} photos`}.`,
  clear: "clear",
  more: "show more photos",
  loading: "loading the photo.",
  failed: "this photo didn't load.",
  showFace: (name) => `${name}, show their photos`
};

/** A face crop that loads when it nears the viewport; initials for a null face and for a crop that fails. */
function Crop({ person }) {
  const ref = useRef(null);
  const [src, setSrc] = useState(null);
  const [broken, setBroken] = useState(false);
  useEffect(() => {
    if (!person.face) return undefined;
    const el = ref.current;
    if (!el || typeof IntersectionObserver !== "function") { setSrc(person.face); return undefined; }
    const io = new IntersectionObserver((entries) => { if (entries.some((e) => e.isIntersecting)) { setSrc(person.face); io.disconnect(); } }, { rootMargin: "200px" });
    io.observe(el);
    return () => io.disconnect();
  }, [person.face]);
  if (!person.face || broken) return <span className="hfy-faces__initials" aria-hidden="true" data-faces-initials>{person.initials}</span>;
  return <span ref={ref} className="hfy-faces__lazy">{src ? <img className="hfy-faces__img" src={src} alt="" width={160} height={160} loading="lazy" decoding="async" onError={() => setBroken(true)} /> : null}</span>;
}

/** The photo, inline: the image and surf-photo-tags-ui's tag display on it. */
function Viewer({ group, fetcher }) {
  const wrap = useRef(null);
  const box = useRef(null);
  const [state, setState] = useState({ phase: "loading", item: null, src: null });
  const [outlined, setOutlined] = useState(false);
  useEffect(() => {
    let live = true;
    const ctl = new AbortController();
    (async () => {
      for (const p of group.people.slice(0, TRY_PEOPLE)) {
        try {
          const res = await fetcher(`/person/${encodeURIComponent(p.id)}.json`, { credentials: "same-origin", signal: ctl.signal });
          const data = res && res.ok ? await res.json() : null;
          const item = data && !data.mergedInto ? galleryItem(data, group.media) : null;
          const src = photoSrc(item);
          if (item && src) { if (live) setState({ phase: "ready", item, src }); return; }
        } catch { if (!live) return; }
      }
      if (live) setState({ phase: "failed", item: null, src: null });
    })();
    return () => { live = false; ctl.abort(); };
  }, [group, fetcher]);
  const mine = useRef({});
  useEffect(() => () => { if (owner === mine.current) { owner = null; clearLightbox(); } }, []);
  const img = useRef(null);
  // The photo's tag display is surf-photo-tags-ui's (an effect, not a ref callback: a child's ref is set before its parent's, so the box would not be there yet).
  useEffect(() => {
    if (state.phase === "ready" && img.current && box.current) owner = mine.current;
    if (state.phase === "ready" && img.current && box.current) showLightbox({ index: 0, media: state.item, img: img.current, box: box.current }, null);
  }, [state]);
  useEffect(() => {
    wrap.current?.querySelector(".photo-tags__layer")?.classList.toggle("photo-tags__layer--names", outlined);
  }, [outlined, state]);
  if (state.phase === "loading") return <p className="hfy-faces__status" role="status" data-faces-viewer-loading>{COPY.loading}</p>;
  if (state.phase === "failed") return <p className="hfy-faces__status" role="status" data-faces-viewer-failed>{COPY.failed}</p>;
  return (
    <div ref={wrap} className={`hfy-faces__viewer${outlined ? " hfy-faces__viewer--outlined" : ""}`} data-faces-viewer={group.media}>
      <div className="hfy-faces__bar">
        <button type="button" className="hfy-faces__outline" aria-pressed={outlined ? "true" : "false"} data-faces-outline onClick={() => setOutlined((v) => !v)}>{COPY.outline}</button>
      </div>
      <div className="hfy-faces__box" ref={box}>
        <img className="hfy-faces__photo" ref={img} src={state.src} alt={state.item.title || COPY.photo(group.index)} />
      </div>
    </div>
  );
}

function Group({ group, selected, hit, open, onFace, onToggle, fetcher }) {
  const heading = `hfy-faces-photo-${group.media}`;
  return (
    <li className="hfy-faces__group" data-faces-group={group.media} data-hit={hit ? "true" : "false"} aria-labelledby={heading}>
      <div className="hfy-faces__head">
        <h3 id={heading}>{COPY.photo(group.index)}</h3>
        <span className="hfy-faces__count">{COPY.people(group.people.length)}</span>
        <button type="button" className="hfy-faces__open" aria-expanded={open ? "true" : "false"} data-faces-open={group.media} onClick={() => onToggle(group.media)}>{open ? COPY.close : COPY.open}</button>
      </div>
      <ul className="hfy-faces__grid">
        {group.people.map((p) => (
          <li key={p.id} className="hfy-faces__face">
            <button type="button" className="hfy-faces__crop" aria-pressed={selected === p.id ? "true" : "false"} aria-label={COPY.showFace(p.name)} data-faces-face={p.id} onClick={() => onFace(p.id)}>
              <Crop person={p} />
            </button>
            <PersonName id={p.id} name={p.name} className="hfy-faces__name" />
          </li>
        ))}
      </ul>
      {open ? <Viewer group={group} fetcher={fetcher} /> : null}
    </li>
  );
}

/** How many groups must be rendered for every photo the person is in to be on screen. */
function revealCount(groups, id) {
  let last = 0;
  groups.forEach((g, i) => { if (g.people.some((p) => p.id === id)) last = i + 1; });
  return last;
}

export default function FacesTab({ graph, fetcher }) {
  const groups = useMemo(() => facesGroups(graph), [graph]);
  const first = useMemo(() => firstViewCount(groups, FIRST_VIEW_FACES), [groups]);
  const [shown, setShown] = useState(first);
  const [selected, setSelected] = useState(null);
  const [open, setOpen] = useState(null);
  const hits = useMemo(() => (selected ? mediaOf(groups, selected) : new Set()), [groups, selected]);
  const person = useMemo(() => facePeople(groups).find((p) => p.id === selected) || null, [groups, selected]);
  if (!groups.length) return <section className="hfy-faces" data-tree-faces><p className="hfy-faces__status" role="status" data-faces-none>{COPY.none}</p></section>;
  const visible = groups.slice(0, shown);
  return (
    <section className="hfy-faces" aria-labelledby="hfy-faces-title" data-tree-faces>
      <h2 id="hfy-faces-title" className="hfy-faces__title">{COPY.title}</h2>
      <p className="hfy-faces__note">{COPY.note}</p>
      <p className="hfy-faces__status" role="status" data-faces-status>{person ? COPY.hits(person.name, hits.size) : ""}</p>
      <ol className="hfy-faces__groups">
        {visible.map((g) => (
          <Group key={g.media} group={g} selected={selected} hit={hits.has(g.media)} open={open === g.media} fetcher={fetcher}
            onFace={(id) => { setSelected((cur) => (cur === id ? null : id)); setShown((n) => Math.max(n, revealCount(groups, id))); }} onToggle={(m) => setOpen((cur) => (cur === m ? null : m))} />
        ))}
      </ol>
      {groups.length > shown ? <button type="button" className="hfy-tree__view hfy-faces__more" data-faces-more onClick={() => setShown((n) => Math.min(groups.length, n + first))}>{COPY.more} ({groups.length - shown})</button> : null}
    </section>
  );
}
