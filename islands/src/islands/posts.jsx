// /posts/ page (HFY-TSK-067, flag postsV2): the list, or one post (?id=<ulid>) with the kit comments thread for post:<ulid>.
import { useEffect, useState } from "react";
import { ArticleView, PostCard } from "@io-kit/content/react";
import { mountIsland } from "../lib/mount.jsx";
import { Banner, PostList, Skeletons, source, usePosts } from "../lib/posts-ui.jsx";
import { Comments } from "../lib/comments-ui.jsx";

function One({ id }) {
  const [s, setS] = useState({ status: "loading" });
  useEffect(() => { source.get(id).then((post) => setS({ status: "ready", post }), (e) => setS({ status: "error", error: e.code === "not_found" ? "That post was not found." : e.message })); }, [id]);
  if (s.status === "loading") return <Skeletons n={1} />;
  if (s.status === "error") return <><Banner>{s.error}</Banner><a className="hfy-posts__open" href="/posts/">All posts</a></>;
  const { post } = s;
  return (
    <article data-hfy-post>
      <a className="hfy-posts__open" href="/posts/">All posts</a>
      {post.type === "post" ? <PostCard post={post} /> : <ArticleView post={post} />}
      <Comments subject={`post:${post.id}`} />
    </article>
  );
}

function List() {
  const posts = usePosts({});
  return <PostList posts={posts} />;
}

export function Posts() {
  const id = new URLSearchParams(location.search).get("id");
  return <div className="hfy-posts" data-hfy-posts>{id ? <One id={id} /> : <><h1 className="h3 my-3">Posts</h1><List /></>}</div>;
}

const run = () => mountIsland("posts", Posts);
if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", run, { once: true }); else run();
