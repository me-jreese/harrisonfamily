// Person page island (HFY-TSK-066, flag personV2): notes through @io-kit/md and a kit comments thread on /api.
// Enhances the legacy SPA (11ty/js/person-page.js) after it renders; flag off => this bundle is never loaded.
// contribV1 (HFY-TSK-188, social.md section 8) on: the comments move into #hfy-person-social beside the contributions host (lib/person-social.jsx)
// and the notes are clipped at the stories cap; off, the comments host stays the child before #hfy-person-social, as it was.
import { Comments } from "../lib/comments-ui.jsx";
import { KitMarkdown } from "../lib/hfy-markdown.jsx";
import { CappedSection } from "../lib/capped.jsx";
import { PersonSocial } from "../lib/person-social.jsx";
import { mountContribChip } from "../lib/contrib-chip.jsx";
import { mountAt, mountInto } from "../lib/mount.jsx";
import { mountTreeLink } from "../lib/tree-link.js";
import { mergedRedirect } from "../lib/merged-person.js";

// The Notes card stays the legacy person-page.js note markup (.card > .card-body inside .notes-panel), so the legacy theme
// partials style the island's notes and the no-JS / flag-off notes identically.
// PS-11: a note is member-written markdown, so it renders through the HFY SanitizePolicy (lib/hfy-markdown.jsx): no image is drawn from it
// and an href is https or http only (no mailto:).
export function Notes({ notes, capped = false }) {
  const cards = notes.map((n, i) => (
    <div className="card mb-3" key={i}><div className="card-body"><KitMarkdown source={n.raw} className="hfy-note" /></div></div>
  ));
  if (!capped) return cards;
  // Record notes come with the person JSON, so there is nothing to fetch: the stories cap only clips them.
  return <CappedSection label="show more notes" clipSelector=".hfy-notes" itemSelector=":scope > .card"><div className="hfy-notes">{cards}</div></CappedSection>;
}

const waitFor = (test) => new Promise((resolve) => {
  if (test()) return resolve();
  const mo = new MutationObserver(() => { if (test()) { mo.disconnect(); resolve(); } });
  mo.observe(document.documentElement, { subtree: true, childList: true, attributes: true, attributeFilter: ["class"] });
});

// A merged-away person's JSON is the stub {mergedInto} (merge-alias-redirect): follow it to the new id. The page's own hook does the same;
// both go to the same address, so whichever runs first wins. Returns true when the island must stop: the page is leaving, or the hop
// limit is spent (the legacy hook owns that case and shows its error line; the island never renders a stub as a page).
function followMerged(person, id) {
  const go = mergedRedirect(location.href, person, id);
  if (go?.limit) return true;
  if (!go?.url) return false;
  location.replace(go.url);
  return true;
}

// contribV1 (default off): true only when the resolved flags say so; a missing or failing flag script is off.
async function contribOn() {
  try {
    const resolve = window.HFYFeatureFlags?.resolveFlags;
    return typeof resolve === "function" && (await resolve())?.contribV1 === true;
  } catch { return false; }
}

async function init() {
  const id = new URLSearchParams(location.search).get("id");
  const content = document.getElementById("person-content");
  if (!id || !content) return;
  const flags = window.HFYFeatureFlags;
  const url = `/person/${encodeURIComponent(id)}.json`;
  const init = { credentials: "same-origin" }; // the io_id cookie is the credential at the edge data gate (HFY-TSK-080)
  let person = null;
  const loading = (async () => {
    try {
      // HFY-R66: refresh + one retry on a gate 401; background load (the legacy page already rendered), so it never redirects.
      const res = await (flags?.dataFetch ? flags.dataFetch(url, init, { interactive: false }) : fetch(url, init));
      person = res.ok ? await res.json() : null;
    } catch { person = null; }
    return person;
  })();
  // A stub never renders a page, so the redirect cannot wait for the notes panel.
  if (followMerged(await loading, id)) return;
  await waitFor(() => !content.classList.contains("d-none") && content.querySelector(".notes-panel"));
  const panel = content.querySelector(".notes-panel");
  const social = await contribOn();
  try {
    const notes = (person?.notes || []).filter((n) => n && typeof n.raw === "string" && n.raw.trim());
    if (notes.length) {
      Array.from(panel.children).forEach((el) => { if (el.tagName !== "H2") el.remove(); });
      mountAt((h) => panel.appendChild(h), <Notes notes={notes} capped={social} />, "hfy-notes-v2");
    }
  } catch { /* keep the legacy notes */ }
  if (social) {
    // The host is the person-page-mount-points one: the last child of #person-content, hidden until an island fills it. person-page.js owns it,
    // so a missing host is a regression there: say so rather than build one here; the comments then stay where the flag-off page has them.
    const host = document.getElementById("hfy-person-social");
    if (!host) {
      console.error("hfy person: #hfy-person-social is missing, so the social row is not drawn");
    } else {
      host.hidden = false;
      mountInto(host, <PersonSocial id={id} />);
      // HFY-TSK-189: the hero chip "N contributions" in the heading chip slot, linking to the column just drawn.
      mountContribChip(id, person);
      return;
    }
  }
  // Interface contract (f): the comments host follows life, family, photos and stories; #hfy-person-social (HFY-TSK-137) stays the last child.
  mountAt((h) => { const social = document.getElementById("hfy-person-social"); if (social && social.parentElement === content) content.insertBefore(h, social); else content.appendChild(h); }, <Comments subject={`person:${id}`} />, "hfy-person-comments");
}
init();
// HFY-TSK-201: the "see in the family tree" link, shown only with familyViz (lib/tree-link.js).
mountTreeLink();
