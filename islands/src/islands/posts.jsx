// /posts/ page (HFY-TSK-067, flag postsV2): the list, or one post (?id=<ulid>) with the kit comments thread for post:<ulid>.
import { useEffect, useState } from "react";
import { ArticleView, PostCard } from "@io-kit/content/react";
import { mountIsland } from "../lib/mount.jsx";
import { Banner, CARD_LABELS, COPY, PostList, Skeletons, formatTime, friendlyError, source, usePosts, useTimeTitles } from "../lib/posts-ui.jsx";
import { Comments } from "../lib/comments-ui.jsx";

function One({ id }) {
  const [s, setS] = useState({ status: "loading" });
  const ref = useTimeTitles();
  useEffect(() => { source.get(id).then((post) => setS({ status: "ready", post }), (e) => setS({ status: "error", error: e.code === "not_found" ? COPY.notFound : friendlyError(e) })); }, [id]);
  const back = <a className="hfy-posts__open" href="/posts/">all posts</a>;
  return (
    <div ref={ref}>
      {s.status === "loading" && <Skeletons n={1} />}
      {s.status === "error" && <><Banner>{s.error}</Banner>{back}</>}
      {s.status === "ready" && (
        <article data-hfy-post>
          {back}
          <div className="hfy-posts__item">
            {s.post.type === "post" ? <PostCard post={s.post} labels={CARD_LABELS} formatTime={formatTime} /> : <ArticleView post={s.post} labels={CARD_LABELS} formatTime={formatTime} />}
          </div>
          <Comments subject={`post:${s.post.id}`} />
        </article>
      )}
    </div>
  );
}

function List() {
  const posts = usePosts({});
  return <PostList posts={posts} />;
}

export function Posts() {
  const id = new URLSearchParams(location.search).get("id");
  return <div className="hfy-posts" data-hfy-posts>{id ? <One id={id} /> : <><h1 className="hfy-h">posts</h1><List /></>}</div>;
}

const run = () => mountIsland("posts", Posts);
if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", run, { once: true }); else run();
