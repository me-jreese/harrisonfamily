// Person page island (HFY-TSK-066, flag personV2): notes through @io-kit/md and a kit comments thread on /api.
// Enhances the legacy SPA (11ty/js/person-page.js) after it renders; flag off => this bundle is never loaded.
import "@io-kit/comments/comments.css";
import { useEffect, useMemo, useState } from "react";
import { KitMarkdown } from "@io-kit/md/react";
import { userContentPolicy } from "@io-kit/comments";
import { Thread } from "@io-kit/comments/react";
import { api, getSession } from "../lib/api.js";
import { createHfyCommentSource } from "../lib/comment-source.js";
import { mountAt } from "../lib/mount.jsx";

// R18: record-id mentions (@I0044 / I0044) link to the person page. Module-level so the identity is stable.
export const linkify = { pattern: /\bI\d{4,}\b/, href: (id) => `/person/?id=${encodeURIComponent(id)}` };

export function Notes({ notes }) {
  return notes.map((n, i) => (
    <div className="card mb-3" key={i}><div className="card-body"><KitMarkdown source={n.raw} policy={userContentPolicy} className="hfy-note" /></div></div>
  ));
}

export function Comments({ id }) {
  const [session, setSession] = useState(undefined);
  const [admin, setAdmin] = useState(false);
  useEffect(() => { getSession().then(setSession); }, []);
  const sid = session?.authenticated ? session.sub : null;
  // The API does not expose roles; a moderator is whoever can delete someone else's comment (server-computed can.delete).
  const source = useMemo(() => createHfyCommentSource(api, { onList: (cs) => { if (sid && cs.some((c) => c.author.id !== sid && c.can.delete)) setAdmin(true); } }), [sid]);
  const viewer = sid ? { id: sid, label: session.label, ...(admin ? { roles: ["admin"] } : {}) } : null;
  if (session === undefined) return null;
  const returnTo = encodeURIComponent(location.pathname + location.search);
  return (
    <section className="hfy-comments" aria-label="Comments" data-hfy-comments>
      <h2 className="h4 mb-3">Comments</h2>
      {!viewer && <p className="hfy-signin" data-hfy-signin><a className="btn btn-primary" href={`/auth/login?returnTo=${returnTo}`}>Sign in to comment</a></p>}
      <Thread threadId={`person:${id}`} source={source} viewer={viewer} readOnly={!viewer} linkify={linkify} adminIds={[]} />
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
  try {
    const token = window.HFYFeatureFlags?.requireSessionToken?.();
    const res = await fetch(`/person/${encodeURIComponent(id)}.json`, { credentials: "include", headers: token ? { "X-HFY-Session": token } : {} });
    const person = res.ok ? await res.json() : null;
    const notes = (person?.notes || []).filter((n) => n && typeof n.raw === "string" && n.raw.trim());
    if (notes.length) {
      Array.from(panel.children).forEach((el) => { if (el.tagName !== "H2") el.remove(); });
      mountAt((h) => panel.appendChild(h), <Notes notes={notes} />, "hfy-notes-v2");
    }
  } catch { /* keep the legacy notes */ }
  mountAt((h) => { h.className = "mt-4"; panel.closest(".col-lg-8")?.appendChild(h) ?? content.appendChild(h); }, <Comments id={id} />, "hfy-person-comments");
}
init();
