// Shared pieces for the posts islands (my-posts, timeline, posts page).
import "@io-kit/content/content.css";
import "../posts.css";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { PostCard, useTimeline } from "@io-kit/content/react";
import { api } from "./api.js";
import { createHfyContentSource } from "./content-source.js";

export const source = createHfyContentSource(api);
export const postHref = (p) => `/posts/?id=${encodeURIComponent(p.id)}`;
export const Banner = ({ children }) => <div className="hfy-banner" role="alert" data-hfy-banner>{children}</div>;
export const Skeletons = ({ n = 3 }) => <div className="hfy-posts__list" aria-busy="true" aria-label="Loading posts" data-hfy-skeleton>{Array.from({ length: n }, (_, i) => <span className="hfy-skeleton" key={i} />)}</div>;
const msg = (e) => (e && e.message) || "Something went wrong. Please try again.";

/** Newest-first published posts with cursor paging, through useTimeline's page(). */
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
      setState((s) => ({ items: cursor ? [...s.items, ...r.items.filter((p) => !s.items.some((q) => q.id === p.id))] : r.items, cursor: r.cursor ?? null, status: "ready", error: null }));
    } catch (e) {
      setState((s) => ({ ...s, status: "error", error: msg(e) }));
    } finally { busy.current = false; }
  }, [timeline, key]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => { load(null); }, [load]);
  const remove = async (post) => {
    try { await source.delete(post.id); setState((s) => ({ ...s, items: s.items.filter((p) => p.id !== post.id) })); } catch (e) { setState((s) => ({ ...s, error: msg(e) })); }
  };
  return { ...state, reload: () => load(null), more: () => load(state.cursor), remove, prepend: (p) => setState((s) => ({ ...s, items: [p, ...s.items.filter((q) => q.id !== p.id)] })) };
}

export function PostList({ posts, link = true }) {
  const { items, cursor, status, error, more, remove } = posts;
  if (status === "loading") return <Skeletons />;
  return (
    <>
      {error && <Banner>{error}</Banner>}
      {status === "ready" && items.length === 0 && !error && <p className="hfy-posts__empty">No posts yet.</p>}
      <ul className="hfy-posts__list">
        {items.map((p) => (
          <li key={p.id}>
            <PostCard post={p} onDelete={p.can.delete ? remove : undefined} />
            {link && <a className="hfy-posts__open" href={postHref(p)}>View post and comments</a>}
          </li>
        ))}
      </ul>
      {cursor && <button type="button" className="hfy-posts__more" onClick={more} disabled={status === "more"}>{status === "more" ? "Loading" : "Load older posts"}</button>}
    </>
  );
}
