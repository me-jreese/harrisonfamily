// /posts/ page (HFY-TSK-067, flag postsV2): the list, or one post (?id=<ulid>) with the kit comments thread for post:<ulid>.
import { useEffect, useState } from "react";
import { ArticleView } from "@io-kit/content/react";
import { mountIsland } from "../lib/mount.jsx";
import { Banner, CARD_PROPS, COPY, PostList, PostRow, Skeletons, friendlyError, source, usePosts, useTimeTitles } from "../lib/posts-ui.jsx";
import { ContribLine } from "../lib/contrib-line.jsx";
import { Comments } from "../lib/comments-ui.jsx";

function One({ id }) {
  const [s, setS] = useState({ status: "loading" });
  const ref = useTimeTitles();
  useEffect(() => { source.get(id).then((post) => setS({ status: "ready", post }), (e) => setS({ status: "error", error: e.code === "not_found" ? COPY.notFound : friendlyError(e) })); }, [id]);
  const [deleteError, setDeleteError] = useState(null);
  const back = <a className="hfy-posts__open" href="/posts/">all posts</a>;
  // The author deletes from here as in the feed (the same inline "delete this post?"); once it is gone there is nothing left to show,
  // so the page goes back to the feed. A failed delete stays a banner and the post stays.
  const remove = async (post) => {
    try {
      await source.delete(post.id);
      location.assign("/posts/");
      return true;
    } catch (e) {
      setDeleteError(friendlyError(e));
      return false;
    }
  };
  return (
    <div ref={ref}>
      {s.status === "loading" && <Skeletons n={1} />}
      {s.status === "error" && <><Banner>{s.error}</Banner>{back}</>}
      {s.status === "ready" && (
        <article data-hfy-post>
          {/* the page's heading for assistive tech (the post itself has none); the visible structure is the post and its comments */}
          <h1 className="hfy-vh">post</h1>
          {back}
          {deleteError && <Banner>{deleteError}</Banner>}
          {s.post.type === "post"
            ? <ul className="hfy-posts__list"><PostRow post={s.post} link={false} remove={remove} /></ul>
            : <div className="hfy-posts__item"><ArticleView post={s.post} {...CARD_PROPS} /></div>}
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
  return <div className="hfy-posts" data-hfy-posts>{id ? <One id={id} /> : <><h1 className="hfy-h">posts</h1><ContribLine /><List /></>}</div>;
}

const run = () => mountIsland("posts", Posts);
if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", run, { once: true }); else run();
