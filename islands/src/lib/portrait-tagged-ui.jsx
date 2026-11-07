// The "use a photo I'm tagged in" pieces of the portrait control (HFY-TSK-408; flag portraitV1, host island only): the choice step, the picker of the photos a person
// is tagged in, and the square crop that starts on their tag box. The look is the kit's media.css plus person-portrait.css; the crop is the kit's SquareCrop with one
// difference the kit cannot give (its start square is not a prop): the same helpers (@io-kit/media/portrait), the same markup, a start square from the tag box.
import { useEffect, useRef, useState } from "react";
import { NUDGES, PORTRAIT_COPY, clampSquare, describeSquare, dragBy, gridSize, heightFor, initialSquare, nudgeSquare, toRect } from "@io-kit/media/portrait";
import { COPY, measureImage, photoLabel, tagSquare } from "./person-media-model.js";

const KEYS = { ArrowLeft: "left", ArrowRight: "right", ArrowUp: "up", ArrowDown: "down", "-": "smaller", "+": "larger", "=": "larger" };

/** The choice step: an inline panel under the portrait button. Upload is the existing path (the caller opens the file chooser from this click). */
export function ChoosePanel({ mode, onUpload, onTagged, onCancel }) {
  const first = useRef(null);
  useEffect(() => { first.current?.focus(); }, []);
  return (
    <div className="hfy-pp-sheet" role="group" aria-label={COPY.chooseTitle} data-pp="choose" onKeyDown={(e) => { if (e.key === "Escape") { e.preventDefault(); e.stopPropagation(); onCancel(); } }}>
      <button ref={first} type="button" className="io-media-btn hfy-pp__btn" onClick={onUpload} data-pp="upload">{COPY.upload}</button>
      <button type="button" className="io-media-btn hfy-pp__btn" onClick={onTagged} data-pp="tagged">{mode === "other" ? COPY.taggedOther : COPY.taggedOwn}</button>
      <button type="button" className="io-media-btn hfy-pp__btn" onClick={onCancel} data-pp="choose-cancel">{COPY.cancel}</button>
    </div>
  );
}

/**
 * The photos `personId` is tagged in, as a grid of s320 thumbnails with "show more". `browse` is the hfy-media-browse adapter; `cache` is a ref that keeps the loaded list
 * while the member is in the crop and comes back. `onPick(photo)` gets {mediaId, id, url, width, height, tag, label}: the s800 thumbnail (the detail image when there is none) and its size.
 */
export function TaggedPicker({ personId, mode, browse, cache, onPick, onBack, onUpload }) {
  const heading = useRef(null);
  const [state, setState] = useState(() => (cache.current && cache.current.personId === personId ? { status: "ready", ...cache.current } : { status: "loading", cards: [], next: null }));
  const [busy, setBusy] = useState(null); // the card being opened
  const [problem, setProblem] = useState(null);
  const [more, setMore] = useState(false);

  async function load(cursor) {
    setProblem(null);
    if (cursor) setMore(true); else setState({ status: "loading", cards: [], next: null });
    try {
      const page = await browse.listMedia({ section: "media", filter: "all", person: personId, cursor, limit: 24 });
      setState((s) => {
        const have = new Set(cursor ? s.cards.map((c) => c.mediaId) : []);
        const next = { personId, cards: [...(cursor ? s.cards : []), ...page.cards.filter((c) => !have.has(c.mediaId))], next: page.nextCursor };
        cache.current = next;
        return { status: "ready", ...next };
      });
    } catch {
      if (cursor) setProblem(COPY.listFailed); else setState({ status: "error", cards: [], next: null });
    } finally {
      setMore(false);
    }
  }
  useEffect(() => { if (state.status === "loading") void load(); /* once */ }, []); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => { heading.current?.focus(); }, []);

  async function open(card) {
    if (busy) return;
    setBusy(card.mediaId);
    setProblem(null);
    try {
      const d = await browse.getMedia(card.mediaId, { section: "media" });
      const t = d.card.thumb;
      const url = t?.s800 ?? d.imageUrl;
      let width = t?.w || d.card.width || card.width;
      let height = t?.h || d.card.height || card.height;
      if (!url) throw new Error("no image");
      if (!width || !height) ({ w: width, h: height } = await measureImage(url));
      const tag = d.tags.find((x) => x.personId === personId && Array.isArray(x.rect));
      onPick({ id: card.mediaId, url, width, height, rect: tag ? tag.rect : null, label: photoLabel(card) });
    } catch {
      setProblem(COPY.openFailed);
      setBusy(null);
    }
  }

  const title = mode === "other" ? COPY.pickTitleOther : COPY.pickTitleOwn;
  return (
    <div className="hfy-pp-picker" data-pp="picker">
      <h2 ref={heading} tabIndex={-1} className="hfy-pp-title">{title}</h2>
      {state.status === "loading" && <p className="io-media-hint" role="status" data-pp="loading">{COPY.loading}</p>}
      {state.status === "error" && (
        <>
          <p className="io-media-banner io-media-banner-error" role="alert" data-pp="list-error">{COPY.listFailed}</p>
          <button type="button" className="io-media-btn hfy-pp__btn" onClick={() => void load()} data-pp="retry">{COPY.retry}</button>
        </>
      )}
      {state.status === "ready" && state.cards.length === 0 && (
        <>
          <p className="io-media-hint" role="status" data-pp="empty">{COPY.empty}</p>
          <button type="button" className="io-media-btn hfy-pp__btn" onClick={onUpload} data-pp="empty-upload">{COPY.upload}</button>
        </>
      )}
      {state.status === "ready" && state.cards.length > 0 && (
        <ul className="hfy-pp-grid" data-pp="grid">
          {state.cards.map((c) => (
            <li key={c.mediaId}>
              <button type="button" className="hfy-pp-cell" aria-label={photoLabel(c)} aria-busy={busy === c.mediaId ? "true" : undefined} disabled={busy !== null && busy !== c.mediaId} onClick={() => void open(c)} data-pp="cell" data-media={c.mediaId}>
                <img src={c.thumb?.s320 ?? c.thumbUrl} alt="" loading="lazy" />
              </button>
            </li>
          ))}
        </ul>
      )}
      {problem && <p className="io-media-banner io-media-banner-error" role="alert" data-pp="pick-error">{problem}</p>}
      {state.status === "ready" && state.next && (
        <button type="button" className="io-media-btn hfy-pp__btn" disabled={more} onClick={() => void load(state.next)} data-pp="more">{COPY.showMore}</button>
      )}
      <div className="io-media-actions">
        <button type="button" className="io-media-btn hfy-pp__btn" onClick={onBack} data-pp="picker-back">{COPY.back}</button>
      </div>
    </div>
  );
}

