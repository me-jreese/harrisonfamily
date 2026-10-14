// The signed-out "new here? ask to join." line (HFY-TSK-140, flag accessRequests; surfaces 7.10), rendered by the loader on /, /about/
// and /contact/ so the Eleventy output is never edited. It shows only when the edge session has settled as signed out: a member, a
// pending probe, and an unreachable edge all see nothing. The link is a plain /join/; the email is asked on that page, in a POST body.
import "./join-entry.css";
import { mountAt } from "../lib/mount.jsx";
import { useEdgeSession } from "../lib/edge-session.js";
import { ACTION, JOIN_HREF, LEAD, entryTarget } from "../lib/join-entry.js";

export function JoinEntry() {
  const session = useEdgeSession();
  if (!session || session.authenticated === true) return null;
  return (
    <p className="hfy-join-entry" data-hfy-join-entry>
      {LEAD}<a className="hfy-join-entry__link" href={JOIN_HREF}>{ACTION}</a>
    </p>
  );
}

const run = () => {
  const t = entryTarget(document, window.location.pathname);
  if (!t) return;
  mountAt((h) => t.host.insertAdjacentElement(t.position, h), <JoinEntry />, "hfy-join-entry");
};
if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", run, { once: true }); else run();
