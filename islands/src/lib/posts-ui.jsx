// Shared pieces for the posts islands (my-posts, timeline, posts page). DS components/Posts + Voice: lowercase copy, the one time
// format (lib/time.js), errors in banners, one empty-state pattern, an inline scoped question before deleting.
import "@io-kit/content/content.css";
import "../posts.css";
import { useCallback, useEffect, useId, useRef, useState } from "react";
import { PostCard, useTimeline } from "@io-kit/content/react";
import { api } from "./api.js";
import { createHfyContentSource } from "./content-source.js";
import { formatTime, watchTimeTitles } from "./time.js";
import { authorHref } from "./person-name.jsx";

export { formatTime };
export const source = createHfyContentSource(api);
export const postHref = (p) => `/posts/?id=${encodeURIComponent(p.id)}`;
export const signInHref = () => `/auth/login?returnTo=${encodeURIComponent(location.pathname + location.search)}`;

// DS Voice microcopy. Errors say what happened and who to text; signed out gets the living-person gate line.
export const COPY = {
  failed: "that didn't work. try again, or text J.",
  signedOut: "this page is family-only. sign in to see it.",
  notPosted: "that didn't post. it's still here — try again.",
  notFound: "that post wasn't found. if that's wrong, text J.",
  // privacy-guard-existing-paths: the API refuses a photo whose stored bytes say where it was taken (photo_has_location) and an
  // upload that is missing, retyped or not this member's (upload_missing, upload_not_owned; social.md E8 copy).
  photoLocation: "that photo still says where it was taken. we don't keep that on the site, so please remove it and share a copy without its location, like a screenshot.",
  photoMissing: "that photo didn't finish uploading. remove it and add it again.",
};
export const isSignedOut = (e) => Boolean(e && (e.signedOut || e.code === "unauthenticated" || e.status === 401));
export const friendlyError = (e) => (isSignedOut(e) ? COPY.signedOut : COPY.failed);


/** PostCard / ArticleView labels: lowercase; the meta line is "name · time" (no "by"). */
export const CARD_LABELS = { by: "", edit: "edit", delete: "delete", open: "open", publish: "publish", withdraw: "withdraw", draft: "draft", withdrawn: "withdrawn" };

/** A banner with the signed-out line gets its "sign in" as a link (a 44px target, posts.css `.hfy-banner a`). */
export function ErrorText({ text }) {
  if (text !== COPY.signedOut) return text;
  return <>this page is family-only. <a href={signInHref()}>sign in</a> to see it.</>;
}

/**
 * The living-person gate (DS Voice): one neutral line and one 44px "sign in" button. A sign-in gate is not an error, so it is
 * never a danger banner and never role=alert (DS: danger banners are for errors); it reports once, politely (role=status).
 */
export function SignInGate({ text = COPY.signedOut }) {
  return (
    <div className="hfy-gate" role="status" data-hfy-gate>
      <p>{text}</p>
      <a className="hfy-btn hfy-btn--primary" href={signInHref()}>sign in</a>
    </div>
  );
}

/** Errors in a danger banner (role=alert); the signed-out case is the neutral gate instead. */
export const Banner = ({ children }) => (children === COPY.signedOut
  ? <SignInGate />
  : <div className="hfy-banner" role="alert" data-hfy-banner>{typeof children === "string" ? <ErrorText text={children} /> : children}</div>);

export const Skeletons = ({ n = 3 }) => (
  <ul className="hfy-posts__list" role="status" aria-busy="true" aria-label="loading posts" data-hfy-skeleton>
    {Array.from({ length: n }, (_, i) => (
      <li className="hfy-posts__item" key={i} aria-hidden="true"><span className="hfy-skeleton hfy-skeleton--name" /><span className="hfy-skeleton hfy-skeleton--body" /></li>
    ))}
  </ul>
);

