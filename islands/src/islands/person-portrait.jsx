// The portrait control on the person page (HFY-TSK-388-0A pass 3, flag portraitV1; BRD 5.3, D-09, D-11, D-12; board B7). A signed-in member sees "change photo" (or "add a
// photo") on their OWN record and "suggest a photo" on anyone else's; signed out, nothing. The flow is the kit's @io-kit/media pieces: pick, normalizePhotoDetailed in the
// browser (upright, no location or camera details, long edge <= 2560), SquareCrop on the 1% grid (a full-frame crop stores null), upload through the HFY adapter
// (lib/hfy-media-source.js) and one set-portrait submission. The previous portrait stays in the gallery. On someone else's page the end is a proposal: the sender alone sees
// the new photo dashed with "pending review". The hero is rebuilt on every render, so the host (a [data-slot="portrait"] block before the hero actions) is put back on each
// hfy:person-rendered and a finished preview is applied again.
import "@io-kit/media/media.css";
import "./person-portrait.css";
import { useEffect, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import { PORTRAIT_COPY, ProposalNotice, SquareCrop } from "@io-kit/media/portrait";
import { PHOTO_ACCEPT, PHOTO_COPY, UploadProgress, normalizePhotoDetailed } from "@io-kit/media/upload";
import { getMe } from "../lib/me.js";
import { createHfyMediaSource } from "../lib/hfy-media-source.js";
import { CONTACT, COPY, REVIEWER, savePortrait, viewerMode } from "../lib/person-media-model.js";

const source = createHfyMediaSource();
let preview = null; // { personId, url, pending }: the photo the member just chose, shown on the hero again after a re-render

function showPreview(p) {
  const box = document.querySelector("#person-hero .person-portrait");
  if (!box) return;
  let img = box.querySelector("img.person-photo");
  if (!img) {
    box.querySelector(".person-photo-placeholder")?.remove();
    img = document.createElement("img");
    img.className = "person-photo";
    img.alt = PORTRAIT_COPY.portrait;
    box.prepend(img);
  }
  img.removeAttribute("onerror");
  img.src = p.url;
  if (p.pending) box.setAttribute("data-hfy-pending", "");
  else box.removeAttribute("data-hfy-pending");
}

const focusables = (root) => [...root.querySelectorAll('button:not([disabled]), [href], input:not([disabled]):not([type="file"]), [tabindex]:not([tabindex="-1"])')];

export function PersonPortrait({ personId, person }) {
  const [mode, setMode] = useState(null);
  const [stage, setStage] = useState(() => (preview && preview.personId === personId ? { k: "done", ...preview } : { k: "idle" }));
  const input = useRef(null);
  const btn = useRef(null);
  const dlg = useRef(null);
  const back = useRef(false);
  useEffect(() => { let live = true; getMe().then((m) => { if (live) setMode(viewerMode(m.id, personId)); }); return () => { live = false; }; }, [personId]);
  useEffect(() => { if (stage.k === "done") showPreview(stage); }, [stage]);
  useEffect(() => {
    if (stage.k === "crop") dlg.current?.querySelector(".io-media-crop")?.focus();
    else if (back.current && btn.current) { back.current = false; btn.current.focus(); }
  }, [stage.k, mode]);

  async function pick(file) {
    try {
      const photo = await normalizePhotoDetailed(file);
      setStage({ k: "crop", photo, url: URL.createObjectURL(photo.file) });
    } catch {
      back.current = true;
      setStage({ k: "error", message: PHOTO_COPY.decode });
    }
  }
  async function save(photo, rect, url, prior) {
    const show = (entries) => setStage({ k: "saving", photo, rect, url, entries });
    show(prior ?? []);
    let r;
    try {
      r = await savePortrait({ source, personId, photo, rect, entries: prior, onChange: show });
    } catch {
      back.current = true;
      setStage({ k: "error", message: PHOTO_COPY.upload });
      return;
    }
    if (r.failed) return; // the last progress showed the failed entry with its "try again"
    preview = { personId, url, pending: r.pending };
    back.current = true;
    setStage({ k: "done", ...preview });
  }
  function cancel() { back.current = true; setStage({ k: "idle" }); }
  function trap(e) {
    if (e.key === "Escape") { e.preventDefault(); cancel(); return; }
    if (e.key !== "Tab" || !dlg.current) return;
    const items = focusables(dlg.current);
    if (items.length === 0) return;
    const first = items[0];
    const last = items[items.length - 1];
    if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
    else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
  }

  if (!mode) return null;
  const hasPhoto = Boolean(document.querySelector("#person-hero img.person-photo"));
  const label = mode === "other" ? COPY.suggest : hasPhoto ? PORTRAIT_COPY.change : PORTRAIT_COPY.add;
  const saving = stage.k === "saving";
  const failedLocation = saving && stage.entries.some((e) => e.state === "failed" && e.error === PHOTO_COPY.location);
  return (
    <div className="hfy-pp io-media" data-pp="block">
      {mode === "other" && stage.k !== "done" && !saving && <ProposalNotice reviewer={REVIEWER} />}
      {saving && <UploadProgress entries={stage.entries} contact={CONTACT} onRetry={() => void save(stage.photo, stage.rect, stage.url, stage.entries)} />}
      {failedLocation && <p className="io-media-banner io-media-banner-error" role="alert" data-pp="location">{PHOTO_COPY.location}</p>}
      {!saving && (
        <div className="hfy-pp__row">
          <button ref={btn} type="button" className="io-media-btn hfy-pp__btn" onClick={() => input.current?.click()} data-pp="open">{label}</button>
          {stage.k === "done" && stage.pending && <span className="io-media-pend" data-pp="pending">{PORTRAIT_COPY.pendingBadge}</span>}
        </div>
      )}
      <input ref={input} className="io-media-file" type="file" accept={PHOTO_ACCEPT} tabIndex={-1} aria-hidden="true" data-pp="file"
        onChange={(e) => { const f = e.target.files?.[0]; e.target.value = ""; if (f) void pick(f); }} />
      {stage.k === "done" && (mode === "other" && stage.pending
        ? <ProposalNotice reviewer={REVIEWER} sent />
        : <p className="io-media-hint" role="status" data-pp="done">{PORTRAIT_COPY.done}</p>)}
      {stage.k === "error" && <p className="io-media-banner io-media-banner-error" role="alert" data-pp="error">{stage.message}</p>}
      {stage.k === "crop" && (
        <div ref={dlg} className="hfy-pp-dialog" role="dialog" aria-modal="true" aria-label={COPY.cropTitle} data-pp="crop" onKeyDown={trap}>
          <SquareCrop imageUrl={stage.url} imageWidth={stage.photo.width} imageHeight={stage.photo.height} unit={source.rectUnit}
            onConfirm={(rect) => void save(stage.photo, rect, stage.url)} onCancel={cancel} />
        </div>
      )}
    </div>
  );
}

let mounted = null; // { host, root, personId }

function fill(personId, person) {
  if (!personId || !person) return;
  const hero = document.getElementById("person-hero");
  if (!hero) return;
  let host = hero.querySelector('[data-slot="portrait"]');
  if (!host) {
    host = document.createElement("div");
    host.setAttribute("data-slot", "portrait");
    host.className = "hfy-pp-host";
    const anchor = hero.querySelector('[data-slot="hero-actions"]');
    if (anchor) anchor.insertAdjacentElement("beforebegin", host);
    else hero.appendChild(host);
  }
  if (!mounted || mounted.host !== host || !host.isConnected) {
    if (mounted) { try { mounted.root.unmount(); } catch { /* the old hero is gone */ } }
    mounted = { host, root: createRoot(host), personId };
  }
  mounted.root.render(<PersonPortrait personId={personId} person={person} />);
}

document.addEventListener("hfy:person-rendered", (e) => e.detail && fill(e.detail.personId, e.detail.person));
// The loader can run after the first render: read the person once for that case. Nothing shows if it cannot be read.
(function initial() {
  const id = new URLSearchParams(location.search).get("id");
  if (!id) return;
  setTimeout(() => {
    if (mounted) return;
    fetch(`/person/${encodeURIComponent(id)}.json`, { credentials: "same-origin" }).then((r) => (r.ok ? r.json() : null)).then((p) => { if (p && !mounted) fill(id, p); }, () => {});
  }, 0);
})();
