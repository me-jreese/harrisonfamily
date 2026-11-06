// The shipped photo tag editor (HFY-TSK-260, flag photoTagEdit) hosted on the media detail page (HFY-TSK-388-0B; BRD D-40: until W3 the detail page hosts the
// shipped editor, and task 388-0G swaps it for @io-kit/media/tags). The editor itself is unchanged: this wrapper only gives it what the person page's lightbox
// gives it, a `detail` of { index, media: { handle, tags: [{ grampsId, name, rect }] }, img, box } where `img` is the stage's picture and `box` the stage that
// the editing layer is portaled into, and the signed-in member from /api/me. The tags and the Gramps handle come from getMedia. After a save that applied now
// the editor announces `hfy:tags-edited`; the host then re-reads the item (the kit's `reload`) so the list and the version are current.
import "../photo-tag-edit.css";
import { useEffect, useMemo, useRef, useState } from "react";
import { getMe } from "./me.js";
import { TAG_COPY, canUseTagEditor } from "./photo-tag-edit.js";
import { TagEditor } from "./photo-tag-edit-ui.jsx";

/** The editor's tags from the kit's: the person id is the Gramps id the editor addresses, the name is already redacted for a living person. */
export const editorTags = (tags) => (Array.isArray(tags) ? tags : []).map((t) => ({ grampsId: t.personId, name: t.person?.displayName ?? "", rect: t.rect ? [...t.rect] : null }));

export function MediaTagEditorHost({ detail, reload, enabled }) {
  const [me, setMe] = useState(undefined);
  const [on, setOn] = useState(false);
  const [parts, setParts] = useState(null);
  const button = useRef(null);
  useEffect(() => {
    let live = true;
    if (enabled) getMe().then((m) => { if (live) setMe(m || null); }, () => { if (live) setMe(null); });
    return () => { live = false; };
  }, [enabled]);
  useEffect(() => {
    const again = () => reload && reload();
    document.addEventListener("hfy:tags-edited", again);
    return () => document.removeEventListener("hfy:tags-edited", again);
  }, [reload]);
  const media = useMemo(() => (detail.handle ? { handle: detail.handle, tags: editorTags(detail.tags) } : null), [detail.handle, detail.version]);
  // The stage and its picture are the kit's: found from the page, once the member turns tagging on.
  useEffect(() => {
    if (!on) { setParts(null); return; }
    const box = document.querySelector(".io-media-detail .io-media-stage");
    const img = box && box.querySelector("img");
    setParts(box && img ? { box, img } : null);
  }, [on, detail.version]);
  if (!enabled || !media || !canUseTagEditor(me)) return null;
  return (
    <section className="hfy-mb-edit" data-media-edit>
      <button ref={button} type="button" className="hfy-mb-edit__toggle" aria-pressed={on ? "true" : "false"} onClick={() => setOn((v) => !v)}>{TAG_COPY.toggle}</button>
      {on && parts && <TagEditor key={detail.version} detail={{ index: 0, media, img: parts.img, box: parts.box }} me={me} person={null} />}
    </section>
  );
}
