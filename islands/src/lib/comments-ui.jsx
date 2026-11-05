// Kit comments thread over /api/comments for any subject (person:<id> | post:<ulid>); shared by the person and posts islands.
// DS components/Comments: lowercase labels, the one time format, a 3 s "posted" ping, one sign-in line when signed out.
import "@io-kit/comments/comments.css";
import "../posts.css"; // the island primitives (.hfy-h, .hfy-btn, .hfy-skeleton, .hfy-ping)
import "../comments.css"; // after the kit sheet: remaps its :where(.io-comments) defaults onto the contract (see the file)
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Thread, safeUrl } from "@io-kit/comments/react";
import { api, getSession } from "./api.js";
import { createHfyCommentSource } from "./comment-source.js";
import { canModerate, getMe } from "./me.js";
import { formatTime, watchTimeTitles } from "./time.js";
import { watchContactGuard } from "./contact-guard.js";
import { MENTION_SOURCE, authorHref, personPath } from "./person-name.jsx";
import { useFlags } from "./use-flags.js";
import { uploadPhoto } from "./upload.js";
import { PHOTO_ACCEPT, PhotoDecodeError } from "./photo.js";
import { FEATURES, MAX_PHOTOS, PHOTO_LABELS, commentPhotoAlt, photoUploadMessage } from "./comment-photos.js";

// R18: record-id mentions (@I0044 / I0044) link to the person page. Module-level so the identity is stable. Every comment author's name
// links to their page too (Thread authorHref, HFY-TSK-323, ruling P2-R46); both come from lib/person-name.jsx.
export const linkify = { pattern: new RegExp(`\\b${MENTION_SOURCE}\\b`), href: personPath };

export const LABELS = {
  addComment: "add a comment",
  commentLabel: "say something",
  post: "post",
  posting: "posting…",
  save: "save",
  cancel: "cancel",
  edit: "edit",
  delete: "delete",
  edited: "(edited)",
  react: "react",
  more: "more",
  moderate: "moderate",
  moderateDelete: "delete as moderator",
  reason: "reason",
  loadMore: "show older comments",
  empty: "no comments yet.",
  loading: "loading comments",
  dontNotify: "don't notify anyone",
  readOnly: "read only",
  // Photos (commentPhotosV1, HFY-TSK-187): the picker, caption and remove labels (lib/comment-photos.js).
  ...PHOTO_LABELS,
};

/**
 * Thread `renderAttachment`: the kit's photo (a link to the full image around a lazy <img>) with the HFY alt and caption. Returning
 * undefined for an unsafe url keeps the kit's own rule (the photo is dropped).
 */
export function renderPhoto(comment, a) {
  const src = safeUrl(a.url);
  if (!src) return undefined;
  const photo = (
    <a className="io-comments-photo-link" href={src} target="_blank" rel="noopener">
      <img src={src} alt={commentPhotoAlt(comment)} loading="lazy" {...(a.width !== undefined ? { width: a.width } : {})} {...(a.height !== undefined ? { height: a.height } : {})} />
    </a>
  );
  const caption = a.alt?.trim() ?? "";
  return caption ? <figure className="io-comments-figure">{photo}<figcaption className="io-comments-caption">{caption}</figcaption></figure> : photo;
}

// DS Comments: the new-comment input reads "say something" (Thread `placeholder`, @io-kit/comments 0.2.0 and later).
export const PLACEHOLDER = "say something";

// DS Comments: the quiet delete button reads --io-comments-danger. @io-kit/comments 0.3.1 Comment still gives it no hook (the edit, delete
// and moderation buttons share one class), so the delete button is found by its label and tagged; comments.css colours the tag.
function watchDeleteButtons(root, labels = LABELS) {
  if (!root || typeof MutationObserver === "undefined") return () => {};
  const apply = () => root.querySelectorAll(".io-comments-actions > .io-comments-control").forEach((b) => {
    if (b.textContent.trim() === labels.delete) b.setAttribute("data-hfy-danger", "");
    else b.removeAttribute("data-hfy-danger");
  });
  apply();
  const mo = new MutationObserver(apply);
  mo.observe(root, { subtree: true, childList: true, characterData: true });
  return () => mo.disconnect();
}

