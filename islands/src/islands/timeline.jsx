// Homepage timeline (HFY-TSK-067, flag postsV2): published posts, newest first, cursor paging. Cards link to /posts/?id=<ulid>.
//
// The home page is public. Signed out, the timeline renders NOTHING: the hero already offers "sign in", and a gate here would name the
// wrong thing ("this page is family-only") in a danger banner announced as an alert on every public visit. The authV2 edge session is
// asked first (HFYFeatureFlags.edgeSession, shared with the rest of the page), so a signed-out visitor never sees the section flash in;
// without authV2 the posts request answers 401 and the section is dropped the same way.
import { useEffect, useState } from "react";
import { edgeSignedOut } from "../lib/api.js";
import { mountAt } from "../lib/mount.jsx";
import { COPY, PostList, usePosts } from "../lib/posts-ui.jsx";

function Feed() {
  const posts = usePosts({});
  if (posts.error === COPY.signedOut) return null;
  return (
    <section className="hfy-posts" aria-labelledby="hfy-timeline-h" data-hfy-timeline>
      <h2 className="hfy-h" id="hfy-timeline-h">latest from the family</h2>
      <PostList posts={posts} />
    </section>
  );
}

export function Timeline() {
  const [signedOut, setSignedOut] = useState(undefined);
  useEffect(() => {
    let live = true;
    edgeSignedOut().then((out) => { if (live) setSignedOut(out); });
    return () => { live = false; };
  }, []);
  return signedOut === false ? <Feed /> : null;
}

// The page's own <main> (never the shell's scroller, which also holds the footer): the timeline sits under the hero, above the footer.
const run = () => mountAt((h) => (document.querySelector("main:not([data-io-scroller])") || document.body).appendChild(h), <Timeline />, "hfy-timeline");
if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", run, { once: true }); else run();
