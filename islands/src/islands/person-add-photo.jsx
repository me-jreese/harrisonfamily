// "add a photo" in the person page's photos section (HFY-TSK-388-0A pass 3, flag mediaAddV1; BRD 5.4, D-05, D-09, D-12; board B8). A signed-in member opens the kit's
// AddPhotoFlow in place: pick (choose or take a photo), a form (title, year with "about", what's happening), upload and commit through the HFY adapter, then "tag people
// now?". The new Media is appended to the person's photos, never made the portrait. On someone else's page a banner says who looks first and the photo is a proposal.
// Signed out: no control. The "tag people" link goes to the person's photos on this page (the photo tag editor opens from a photo in its lightbox; the /all-media/ page
// does not exist yet). The host ([data-slot="add-photo"]) sits before the photo grid, outside the markup the page rebuilds.
import "@io-kit/media/media.css";
import "./person-add-photo.css";
import { useEffect, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import { AddPhotoFlow, ITEM_COPY } from "@io-kit/media/item";
import { getMe } from "../lib/me.js";
import { createHfyMediaSource } from "../lib/hfy-media-source.js";
import { CONTACT, COPY, REVIEWER, tagHref, viewerMode } from "../lib/person-media-model.js";

const source = createHfyMediaSource();

export function PersonAddPhoto({ personId }) {
  const [mode, setMode] = useState(null);
  const [open, setOpen] = useState(false);
  const btn = useRef(null);
  const panel = useRef(null);
  const back = useRef(false);
  useEffect(() => { let live = true; getMe().then((m) => { if (live) setMode(viewerMode(m.id, personId)); }); return () => { live = false; }; }, [personId]);
  useEffect(() => {
    if (open) panel.current?.focus();
    else if (back.current) { back.current = false; btn.current?.focus(); }
  }, [open]);
  if (!mode) return null;
  return (
    <div className="hfy-ap io-media" data-ap="block">
      {!open ? (
        <button ref={btn} type="button" className="io-media-btn hfy-ap__btn" onClick={() => setOpen(true)} data-ap="open">{ITEM_COPY.add}</button>
      ) : (
        <section ref={panel} tabIndex={-1} className="hfy-ap__panel" aria-label={ITEM_COPY.add} data-ap="panel">
          <AddPhotoFlow source={source} subject={personId} reviewer={mode === "other" ? REVIEWER : undefined} contact={CONTACT} tagHref={tagHref(personId)} />
          <button type="button" className="io-media-btn hfy-ap__btn" onClick={() => { back.current = true; setOpen(false); }} data-ap="close">{COPY.close}</button>
        </section>
      )}
    </div>
  );
}

let mounted = null; // { host, root, personId }

function fill(personId) {
  const grid = document.getElementById("person-media-grid");
  if (!personId || !grid) return;
  let host = document.querySelector('[data-slot="add-photo"]');
  if (!host) {
    host = document.createElement("div");
    host.setAttribute("data-slot", "add-photo");
    host.className = "hfy-ap-host";
    grid.insertAdjacentElement("beforebegin", host);
  }
  if (!mounted || mounted.host !== host || !host.isConnected) {
    if (mounted) { try { mounted.root.unmount(); } catch { /* the old host is gone */ } }
    mounted = { host, root: createRoot(host), personId };
  }
  mounted.root.render(<PersonAddPhoto personId={personId} />);
}

document.addEventListener("hfy:person-rendered", (e) => e.detail && fill(e.detail.personId));
(function initial() {
  const id = new URLSearchParams(location.search).get("id");
  if (!id) return;
  setTimeout(() => {
    if (mounted) return;
    fetch(`/person/${encodeURIComponent(id)}.json`, { credentials: "same-origin" }).then((r) => (r.ok ? r.json() : null)).then((p) => { if (p && !mounted) fill(id); }, () => {});
  }, 0);
})();
