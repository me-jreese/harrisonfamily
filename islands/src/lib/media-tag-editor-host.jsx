// The media detail page's "tag people" entry (HFY-TSK-388-0G pass 2; BRD D-40: the detail page hosts the kit editor, @io-kit/media/tags, behind the flag
// photoTagEdit, on for io only, D-16). The MediaDetail slot renderEditor renders this: a toggle for a signed-in member, and with it on the kit editor
// (lib/hfy-kit-tag-editor.jsx) in place of the photo and the page's own list (the editor draws the photo, the boxes and its own accessible list). Done re-reads
// the item (the slot's `reload`) so the page's list and overlay show what was saved.
import { useEffect, useRef, useState } from "react";
import { getMe } from "./me.js";
import { TAG_COPY, canUseTagEditor } from "./photo-tag-edit.js";
import { HfyTagEditor } from "./hfy-kit-tag-editor.jsx";

export function MediaTagEditorHost({ detail, reload, enabled }) {
  const [me, setMe] = useState(undefined);
  const [on, setOn] = useState(false);
  const button = useRef(null);
  useEffect(() => {
    let live = true;
    if (enabled) getMe().then((m) => { if (live) setMe(m || null); }, () => { if (live) setMe(null); });
    return () => { live = false; };
  }, [enabled]);
  // While the editor is open the page's photo, overlay and list give way to it (CSS keyed on this attribute).
  useEffect(() => {
    const root = document.querySelector(".io-media-detail");
    if (!root) return undefined;
    if (on) root.setAttribute("data-hfy-tagging", ""); else root.removeAttribute("data-hfy-tagging");
    return () => root.removeAttribute("data-hfy-tagging");
  }, [on]);
  if (!enabled || !detail.handle || !canUseTagEditor(me)) return null;
  const close = () => { setOn(false); if (reload) reload(); setTimeout(() => button.current && button.current.focus(), 0); };
  return (
    <section className="hfy-tag-host" data-media-edit>
      <button ref={button} type="button" className="hfy-tag-toggle" aria-pressed={on ? "true" : "false"} onClick={() => (on ? close() : setOn(true))}>{TAG_COPY.toggle}</button>
      {on && <HfyTagEditor mediaId={detail.card.mediaId} onClose={close} />}
    </section>
  );
}
