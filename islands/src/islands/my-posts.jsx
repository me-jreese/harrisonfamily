// Own-page posting (HFY-TSK-067, flag postsV2): on /person/?id=<gramps_id> when the viewer IS that person,
// a PostComposer (text + photos) and this member's posts. Others see nothing from this island.
import { useEffect, useState } from "react";
import { PostComposer } from "@io-kit/content/react";
import { api, getSession } from "../lib/api.js";
import { uploadPhoto } from "../lib/upload.js";
import { mountAt } from "../lib/mount.jsx";
import { Banner, PostList, source, usePosts } from "../lib/posts-ui.jsx";
import { CAPABILITIES } from "../lib/content-source.js";

const ACCEPT = "image/jpeg,image/png,image/webp,image/heic";

export function MyPosts({ id }) {
  const [me, setMe] = useState(undefined);
  const [error, setError] = useState(null);
  const posts = usePosts({ subject: id });
  useEffect(() => { getSession().then((s) => setMe(s.authenticated ? s.sub : null)); }, []);
  if (me !== id) return null;
  return (
    <section className="hfy-posts hfy-posts__mine" aria-label="My posts" data-hfy-my-posts>
      <h2 className="h4 mb-3">Share something</h2>
      {error && <Banner>{error}</Banner>}
      <div className="hfy-posts__composer">
        <PostComposer
          capabilities={CAPABILITIES}
          initial={undefined}
          accept={ACCEPT}
          maxAttachments={4}
          labels={{ subject: "About" }}
          onUpload={(file) => uploadPhoto(api, file)}
          onSubmit={async (input) => {
            setError(null);
            try { posts.prepend(await source.createDraft({ ...input, subject: id })); } catch (e) { setError(e.message || "Could not post."); throw e; }
          }}
        />
      </div>
      <PostList posts={posts} />
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
  mountAt((h) => { h.className = "mt-4"; panel.insertAdjacentElement("afterend", h); }, <MyPosts id={id} />, "hfy-my-posts");
}
init();
