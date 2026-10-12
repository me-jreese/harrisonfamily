// Kit comments thread over /api/comments for any subject (person:<id> | post:<ulid>); shared by the person and posts islands.
import "@io-kit/comments/comments.css";
import { useEffect, useMemo, useState } from "react";
import { Thread } from "@io-kit/comments/react";
import { api, getSession } from "./api.js";
import { createHfyCommentSource } from "./comment-source.js";

// R18: record-id mentions (@I0044 / I0044) link to the person page. Module-level so the identity is stable.
export const linkify = { pattern: /\bI\d{4,}\b/, href: (id) => `/person/?id=${encodeURIComponent(id)}` };

export function Comments({ subject }) {
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
      <Thread threadId={subject} source={source} viewer={viewer} readOnly={!viewer} linkify={linkify} adminIds={[]} />
    </section>
  );
}
