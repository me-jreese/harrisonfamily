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
import { CappedSection } from "./capped.jsx";
import { commentFromHash } from "./capped-model.js";
import { ModerateControl } from "./moderation-ui.jsx";
import { GraduateControl } from "./graduate-ui.jsx";
import { COPY as GRAD_COPY } from "./graduate.js";
import { COPY as MOD_COPY, createModerationClient, commentTarget, photoTarget, pingFor, versionOf } from "./moderation.js";

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
  // Moderation (moderationV1, HFY-TSK-191): the kit's menu, ask form, badge and banners, in the DS voice (lib/moderation.js COPY).
  hide: MOD_COPY.hide,
  unhide: MOD_COPY.unhide,
  askChanges: MOD_COPY.askChanges,
  askQuestion: MOD_COPY.askQuestion,
  moderationNote: MOD_COPY.note,
  keepHidden: MOD_COPY.keepHidden,
  send: MOD_COPY.send,
  hiddenBadge: MOD_COPY.badgeHidden,
  photoHidden: MOD_COPY.photoHidden,
  bannerHidden: MOD_COPY.hiddenByModerator,
  bannerAsked: `{by} ${MOD_COPY.askedTemplate} {note}`,
  bannerEditToShow: `— ${MOD_COPY.editToShow}`,
  // Oldest-first paging (contribV1 off) loads the NEXT comments, which are newer, so "older" would be untrue (BRD2 section 8). The newest-first
  // social column has its own "show older comments" button (SOCIAL_MORE), drawn by CappedSection.
  loadMore: "show more comments",
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

/**
 * HFY-TSK-191: the one-tap controls the kit's badge and banner lack (@io-kit/comments 0.3.1 Comment).
 *   - An admin looking at a hidden comment gets "unhide" beside the kit's "hidden" badge; it presses the kit menu's own unhide button.
 *   - The author looking at a moderated comment gets "edit" beside the kit's status banner; it presses the comment's own edit button
 *     (editing is what makes a changes_requested or question comment visible again).
 * Both are tagged data-hfy-mod-button and removed when the thing they press is gone. Upstream: Comment `renderModeration` slots.
 */
export function watchModerationButtons(root, labels = LABELS) {
  if (!root || typeof MutationObserver === "undefined") return () => {};
  const make = (kind, text, press) => {
    const b = document.createElement("button");
    b.type = "button";
    b.className = "hfy-btn hfy-btn--quiet";
    b.setAttribute("data-hfy-mod-button", kind);
    b.textContent = text;
    b.addEventListener("click", press);
    return b;
  };
  const labelled = (nodes, text) => [...nodes].find((b) => b.textContent.trim() === text);
  const apply = () => {
    root.querySelectorAll(".io-comments-comment").forEach((c) => {
      const moderated = c.querySelector(":scope > .io-comments-moderated");
      const unhide = labelled(c.querySelectorAll(".io-comments-moderation .io-comments-actions > button"), labels.unhide);
      const haveUnhide = c.querySelector('[data-hfy-mod-button="unhide"]');
      if (moderated && unhide && !haveUnhide) moderated.append(make("unhide", labels.unhide, () => unhide.click()));
      else if (haveUnhide && !(moderated && unhide)) haveUnhide.remove();
      const banner = c.querySelector(":scope > p.io-comments-banner");
      const edit = labelled(c.querySelectorAll(":scope > .io-comments-actions > button"), labels.edit);
      const haveEdit = c.querySelector('[data-hfy-mod-button="edit"]');
      if (banner && edit && !haveEdit) banner.insertAdjacentElement("afterend", make("edit", labels.edit, () => edit.click()));
      else if (haveEdit && !(banner && edit && haveEdit.previousElementSibling === banner)) haveEdit.remove();
    });
  };
  apply();
  const mo = new MutationObserver(apply);
  mo.observe(root, { subtree: true, childList: true, characterData: true });
  return () => { mo.disconnect(); root.querySelectorAll("[data-hfy-mod-button]").forEach((b) => b.remove()); };
}