/** "posted" / "saved" in text.dim for `ms`, announced politely. */
export function usePing(ms = 3000) {
  const [text, setText] = useState("");
  const timer = useRef(null);
  useEffect(() => () => clearTimeout(timer.current), []);
  const ping = useCallback((t, hold = ms) => {
    clearTimeout(timer.current);
    setText(t);
    if (hold > 0) timer.current = setTimeout(() => setText(""), hold);
  }, [ms]);
  return [text, ping];
}
export const Ping = ({ text }) => <p className="hfy-ping" role="status" aria-live="polite">{text}</p>;

/** Keeps a full-date title on every <time> under the ref, and re-renders once a minute so "5 min ago" stays true. */
export function useTimeTitles() {
  const ref = useRef(null);
  const [, tick] = useState(0);
  useEffect(() => watchTimeTitles(ref.current), []);
  useEffect(() => { const t = setInterval(() => tick((n) => n + 1), 60e3); return () => clearInterval(t); }, []);
  return ref;
}

/**
 * Newest-first published posts with cursor paging, through useTimeline's page(). The timeline source answers in the feed.v1 shape
 * ({ items, next_cursor, has_more }), so the next page's cursor is `next_cursor` (reading `cursor` left "show older posts" unrendered).
 */
export function usePosts(filter) {
  const timeline = useTimeline(source);
  const [state, setState] = useState({ items: [], cursor: null, status: "loading", error: null });
  const key = JSON.stringify(filter || {});
  const busy = useRef(false);
  const load = useCallback(async (cursor) => {
    if (busy.current) return;
    busy.current = true;
    setState((s) => ({ ...s, status: cursor ? "more" : "loading", error: null }));
    try {
      const r = await timeline.page({ filter: { visibility: "published", ...(filter || {}) }, cursor: cursor || undefined, limit: 20 });
      setState((s) => ({ items: cursor ? [...s.items, ...r.items.filter((p) => !s.items.some((q) => q.id === p.id))] : r.items, cursor: r.next_cursor ?? null, status: "ready", error: null }));
    } catch (e) {
      setState((s) => ({ ...s, status: "error", error: friendlyError(e) }));
    } finally { busy.current = false; }
  }, [timeline, key]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => { load(null); }, [load]);
  const remove = async (post) => {
    try {
      await source.delete(post.id);
      setState((s) => ({ ...s, items: s.items.filter((p) => p.id !== post.id) }));
      return true;
    } catch (e) {
      setState((s) => ({ ...s, error: friendlyError(e) }));
      return false;
    }
  };
  return { ...state, reload: () => load(null), more: () => load(state.cursor), remove, prepend: (p) => setState((s) => ({ ...s, items: [p, ...s.items.filter((q) => q.id !== p.id)] })) };
}

/** `delete this post?` -> delete / keep, inline under the card. Focus moves to "keep" (the safe answer) and back to the card's delete. */
function ConfirmDelete({ onDelete, onKeep }) {
  const id = useId();
  const keep = useRef(null);
  const [pending, setPending] = useState(false);
  useEffect(() => { keep.current?.focus(); }, []);
  return (
    <div className="hfy-confirm" role="group" aria-labelledby={id} data-hfy-confirm>
      <p id={id}>delete this post?</p>
      <button type="button" className="hfy-btn hfy-btn--danger" disabled={pending} onClick={async () => { setPending(true); if (!(await onDelete())) setPending(false); }}>{pending ? "deleting…" : "delete"}</button>
      <button type="button" className="hfy-btn" ref={keep} disabled={pending} onClick={onKeep}>keep</button>
    </div>
  );
}

/**
 * Each photo's img alt (PostCard / ArticleView `imageAlt`, @io-kit/content 0.3.2): "a photo from <name>", or "photo 2 of 3 from <name>"
 * in a post with several, so a screen reader hears that a photo is there and from whom; a photo-only post (HFY-TSK-315) is otherwise
 * only a name and a time to assistive tech. The text the author typed in the composer's "add a caption" field (stored as the
 * attachment's `alt`) is the photo's visible caption (ruling P2-R47): the kit draws it as the <figure>'s <figcaption>, which names the
 * figure, so it is never repeated as the alt and is not announced twice (HFY-TSK-323). `index` is the position in post.attachments, as
 * the kit passes it; photos are counted among the images only. Render only: nothing is written back to the post.
 */
