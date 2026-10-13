// Own-page posting (HFY-TSK-067, flag postsV2): on /person/?id=<gramps_id> when the viewer IS that person,
// a PostComposer (text + photos) and this member's posts. Others see nothing from this island.
//
// DS Posts composer: one row, one height — the input (placeholder "post a photo or a line"), a 44px "add a photo" button and post.
// Kit root cause (@io-kit/content 0.1.1 PostComposer; record for the kit backlog): it renders a bare <input type=file> with only an
// aria-label, so the browser's own "Choose File" / "No file chosen" copy and a 32px picker showed, the alt-text input is aria-label only
// (no visible hint), an attached photo shows no thumbnail, and it takes no placeholder. HFY overrides, all in this island:
//   - the kit's file input is hidden (posts.css) and taken out of the tab order and the accessibility tree; the HFY button opens it;
//   - the textarea and every alt-text input get a placeholder after render (the kit has no placeholder prop);
//   - each attachment row gets a 44px thumbnail of the uploaded photo, tracked here by index (remove clicks are followed);
//   - a successful upload pings "got it. it's in the gallery." (DS Posts done state).
// Upstream: a PostComposer `renderPicker` / placeholder / attachment-preview API; then drop the DOM decoration below.
import { useCallback, useEffect, useRef, useState } from "react";
import { PostComposer } from "@io-kit/content/react";
import { api, getSession } from "../lib/api.js";
import { uploadPhoto } from "../lib/upload.js";
import { mountAt } from "../lib/mount.jsx";
import { COPY, Ping, PostList, isSignedOut, source, usePing, usePosts } from "../lib/posts-ui.jsx";
import { CAPABILITIES } from "../lib/content-source.js";

const ACCEPT = "image/jpeg,image/png,image/webp,image/heic";
const MAX = 4;
// The subject is always this page's person (set on submit), so the composer's subject field is hidden.
const COMPOSER_CAPABILITIES = { ...CAPABILITIES, subject: false };
const LABELS = {
  body: "post a photo or a line",
  bodyHint: "plain words are fine",
  attachments: "photos",
  addAttachment: "add a photo",
  altText: "describe photo",
  remove: "remove",
  post: "post",
  saving: "posting…",
};
const PLACEHOLDER = "post a photo or a line";
const ALT_PLACEHOLDER = "describe the photo";
const DONE = "got it. it's in the gallery.";

/** Keeps the kit composer's DOM in the DS shape (see the header): placeholders, the hidden picker and one thumbnail per row. */
function decorate(root, photos) {
  if (!root) return;
  const box = root.querySelector(".iok-content-composer textarea");
  if (box && !box.hasAttribute("placeholder")) box.setAttribute("placeholder", PLACEHOLDER);
  const picker = root.querySelector('.iok-content-attachments > input[type="file"]');
  if (picker && picker.getAttribute("tabindex") !== "-1") {
    picker.setAttribute("tabindex", "-1");
    picker.setAttribute("aria-hidden", "true");
  }
  root.querySelectorAll(".iok-content-attachment").forEach((row, i) => {
    const alt = row.querySelector("input");
    if (alt && !alt.hasAttribute("placeholder")) alt.setAttribute("placeholder", ALT_PLACEHOLDER);
    const url = photos[i];
    let img = row.querySelector(":scope > img.hfy-posts__thumb");
    if (!url) { img?.remove(); return; }
    if (!img) {
      img = document.createElement("img");
      img.className = "hfy-posts__thumb";
      img.alt = "";
      row.prepend(img);
    }
    if (img.getAttribute("src") !== url) img.setAttribute("src", url);
  });
}