/** The kit's moderation <details> closes on Escape (focus back to its summary) and on a press outside it, so a phone's bottom Sheet can be dismissed. */
export function watchModerationSheets(root) {
  if (!root) return () => {};
  const onDown = (e) => root.querySelectorAll(".io-comments-moderation[open]").forEach((d) => { if (!d.contains(e.target)) d.open = false; });
  const onKey = (e) => {
    if (e.key !== "Escape") return;
    const d = [...root.querySelectorAll(".io-comments-moderation[open]")].find((x) => x.contains(document.activeElement));
    if (!d) return;
    e.preventDefault();
    d.open = false;
    d.querySelector("summary")?.focus();
  };
  document.addEventListener("pointerdown", onDown, true);
  root.addEventListener("keydown", onKey);
  return () => { document.removeEventListener("pointerdown", onDown, true); root.removeEventListener("keydown", onKey); };
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

/** The newest-first column's pager (contribV1, BRD2 section 8): the first page and what each "show older comments" adds. */
export const SOCIAL_MORE = "show older comments";
export const SOCIAL_PAGE = 8;
// Anchors load at most this many extra pages looking for `#comment-<ulid>` (BRD2 section 8).
const ANCHOR_PAGES = 5;
export const ANCHOR_MISSED = "couldn't find that comment. it may have been deleted.";

/** Kit `renderMore` target: renders nothing and reports the pager state upward, so the host's CappedSection button drives paging. */
function MoreBridge({ state, report, loadRef }) {
  useEffect(() => {
    loadRef.current = state.loadMore;
    report((p) => (p.known && p.hasMore === state.hasMore && p.loading === state.loading ? p : { hasMore: state.hasMore, loading: state.loading, known: true }));
  });
  return null;
}

/** Gives every comment its `comment-<ulid>` id, so an `#comment-<ulid>` link (inbox, contributions) has something to point at. */
function watchCommentIds(root) {
  if (!root || typeof MutationObserver === "undefined") return () => {};
  const apply = () => root.querySelectorAll("article[data-comment-id]").forEach((a) => {
    const id = `comment-${a.getAttribute("data-comment-id")}`;
    if (a.id !== id) a.id = id;
  });
  apply();
  const mo = new MutationObserver(apply);
  mo.observe(root, { subtree: true, childList: true });
  return () => mo.disconnect();
}

/**
 * `social` is the contribV1 column inside #hfy-person-social: newest first (order=desc), the composer on top, the list capped with
 * "show older comments", and `#comment-<ulid>` scrolled to and highlighted (loading up to 5 more pages to find it). Off, the thread is as it was.
 */
export function Comments({ subject, social = false, heading = true }) {
  const [session, setSession] = useState(undefined);
  const [moderator, setModerator] = useState(false);
  const [graduator, setGraduator] = useState(false);
  const [ping, setPing] = useState("");
  const timer = useRef(null);
  const root = useRef(null);
  // commentPhotosV1 (default off): the photo picker in the composer and photos drawn with HFY's alt and caption. Off, the thread is
  // exactly what it was (the kit's composer has no picker without onUpload).
  const flags = useFlags();
  const photosOn = flags?.commentPhotosV1 === true;
  // moderationV1 (HFY-TSK-191, default off): the kit's hide / ask / unhide menu, badge and banners, and a hide control on each photo. Off, the
  // thread is what it was (the kit's moderate menu then offers "delete as moderator" only).
  const modOn = flags?.moderationV1 === true;
  // graduateV1 (HFY-TSK-215, default off): "add to a family page…" on each comment photo, for an admin (can.graduate from /api/me). The loader
  // (feature-flags.js) turns commentPhotosV1 and moderationV1 on with it, so the photos and the hide control it sits beside are there.
  const gradOn = flags?.graduateV1 === true;
  const [reload, setReload] = useState(0);
  useEffect(() => { getSession().then(setSession); }, []);
  useEffect(() => () => clearTimeout(timer.current), []);
  useEffect(() => watchTimeTitles(root.current), []);
  useEffect(() => watchDeleteButtons(root.current), []);
  useEffect(() => (modOn ? watchModerationButtons(root.current) : undefined), [modOn]);
  useEffect(() => (modOn ? watchModerationSheets(root.current) : undefined), [modOn]);
  useEffect(() => guardCommentDeletes(root.current), []);
  useEffect(() => watchContactGuard(root.current, COMMENT_GUARD), []);
  const sid = session?.authenticated ? session.sub : null;
  // HFY-TSK-298 (BRD2 D2-12): moderator rights come only from the shared GET /api/me (admin, or can.moderate when present); a 401 or a
  // failure means not a moderator. The kit gates each delete control on that comment's server-computed can.* itself.
  useEffect(() => {
    if (!sid) return undefined;
    let live = true;
    getMe().then((me) => { if (live) { setModerator(canModerate(me)); setGraduator(me?.can?.graduate === true); } });
    return () => { live = false; };
  }, [sid]);
  const flash = useCallback((text) => { clearTimeout(timer.current); setPing(text); timer.current = setTimeout(() => setPing(""), 3000); }, []);
  const source = useMemo(() => createHfyCommentSource(api, {
    onAdded: () => flash("posted"),
    moderation: modOn,
    onModerated: (input) => flash(pingFor(input.action)),
  }), [modOn, flash]);
  // A comment photo's hide or unhide: the kit thread has no hook to swap one attachment, so the thread is fetched again (reload remounts it).
  const photoAct = useCallback(async (comment, attachment, input) => {
    await createModerationClient(api).act(photoTarget(commentTarget(subject, comment.id), attachment.id), input, versionOf(comment));
    flash(pingFor(input.action, { photo: true }));
    setReload((n) => n + 1);
  }, [subject, flash]);
  const onGraduated = useCallback(() => flash(GRAD_COPY.ping), [flash]);
  // One row of controls under a photo: the moderator's hide (moderationV1) and the admin's "add to a family page…" (graduateV1). A hidden photo
  // cannot be added (the server refuses it), so it gets no graduate control.
  const renderPhotoActions = useMemo(() => {
    const showGrad = gradOn && graduator;
    if (!modOn && !showGrad) return undefined;
    return (comment, a) => {
      const hide = modOn && comment.can?.moderate === true
        ? <ModerateControl photo moderation={a.moderation?.hidden === true ? { state: "hidden", hidden: true } : undefined} onAct={(input) => photoAct(comment, a, input)} />
        : null;
      const grad = showGrad && a.moderation?.hidden !== true && comment.moderation?.hidden !== true && typeof a.id === "string"
        ? <GraduateControl comment={comment} attachment={a} subject={subject} onAdded={onGraduated} />
        : null;
      if (!hide && !grad) return null;
      return grad && hide ? <div className="hfy-photo-actions">{hide}{grad}</div> : (hide ?? grad);
    };
  }, [modOn, gradOn, graduator, photoAct, subject, onGraduated]);
  const onUpload = useCallback(async (file) => {
    try {
      const a = await uploadPhoto(api, file, { purpose: "comment" });
      return { url: a.url, mime: a.mime, ...(a.width ? { width: a.width, height: a.height } : {}) };
    } catch (e) {
      if (e instanceof PhotoDecodeError) console.warn("photo could not be decoded", e.cause?.name);
      throw new Error(photoUploadMessage(e));
    }
  }, []);
  // The social column's paging and anchor: the kit pager state comes up through MoreBridge; the hash names the comment to find.
  // `known` is false until the kit pager has reported once, so a thread that has not loaded yet is never read as "no more pages".
  const [pager, setPager] = useState({ hasMore: false, loading: false, known: false });
  const loadRef = useRef(null);
  const renderMore = useCallback((state) => <MoreBridge state={state} report={setPager} loadRef={loadRef} />, []);
  const [anchor, setAnchor] = useState(() => (social ? commentFromHash(location.hash) : null));
  const pages = useRef(0);
  const [missed, setMissed] = useState(false); // the anchor's comment is not in what could be loaded
  useEffect(() => {
    if (!social) return undefined;
    const on = () => { pages.current = 0; setMissed(false); setAnchor(commentFromHash(location.hash)); };
    window.addEventListener("hashchange", on);
    return () => window.removeEventListener("hashchange", on);
  }, [social]);
  useEffect(() => (social ? watchCommentIds(root.current) : undefined), [social]);
  const anchorSelector = anchor ? `[data-comment-id="${anchor}"]` : null;
  const signedIn = Boolean(sid);
  useEffect(() => {
    if (!social || !anchorSelector || !signedIn || !root.current) return;
    if (root.current.querySelector(anchorSelector)) { setMissed(false); return; } // CappedSection raises the cap and calls onReveal
    if (!pager.known || pager.loading) return;
    if (pager.hasMore && pages.current < ANCHOR_PAGES) { pages.current += 1; loadRef.current?.(); } else setMissed(true); // no more pages, or the 5 extra were spent
  }, [social, anchorSelector, signedIn, pager]);
  const onReveal = useCallback((el) => {
    root.current?.querySelectorAll("[data-hfy-target]").forEach((n) => n.removeAttribute("data-hfy-target"));
    el.setAttribute("data-hfy-target", "");
    el.tabIndex = -1;
    el.scrollIntoView({ block: "center" });
    el.focus({ preventScroll: true });
  }, []);
  const photoProps = photosOn ? { onUpload, accept: PHOTO_ACCEPT, maxAttachments: MAX_PHOTOS } : {};
  const viewer = sid ? { id: sid, label: session.label, ...(moderator ? { roles: ["admin"] } : {}) } : null;
  const returnTo = encodeURIComponent(location.pathname + location.search);
  return (
    <section className={social ? "hfy-comments hfy-social__col" : "hfy-comments"} {...(social ? { id: "hfy-person-comments" } : {})} {...(heading ? { "aria-labelledby": `hfy-comments-h-${subject}` } : {})} data-hfy-comments ref={root}>
      {heading && <h2 className="hfy-h" id={`hfy-comments-h-${subject}`}>comments</h2>}
      {social && missed && <p className="hfy-ping" role="status" data-hfy-anchor-missed>{ANCHOR_MISSED}</p>}
      {(session === undefined || (viewer && flags === undefined)) && <div className="hfy-comments__skeleton" role="status" aria-busy="true" aria-label="loading comments"><span className="hfy-skeleton" /><span className="hfy-skeleton" /><span className="hfy-skeleton" /></div>}
      {session !== undefined && !viewer && (
        <div className="hfy-comments__signin" data-hfy-signin>
          <p>sign in to leave a comment.</p>
          <a className="hfy-btn hfy-btn--primary" href={`/auth/login?returnTo=${returnTo}`}>sign in</a>
        </div>
      )}
      {viewer && flags !== undefined && (
        <>
          {social ? (
            <CappedSection label={SOCIAL_MORE} clipSelector=".io-comments-list" hasMore={pager.hasMore} loading={pager.loading} onMore={() => loadRef.current?.()} revealSelector={anchorSelector} onReveal={onReveal}>
              <Thread key={reload} threadId={subject} source={source} viewer={viewer} linkify={linkify} authorHref={authorHref} adminIds={[]} composerRows={1} placeholder={PLACEHOLDER} formatTime={formatTime} labels={LABELS} features={FEATURES} renderAttachment={renderPhoto} {...(renderPhotoActions ? { renderAttachmentActions: renderPhotoActions } : {})} order="desc" composerPosition="top" pageSize={SOCIAL_PAGE} renderMore={renderMore} {...photoProps} />
            </CappedSection>
          ) : (
            <Thread key={reload} threadId={subject} source={source} viewer={viewer} linkify={linkify} authorHref={authorHref} adminIds={[]} composerRows={1} placeholder={PLACEHOLDER} formatTime={formatTime} labels={LABELS} features={FEATURES} renderAttachment={renderPhoto} {...(renderPhotoActions ? { renderAttachmentActions: renderPhotoActions } : {})} {...photoProps} />
          )}
          <p className="hfy-ping" role="status" aria-live="polite">{ping}</p>
        </>
      )}
    </section>
  );
}
