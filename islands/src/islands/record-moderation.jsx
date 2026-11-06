// Record moderation island (HFY-TSK-216, flags moderationV1 and moderationRecordsV1; BRD2 D2-19, R-32): an admin hides, unhides or asks about a record story
// (a note) and a photo on the person page. It listens to the same two events of the person page's mount points as the photo tags island and edits nothing of
// the page's own markup:
//   hfy:person-rendered { personId, person, sections }   after every render: the stories' controls
//   hfy:lightbox-media  { index, media, img, box }        whenever the lightbox shows an image: the photo's control
// It does nothing for anyone who is not an admin. The hidden set (what moderation hides from members) comes from GET /api/records/Person/by-id/<id>, which
// the server answers to an admin with every hidden item still in place and a `hidden` list; the server re-checks admin on every POST.
import "../posts.css"; // the island-owned primitives (.hfy-btn) the controls use
import "../moderation.css";
import { api } from "../lib/api.js";
import { loadModerator } from "../lib/moderation-ui.jsx";
import { RECORDS_FLAG } from "../lib/record-moderation.js";
import { createState, hiddenSetOf, mountPhoto, mountStories } from "../lib/record-moderation-ui.jsx";

let person = null;
let state = createState([]);
let ready = null; // Promise<boolean>: the flags, the admin check and the hidden set of the current page

async function enabled() {
  let flags = {};
  try { flags = (await globalThis.HFYFeatureFlags?.resolveFlags?.()) ?? {}; } catch { flags = {}; }
  if (flags?.[RECORDS_FLAG] !== true) return false;
  const m = await loadModerator();
  return m.enabled === true && m.viewer?.admin === true;
}

async function onRendered(detail) {
  person = detail?.person ?? null;
  const id = typeof detail?.personId === "string" ? detail.personId : person?.grampsId;
  if (!person || !id) return;
  ready = (async () => {
    if (!(await enabled())) return false;
    try { state.set(hiddenSetOf(await api.get(`/records/Person/by-id/${encodeURIComponent(id)}`))); } catch { /* no hidden badges; the controls still work */ }
    return true;
  })();
  if (!(await ready.catch(() => false))) return;
  mountStories(person, state);
  // The notes island mounts after the page's first render: fill the stories again when the panel's contents change.
  const panel = document.querySelector("#person-stories-section .notes-panel");
  if (panel && !panel.dataset.hfyRecordModWatch) {
    panel.dataset.hfyRecordModWatch = "1";
    let queued = false;
    new MutationObserver((records) => {
      // The controls' own DOM is not a reason to look again.
      if (records.every((r) => r.target.closest?.(".hfy-mod__story"))) return;
      if (queued) return;
      queued = true;
      requestAnimationFrame(() => { queued = false; if (person) mountStories(person, state); });
    }).observe(panel, { childList: true, subtree: true });
  }
}

let seen = false;
document.addEventListener("hfy:person-rendered", (e) => { seen = true; onRendered(e.detail); });
// The loader can run after the page's first render, whose event is then gone: read the same person file the page did (the browser has it cached) and carry on.
(async () => {
  const id = new URLSearchParams(location.search).get("id");
  if (seen || !id || !/^[A-Za-z0-9._-]{1,64}$/.test(id) || !document.querySelector("#person-stories-section")) return;
  try {
    const url = `/person/${encodeURIComponent(id)}.json`;
    const res = await (typeof globalThis.HFYFeatureFlags?.dataFetch === "function" ? globalThis.HFYFeatureFlags.dataFetch(url, { credentials: "include" }, { interactive: false }) : fetch(url, { credentials: "include" }));
    if (res.ok && !seen) onRendered({ personId: id, person: await res.json() });
  } catch { /* the page stands without the controls */ }
})();
document.addEventListener("hfy:lightbox-media", async (e) => {
  if (!ready || !(await ready.catch(() => false))) return;
  mountPhoto(person, e.detail, state);
});