/** The kit's SquareCrop, started on `start` (a SquareState from tagSquare) and ending in "save" and "back"; a failed save stays here with the retry copy. */
export function TaggedCrop({ photo, unit, onSave, onBack }) {
  const dims = { imageWidth: photo.width, imageHeight: photo.height, unit };
  const g = gridSize(unit);
  const [sq, setSq] = useState(() => tagSquare(photo.rect, dims) ?? initialSquare(dims));
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState(null);
  const stage = useRef(null);
  const drag = useRef(null);
  const label = describeSquare(sq, dims);
  const c = clampSquare(sq, dims);
  const down = (e) => {
    const r = stage.current?.getBoundingClientRect();
    if (!r || !r.width || !r.height) return;
    drag.current = { px: e.clientX, py: e.clientY, s: sq, w: r.width, h: r.height };
    e.currentTarget.setPointerCapture?.(e.pointerId);
  };
  const move = (e) => {
    const d = drag.current;
    if (d) setSq(dragBy(d.s, Math.round(((e.clientX - d.px) / d.w) * g), Math.round(((e.clientY - d.py) / d.h) * g), dims));
  };
  const key = (e) => {
    const k = KEYS[e.key];
    if (!k) return;
    e.preventDefault();
    setSq((s) => nudgeSquare(s, k, dims));
  };
  async function save() {
    if (busy) return;
    setBusy(true);
    setFailed(null);
    try {
      await onSave(toRect(c, dims));
    } catch (e) {
      setFailed(e?.code === "INVALID_RECT" ? COPY.tooSmall : COPY.saveFailed);
      setBusy(false);
    }
  }
  return (
    <section className="io-media io-media-crop-screen" aria-label={PORTRAIT_COPY.cropHint} data-pp="tagged-crop">
      <div ref={stage} className="io-media-crop-stage" style={{ aspectRatio: `${photo.width} / ${photo.height}` }}>
        <img className="io-media-crop-img" src={photo.url} alt="" draggable={false} />
        <div className="io-media-crop" role="group" tabIndex={0} aria-label={label}
          style={{ left: `${(c.x / g) * 100}%`, top: `${(c.y / g) * 100}%`, width: `${(c.w / g) * 100}%`, height: `${(heightFor(c.w, dims) / g) * 100}%` }}
          onPointerDown={down} onPointerMove={move} onPointerUp={() => { drag.current = null; }} onPointerCancel={() => { drag.current = null; }} onKeyDown={key} />
      </div>
      <p className="io-media-hint">{PORTRAIT_COPY.cropHint}</p>
      <p className="io-media-sr" role="status">{label}</p>
      <div className="io-media-nudges">
        {NUDGES.map((k) => <button key={k} type="button" className="io-media-btn io-media-nudge" disabled={busy} onClick={() => setSq((s) => nudgeSquare(s, k, dims))}>{PORTRAIT_COPY[k]}</button>)}
      </div>
      {failed && <p className="io-media-banner io-media-banner-error" role="alert" data-pp="save-error">{failed}</p>}
      <div className="io-media-actions">
        <button type="button" className="io-media-btn io-media-btn-primary" disabled={busy} onClick={() => void save()} data-pp="save">{busy ? COPY.saving : COPY.save}</button>
        <button type="button" className="io-media-btn" disabled={busy} onClick={onBack} data-pp="crop-back">{COPY.back}</button>
      </div>
    </section>
  );
}
