// The person page's lightbox hosts the kit tag editor (HFY-TSK-388-0G pass 2; replaces the shipped editor of HFY-TSK-260, same flag photoTagEdit). The island
// (islands/photo-tag-edit.jsx) calls showTagEditor for every `hfy:lightbox-media` { index, media, img, box }: a "tag people" toggle in the lightbox for a
// signed-in member (and /api/me not saying editing is off), and with it on the kit editor (lib/hfy-kit-tag-editor.jsx) under the caption, addressing the photo by its
// Gramps id (media.grampsId). The lightbox photo and its overlay give way to the editor while it is open (the editor draws the photo and the boxes). After a save the
// photo's media.tags is read again from the server and `hfy:tags-edited` is announced, which the photo tags island redraws the overlay from.
import { createRoot } from "react-dom/client";
import { getMe } from "./me.js";
import { TAG_COPY, canUseTagEditor } from "./photo-tag-edit.js";
import { HfyTagEditor, tagKit } from "./hfy-kit-tag-editor.jsx";

let current = null; // { detail, me, modal } for the photo now shown
let toggle = null;
let panelHost = null;
let root = null;
let editing = false;
let watching = false;
let token = 0;

function unmountEditor() {
  if (root) { try { root.unmount(); } catch { /* already gone */ } root = null; }
  if (panelHost) { panelHost.remove(); panelHost = null; }
}

function setEditing(on, modal) {
  editing = on;
  if (toggle) toggle.setAttribute("aria-pressed", on ? "true" : "false");
  if (modal) modal.classList.toggle("photo-tag-edit-on", on);
}

const sameRect = (a, b) => JSON.stringify(a ?? null) === JSON.stringify(b ?? null);

/** The gallery tags of the photo from the server's read: the ones that are tags now (a proposal is not), keeping what the page already knew of each. */
async function refreshTags(detail) {
  const { media } = detail;
  try {
    const { tags, names } = await tagKit().source.readTags(media.grampsId);
    const old = Array.isArray(media.tags) ? media.tags : [];
    media.tags = tags.filter((t) => t.state === "applied").map((t) => {
      const known = old.find((o) => o.grampsId === t.personId && sameRect(o.rect, t.rect));
      return known || { grampsId: t.personId, name: (names[t.personId] && names[t.personId].displayName) || "someone", rect: t.rect, isPrimary: false, attributes: [], notes: [], citations: [] };
    });
    document.dispatchEvent(new CustomEvent("hfy:tags-edited", { detail }));
  } catch { /* the overlay keeps what it had */ }
}

function mountEditor() {
  unmountEditor();
  if (!editing || !current) return;
  const { detail } = current;
  const caption = document.getElementById("mediaLightboxCaption");
  const anchor = caption && caption.parentElement ? caption.parentElement : detail.box;
  panelHost = document.createElement("div");
  panelHost.className = "photo-tag-edit-host";
  anchor.after(panelHost);
  root = createRoot(panelHost);
  // The editor owns the arrow keys (move a box) and Escape (finish the edit): the lightbox must not take them for next photo or close.
  panelHost.addEventListener("keydown", (e) => { if (e.key.startsWith("Arrow") || e.key === "Escape") e.stopPropagation(); });
  const close = () => { setEditing(false, current && current.modal); unmountEditor(); if (toggle) toggle.focus(); };
  root.render(<HfyTagEditor key={`${detail.media.grampsId}:${detail.index}`} mediaId={detail.media.grampsId} onClose={close} onSaved={() => { void refreshTags(detail); }} />);
}

function ensureToggle(modal) {
  if (toggle && toggle.isConnected) return toggle;
  toggle = document.createElement("button");
  toggle.type = "button";
  toggle.className = "hfy-tag-toggle";
  toggle.textContent = TAG_COPY.toggle;
  toggle.setAttribute("aria-pressed", "false");
  toggle.hidden = true;
  toggle.addEventListener("click", () => {
    setEditing(!editing, current && current.modal);
    if (editing) mountEditor(); else unmountEditor();
  });
  const host = modal.querySelector(".lightbox-actions") || modal.querySelector(".modal-header");
  if (host) host.insertBefore(toggle, host.firstChild);
  return toggle;
}

/**
 * Called for every `hfy:lightbox-media` (detail: { index, media, img, box }). Shows the toggle when the viewer may tag, and, with tagging on, the editor for the
 * photo now shown. A photo without a Gramps id (a missing file) is not taggable.
 */
export async function showTagEditor(detail) {
  const mine = (token += 1);
  unmountEditor();
  const { media, img, box } = detail || {};
  const modal = (img && img.closest(".modal")) || document.getElementById("mediaLightbox");
  const me = await getMe();
  if (mine !== token) return;
  const ok = Boolean(modal && media && typeof media.grampsId === "string" && media.grampsId && img && box) && canUseTagEditor(me);
  if (!ok) {
    current = null;
    if (toggle) toggle.hidden = true;
    if (modal) modal.classList.remove("photo-tag-edit-available");
    return;
  }
  current = { detail, me, modal };
  ensureToggle(modal).hidden = false;
  modal.classList.add("photo-tag-edit-available");
  setEditing(editing, modal);
  if (!watching) {
    watching = true;
    modal.addEventListener("hidden.bs.modal", () => { token += 1; unmountEditor(); setEditing(false, modal); if (toggle) toggle.hidden = true; modal.classList.remove("photo-tag-edit-available"); current = null; });
    // The page hides the image (d-none) while the next photo loads: the editor must not float over the spinner.
    new MutationObserver(() => { if (current && current.detail.img.classList.contains("d-none")) { token += 1; unmountEditor(); } }).observe(img, { attributes: true, attributeFilter: ["class"] });
  }
  if (editing) mountEditor();
}

/** For tests. */
export const editorState = () => ({ editing, mounted: Boolean(root) });
