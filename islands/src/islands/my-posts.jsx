// Own-page posting (HFY-TSK-067, flag postsV2): on /person/?id=<gramps_id> when the viewer IS that person,
// a PostComposer (text + photos) and this member's posts. Others see nothing from this island.
//
// DS Posts composer: one row, one height — the input (placeholder "post a photo or a line"), a 44px "add a photo" button and post.
// Each attached photo gets an "add a caption" field (ruling P2-R47, HFY-TSK-323): what is typed there is stored as the attachment's
// `alt` and every post card shows it as the photo's visible caption (@io-kit/content 0.3.2 <figure><figcaption>; posts-ui photoAlt).
// Kit root cause (@io-kit/content PostComposer, 0.1.1 through 0.3.2; record for the kit backlog): it renders a bare <input type=file>
// with only an aria-label, so the browser's own "Choose File" / "No file chosen" copy and a 32px picker showed, an attached photo shows
// no thumbnail, and the textarea takes no placeholder (0.3.2 sets one on the caption field only, from labels.caption). HFY overrides,
// all in this island:
//   - the kit's file input is hidden (posts.css) and taken out of the tab order and the accessibility tree; the HFY button opens it;
//   - the textarea gets a placeholder after render (the kit has no placeholder prop for it);
//   - each attachment row gets a 44px thumbnail of the uploaded photo, tracked here by index (remove clicks are followed);
//   - a successful upload pings "got it. it's in the gallery." (DS Posts done state);
//   - the R-18 pre-check (lib/contact-guard.js; privacy-guard-existing-paths AC2) marks a phone number, address or email in the
//     text or an alt, shows the DS copy under the field and disables post until it is removed; the text is kept.
// Upstream: a PostComposer `renderPicker` / placeholder / attachment-preview API; then drop the DOM decoration below.
import { useCallback, useEffect, useRef, useState } from "react";
import { PostComposer } from "@io-kit/content/react";
import { api, getSession } from "../lib/api.js";
import { uploadPhoto } from "../lib/upload.js";
import { mountAt } from "../lib/mount.jsx";
import { COPY, Ping, PostList, isSignedOut, source, usePing, usePosts } from "../lib/posts-ui.jsx";
import { CAPABILITIES } from "../lib/content-source.js";
import { GUARD_CODES, GUARD_COPY, learnFromRefusal, precheckAll, watchContactGuard } from "../lib/contact-guard.js";

const ACCEPT = "image/jpeg,image/png,image/webp,image/heic";
const MAX = 4;
// The subject is always this page's person (set on submit), so the composer's subject field is hidden.
const COMPOSER_CAPABILITIES = { ...CAPABILITIES, subject: false };
const LABELS = {
  body: "post a photo or a line",
  bodyHint: "plain words are fine",
  attachments: "photos",
  addAttachment: "add a photo",
  // The photo's caption field: its placeholder, and its accessible name with the photo's number ("add a caption 1"). P2-R47.
  caption: "add a caption",
  remove: "remove",
  post: "post",
  saving: "posting…",
};
const PLACEHOLDER = "post a photo or a line";
// The composer fields the R-18 pre-check reads: the body, the title (articles) and each photo's caption.
const GUARDED = '.iok-content-composer textarea, .iok-content-composer input[name="title"], .iok-content-attachment > input';
/**
 * The line a failed post write shows in the composer (the kit keeps the text). An R-18 refusal (contact_info, dob_not_allowed)
 * gets its DS copy, never "try again", and a dob_not_allowed turns the composer's birthday check on (contact-precheck.js).
 * Here, not in posts-ui: the timeline and /posts/ never write, so they do not load the detector.
 */
export function postWriteError(e) {
  if (isSignedOut(e)) return COPY.signedOut;
  const code = e?.apiCode;
  if (GUARD_CODES.includes(code)) {
    learnFromRefusal(code);
    return GUARD_COPY[code];
  }
  if (code === "photo_has_location") return COPY.photoLocation;
  if (code === "upload_missing" || code === "upload_not_owned") return COPY.photoMissing;
  return COPY.notPosted;
}
const guardOptions = {
  fields: GUARDED,
  submitOf: (form) => form.querySelector('button[type="submit"]'),
  // The kit's own rule once a hit is gone (@io-kit/content 0.3.2 PostComposer, HFY-TSK-315): a line or a photo is enough to post,
  // so a photo-only post whose caption held the hit gets "post" back with its box still empty.
  enabledOf: (form) => (form.querySelector("textarea")?.value ?? "").trim() !== "" || form.querySelector(".iok-content-attachment") !== null,
};
const DONE = "got it. it's in the gallery.";

/** Keeps the kit composer's DOM in the DS shape (see the header): the textarea placeholder, the hidden picker and one thumbnail per row. */
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
  const shareHandled = useRef(false);
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
    const unguard = watchContactGuard(root, guardOptions);
    return () => { mo.disconnect(); root.removeEventListener("click", onRemove, true); unguard(); };
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
    // Once per mount: a re-render or remount with the hash still set must not pull focus back; a real hash change still does.
    if (!shareHandled.current) { shareHandled.current = true; go(); }
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
            // The pre-check disables post while a field holds a hit; a submit that got here anyway is held, with the same copy.
            const held = precheckAll([input.body, input.title, ...(input.attachments || []).map((a) => a.alt)]);
            if (held) throw new Error(held.message);
            try {
              posts.prepend(await source.createDraft({ ...input, subject: id }));
              photos.current = []; // the kit clears its attachments after a successful submit
              setCount(0);
              setPing("posted");
            } catch (e) {
              // PostComposer keeps the text and shows this message inline (role=alert).
              throw new Error(postWriteError(e));
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
