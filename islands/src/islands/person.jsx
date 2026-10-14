// Person page island (HFY-TSK-066, flag personV2): notes through @io-kit/md and a kit comments thread on /api.
// Enhances the legacy SPA (11ty/js/person-page.js) after it renders; flag off => this bundle is never loaded.
import { KitMarkdown } from "@io-kit/md/react";
import { userContentPolicy } from "@io-kit/comments";
import { Comments } from "../lib/comments-ui.jsx";
import { mountAt } from "../lib/mount.jsx";
import { mountTreeLink } from "../lib/tree-link.js";

// The Notes card stays the legacy person-page.js note markup (.card > .card-body inside .notes-panel), so the legacy theme
// partials style the island's notes and the no-JS / flag-off notes identically.
export function Notes({ notes }) {
  return notes.map((n, i) => (
    <div className="card mb-3" key={i}><div className="card-body"><KitMarkdown source={n.raw} policy={userContentPolicy} className="hfy-note" /></div></div>
  ));
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
    const flags = window.HFYFeatureFlags;
    const url = `/person/${encodeURIComponent(id)}.json`;
    const init = { credentials: "same-origin" }; // the io_id cookie is the credential at the edge data gate (HFY-TSK-080)
    // HFY-R66: refresh + one retry on a gate 401; background load (the legacy page already rendered), so it never redirects.
    const res = await (flags?.dataFetch ? flags.dataFetch(url, init, { interactive: false }) : fetch(url, init));
    const person = res.ok ? await res.json() : null;
    const notes = (person?.notes || []).filter((n) => n && typeof n.raw === "string" && n.raw.trim());
    if (notes.length) {
      Array.from(panel.children).forEach((el) => { if (el.tagName !== "H2") el.remove(); });
      mountAt((h) => panel.appendChild(h), <Notes notes={notes} />, "hfy-notes-v2");
    }
  } catch { /* keep the legacy notes */ }
  // Interface contract (f): the comments host follows life, family, photos and stories; #hfy-person-social (HFY-TSK-137) stays the last child.
  mountAt((h) => { const social = document.getElementById("hfy-person-social"); if (social && social.parentElement === content) content.insertBefore(h, social); else content.appendChild(h); }, <Comments subject={`person:${id}`} />, "hfy-person-comments");
}
init();
// HFY-TSK-201: the "see in the family tree" link, shown only with familyViz (lib/tree-link.js).
mountTreeLink();