/**
 * DS Comments / Voice: ask a scoped question before deleting — `delete this comment?` -> delete / keep, inline, no dialog.
 * Kit root cause (@io-kit/comments 0.1.0 through 0.3.1, dist/src/react.js Comment): the own-comment delete button calls props.onDelete
 * directly; there is no confirm state and no deleteConfirm / keep label. Upstream: a confirm step in Comment (labels deleteConfirm, keep); then
 * delete this guard. HFY override: a capture-phase click listener on the section stops the first click on an own comment's delete
 * (before React's root listener sees it), hides that comment's actions row and shows the inline prompt in its place. "delete"
 * re-dispatches the original click (let through once); "keep" (or Escape) restores the row and returns focus to the delete button.
 * The moderator path (summary "moderate" -> reason -> "delete as moderator") is already two steps and is left alone.
 */
export function guardCommentDeletes(root, labels = LABELS) {
  if (!root) return () => {};
  let allow = null;
  let open = null; // { item, prompt, button }
  const close = (refocus) => {
    if (!open) return;
    const { item, prompt, button } = open;
    open = null;
    prompt.remove();
    item.removeAttribute("data-hfy-confirming");
    if (refocus && button.isConnected) button.focus();
  };
  const ask = (button) => {
    close(false);
    const item = button.closest(".io-comments-list > li") || button.closest(".io-comments-comment");
    const prompt = document.createElement("div");
    const id = `hfy-del-${Math.random().toString(36).slice(2, 10)}`;
    prompt.className = "hfy-confirm hfy-comments__confirm";
    prompt.setAttribute("role", "group");
    prompt.setAttribute("aria-labelledby", id);
    prompt.setAttribute("data-hfy-confirm", "");
    const q = document.createElement("p");
    q.id = id;
    q.textContent = "delete this comment?";
    const yes = document.createElement("button");
    yes.type = "button";
    yes.className = "hfy-btn hfy-btn--danger";
    yes.textContent = labels.delete;
    const no = document.createElement("button");
    no.type = "button";
    no.className = "hfy-btn";
    no.textContent = "keep";
    prompt.append(q, yes, no);
    yes.addEventListener("click", () => {
      close(false);
      if (!button.isConnected) return;
      allow = button;
      button.click();
    });
    no.addEventListener("click", () => close(true));
    prompt.addEventListener("keydown", (e) => { if (e.key === "Escape") { e.preventDefault(); close(true); } });
    item.setAttribute("data-hfy-confirming", "");
    item.append(prompt);
    open = { item, prompt, button };
    no.focus(); // the safe answer, as on posts
  };
  const onClick = (e) => {
    const button = e.target instanceof Element ? e.target.closest(".io-comments-actions > .io-comments-control") : null;
    if (!button || button.textContent.trim() !== labels.delete) return;
    if (allow === button) { allow = null; return; }
    e.stopPropagation();
    e.preventDefault();
    ask(button);
  };
  root.addEventListener("click", onClick, true);
  return () => { root.removeEventListener("click", onClick, true); close(false); };
}

// The R-18 pre-check (privacy-guard-existing-paths AC2) on the new-comment box and every edit box: the span is marked, the DS copy
// sits under the box, post (or save) is disabled until the hit is removed, and the text is kept (lib/contact-guard.js).
export const COMMENT_GUARD = {
  // The text box and, with commentPhotosV1, each attached photo's caption (an alt the API also guards, R-18).
  fields: ".io-comments-composer textarea.io-comments-input, .io-comments-composer .io-comments-picked-item > input.io-comments-input",
  submitOf: (form) => form.querySelector('button[type="submit"]'),
  // The kit's own rule (@io-kit/comments 0.3.1 Composer): enabled with some text or at least one finished photo, within the length cap,
  // not sending and with no photo still uploading.
  enabledOf: (form) => {
    const box = form.querySelector("textarea");
    const photo = form.querySelector('.io-comments-picked-item[data-status="done"]') !== null;
    return Boolean(box) && !box.disabled && (box.value.trim() !== "" || photo) && !form.querySelector(".io-comments-counter[data-over]") && !form.querySelector('.io-comments-picked-item[data-status="uploading"]');
  },
};