export function MyPosts({ id }) {
  const [me, setMe] = useState(undefined);
  const [ping, setPing] = usePing();
  const posts = usePosts({ subject: id });
  const composer = useRef(null);
  // Uploaded photo urls, in the kit's attachment order (index i = the i-th .iok-content-attachment row).
  const photos = useRef([]);
  const [count, setCount] = useState(0);
  const sync = useCallback(() => decorate(composer.current, photos.current), []);
  useEffect(() => { getSession().then((s) => setMe(s.authenticated ? s.sub : null)); }, []);
  useEffect(() => {
    const root = composer.current;
    if (!root) return undefined;
    sync();
    const mo = new MutationObserver(sync);
    mo.observe(root, { subtree: true, childList: true });
    // The kit's remove button drops attachment i: drop the same url so the thumbnails stay in step (capture: before React re-renders).
    const onRemove = (e) => {
      const row = e.target instanceof Element ? e.target.closest(".iok-content-attachment") : null;
      if (!row || !e.target.closest("button")) return;
      const i = [...row.parentElement.querySelectorAll(":scope > .iok-content-attachment")].indexOf(row);
      if (i >= 0) { photos.current.splice(i, 1); setCount(photos.current.length); }
    };
    root.addEventListener("click", onRemove, true);
    return () => { mo.disconnect(); root.removeEventListener("click", onRemove, true); };
  }, [me, sync]);
  // HFY-TSK-136: /person/?id=<me>#share (the /about/ call to action's "add a photo") scrolls the composer in and focuses it. The browser's
  // own anchor jump ran before this section existed, so it is done here, once the section is drawn and on a later hash change.
  useEffect(() => {
    if (me !== id) return undefined;
    const go = () => {
      if (window.location.hash !== "#share") return;
      const box = composer.current?.querySelector("textarea");
      document.getElementById("share")?.scrollIntoView({ block: "start" });
      if (box) box.focus({ preventScroll: true });
    };
    go();
    window.addEventListener("hashchange", go);
    return () => window.removeEventListener("hashchange", go);
  }, [me, id]);
  if (me !== id) return null;
  const pickPhoto = () => composer.current?.querySelector('input[type="file"]')?.click();
  return (
    <section className="hfy-posts hfy-posts__mine" id="share" aria-labelledby="hfy-my-posts-h" data-hfy-my-posts>
      <h2 className="hfy-h" id="hfy-my-posts-h">share something</h2>
      <div className="hfy-posts__composer" ref={composer}>
        <PostComposer
          capabilities={COMPOSER_CAPABILITIES}
          initial={undefined}
          accept={ACCEPT}
          maxAttachments={MAX}
          labels={LABELS}
          onUpload={async (file) => {
            setPing("uploading… don't close this tab yet", 0);
            try {
              const a = await uploadPhoto(api, file);
              photos.current.push(a.url);
              setCount(photos.current.length);
              setPing(DONE);
              return a;
            } catch (e) {
              setPing("");
              throw new Error(isSignedOut(e) ? COPY.signedOut : COPY.failed);
            }
          }}
          onSubmit={async (input) => {
            try {
              posts.prepend(await source.createDraft({ ...input, subject: id }));
              photos.current = []; // the kit clears its attachments after a successful submit
              setCount(0);
              setPing("posted");
            } catch (e) {
              // PostComposer keeps the text and shows this message inline (role=alert).
              throw new Error(isSignedOut(e) ? COPY.signedOut : COPY.notPosted);
            }
          }}
        />
        <button type="button" className="hfy-btn hfy-posts__photo" onClick={pickPhoto} disabled={count >= MAX} title="add a photo">
          <span className="hfy-posts__photo-icon" aria-hidden="true" />
          <span className="hfy-posts__photo-label">add a photo</span>
        </button>
        <Ping text={ping} />
      </div>
      <PostList posts={posts} emptyAction={<button type="button" className="hfy-btn hfy-btn--primary" onClick={pickPhoto}>add a photo</button>} />
    </section>
  );
}

const waitFor = (test) => new Promise((resolve) => {
  if (test()) return resolve();
  const mo = new MutationObserver(() => { if (test()) { mo.disconnect(); resolve(); } });
  mo.observe(document.documentElement, { subtree: true, childList: true, attributes: true, attributeFilter: ["class"] });
});

async function init() {
  const id = new URLSearchParams(location.search).get("id");
  const content = document.getElementById("person-content");
  if (!id || !content) return;
  await waitFor(() => !content.classList.contains("d-none") && content.querySelector(".notes-panel"));
  const panel = content.querySelector(".notes-panel");
  mountAt((h) => panel.insertAdjacentElement("afterend", h), <MyPosts id={id} />, "hfy-my-posts");
}
init();