export function photoAlt(attachment, index, post) {
  const all = Array.isArray(post?.attachments) ? post.attachments : [];
  const isImage = (a) => a?.kind === "image";
  const total = all.filter(isImage).length;
  const n = all.slice(0, index + 1).filter(isImage).length;
  const what = total > 1 ? `photo ${n} of ${total}` : "a photo";
  const who = String(post?.author?.label || "").trim();
  return who ? `${what} from ${who}` : what;
}

/**
 * What every PostCard and ArticleView gets: the HFY labels and time format, the author's name as a link to their person page (P2-R46,
 * lib/person-name.jsx; a principal without a Gramps person id stays plain text) and the photo alts.
 */
export const CARD_PROPS = { labels: CARD_LABELS, formatTime, authorHref, imageAlt: photoAlt };

/** The author's initial for the 32px avatar (DS Posts anatomy). */
const initialOf = (label) => (String(label || "").trim().match(/\p{L}|\p{N}/u)?.[0] || "").toUpperCase();

/**
 * One feed row, DS Posts anatomy: avatar 32 · name · time, the body, an optional photo, then ONE 44px footer row (comments, delete).
 * Kit gap (@io-kit/content PostCard, 0.1.1 through 0.3.2; record for the kit backlog): its Meta renders only the name and the time
 * (no avatar slot) and it has no footer slot, so its actions row cannot hold the comments link. HFY: the avatar is drawn beside the kit's
 * meta row (posts.css), and the row renders its own footer (the kit's delete is not wired, so its actions row stays empty and hidden).
 */
export function PostRow({ post, link, remove }) {
  const [asking, setAsking] = useState(false);
  const del = useRef(null);
  const canDelete = Boolean(post.can?.delete && remove);
  const keep = () => {
    setAsking(false);
    requestAnimationFrame(() => del.current?.focus());
  };
  const author = post.author?.label || "";
  return (
    <li className="hfy-posts__item hfy-posts__post">
      <span className="hfy-posts__avatar" aria-hidden="true">{initialOf(author)}</span>
      <PostCard post={post} {...CARD_PROPS} />
      {(link || canDelete) && (
        <div className="hfy-posts__footer" data-hfy-post-footer>
          {link && <a className="hfy-btn hfy-btn--quiet hfy-posts__open" href={postHref(post)} aria-label={author ? `comments on ${author}'s post` : undefined}>comments</a>}
          {canDelete && <button type="button" className="hfy-btn hfy-btn--quiet" ref={del} aria-expanded={asking} onClick={() => setAsking(true)}>{CARD_LABELS.delete}</button>}
        </div>
      )}
      {asking && <ConfirmDelete onDelete={() => remove(post)} onKeep={keep} />}
    </li>
  );
}

export function EmptyPosts({ action }) {
  return (
    <div className="hfy-empty" data-hfy-empty>
      <p className="hfy-empty__title">nothing posted yet.</p>
      <p className="hfy-empty__text">be the first — a photo counts.</p>
      {action}
    </div>
  );
}

export function PostList({ posts, link = true, emptyAction }) {
  const { items, cursor, status, error, more, remove } = posts;
  const ref = useTimeTitles();
  return (
    <div className="hfy-posts__feed" ref={ref}>
      {status === "loading" ? <Skeletons /> : (
        <>
          {error && <Banner>{error}</Banner>}
          {status === "ready" && items.length === 0 && !error && <EmptyPosts action={emptyAction} />}
          {items.length > 0 && (
            <ul className="hfy-posts__list">
              {items.map((p) => <PostRow key={p.id} post={p} link={link} remove={remove} />)}
            </ul>
          )}
          {cursor && <button type="button" className="hfy-btn hfy-posts__more" onClick={more} disabled={status === "more"}>{status === "more" ? "loading…" : "show older posts"}</button>}
        </>
      )}
    </div>
  );
}
