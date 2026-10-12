// Homepage timeline (HFY-TSK-067, flag postsV2): published posts, newest first, cursor paging. Cards link to /posts/?id=<ulid>.
import { mountAt } from "../lib/mount.jsx";
import { PostList, usePosts } from "../lib/posts-ui.jsx";

export function Timeline() {
  const posts = usePosts({});
  return (
    <section className="hfy-posts" aria-label="Family timeline" data-hfy-timeline>
      <h2 className="h4 mb-3">Latest from the family</h2>
      <PostList posts={posts} />
    </section>
  );
}

const run = () => mountAt((h) => (document.querySelector("main") || document.body).appendChild(h), <Timeline />, "hfy-timeline");
if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", run, { once: true }); else run();