export function Comments({ subject }) {
  const [session, setSession] = useState(undefined);
  const [moderator, setModerator] = useState(false);
  const [ping, setPing] = useState("");
  const timer = useRef(null);
  const root = useRef(null);
  // commentPhotosV1 (default off): the photo picker in the composer and photos drawn with HFY's alt and caption. Off, the thread is
  // exactly what it was (the kit's composer has no picker without onUpload).
  const flags = useFlags();
  const photosOn = flags?.commentPhotosV1 === true;
  useEffect(() => { getSession().then(setSession); }, []);
  useEffect(() => () => clearTimeout(timer.current), []);
  useEffect(() => watchTimeTitles(root.current), []);
  useEffect(() => watchDeleteButtons(root.current), []);
  useEffect(() => guardCommentDeletes(root.current), []);
  useEffect(() => watchContactGuard(root.current, COMMENT_GUARD), []);
  const sid = session?.authenticated ? session.sub : null;
  // HFY-TSK-298 (BRD2 D2-12): moderator rights come only from the shared GET /api/me (admin, or can.moderate when present); a 401 or a
  // failure means not a moderator. The kit gates each delete control on that comment's server-computed can.* itself.
  useEffect(() => {
    if (!sid) return undefined;
    let live = true;
    getMe().then((me) => { if (live) setModerator(canModerate(me)); });
    return () => { live = false; };
  }, [sid]);
  const source = useMemo(() => createHfyCommentSource(api, {
    onAdded: () => { clearTimeout(timer.current); setPing("posted"); timer.current = setTimeout(() => setPing(""), 3000); },
  }), []);
  const onUpload = useCallback(async (file) => {
    try {
      const a = await uploadPhoto(api, file, { purpose: "comment" });
      return { url: a.url, mime: a.mime, ...(a.width ? { width: a.width, height: a.height } : {}) };
    } catch (e) {
      if (e instanceof PhotoDecodeError) console.warn("photo could not be decoded", e.cause?.name);
      throw new Error(photoUploadMessage(e));
    }
  }, []);
  const photoProps = photosOn ? { onUpload, accept: PHOTO_ACCEPT, maxAttachments: MAX_PHOTOS } : {};
  const viewer = sid ? { id: sid, label: session.label, ...(moderator ? { roles: ["admin"] } : {}) } : null;
  const returnTo = encodeURIComponent(location.pathname + location.search);
  return (
    <section className="hfy-comments" aria-labelledby={`hfy-comments-h-${subject}`} data-hfy-comments ref={root}>
      <h2 className="hfy-h" id={`hfy-comments-h-${subject}`}>comments</h2>
      {(session === undefined || (viewer && flags === undefined)) && <div className="hfy-comments__skeleton" role="status" aria-busy="true" aria-label="loading comments"><span className="hfy-skeleton" /><span className="hfy-skeleton" /><span className="hfy-skeleton" /></div>}
      {session !== undefined && !viewer && (
        <div className="hfy-comments__signin" data-hfy-signin>
          <p>sign in to leave a comment.</p>
          <a className="hfy-btn hfy-btn--primary" href={`/auth/login?returnTo=${returnTo}`}>sign in</a>
        </div>
      )}
      {viewer && flags !== undefined && (
        <>
          <Thread threadId={subject} source={source} viewer={viewer} linkify={linkify} authorHref={authorHref} adminIds={[]} composerRows={1} placeholder={PLACEHOLDER} formatTime={formatTime} labels={LABELS} features={FEATURES} renderAttachment={renderPhoto} {...photoProps} />
          <p className="hfy-ping" role="status" aria-live="polite">{ping}</p>
        </>
      )}
    </section>
  );
}
