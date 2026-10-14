// Photo tags island (HFY-TSK-169, flag photoTags; HFY-PLN-002 surfaces 8): region overlays on the gallery thumbnails, interactive
// region links in the lightbox, and a names list with hover cards under each tagged photo, from person.mediaGallery[].tags[].
// It listens to the two events of the person page's mount points (HFY-TSK-137) and edits nothing of the page:
//   hfy:person-rendered { personId, person, sections }   after every render: the thumbnails
//   hfy:lightbox-media  { index, media, img, box }        whenever the lightbox shows an image: the lightbox layer
// The island loads after the flags resolve, which can be after the first render, and the page does not replay its events (HFY-TSK-137);
// when the gallery is already on the page and no event has arrived it reads the person once itself (the same gated JSON the page read,
// the same ?id=) so the first render is not missed. The first event, whenever it comes, wins over that read.
import "../photo-tags.css";
import { mountGallery, refreshLightbox, showLightbox } from "../lib/photo-tags-ui.js";

let person = null;

document.addEventListener("hfy:person-rendered", (e) => {
  person = (e.detail && e.detail.person) || null;
  if (person) {
    mountGallery(person);
    refreshLightbox(person);
  }
});
document.addEventListener("hfy:lightbox-media", (e) => showLightbox(e.detail, person));

async function catchUp() {
  const id = new URLSearchParams(location.search).get("id");
  const grid = document.getElementById("person-media-grid");
  if (!id || !grid || !grid.querySelector(".gallery-item")) return;
  try {
    const flags = window.HFYFeatureFlags;
    const edge = (await (flags && flags.dataFetchInit && flags.dataFetchInit())) || null;
    const token = edge ? null : flags && flags.requireSessionToken && flags.requireSessionToken();
    const url = `/person/${encodeURIComponent(id)}.json`;
    const init = edge || { credentials: "include", headers: token ? { "X-HFY-Session": token } : {} };
    const res = await (flags && flags.dataFetch ? flags.dataFetch(url, init, { interactive: false }) : fetch(url, init));
    const data = res.ok ? await res.json() : null;
    // A merged person's JSON is the stub {mergedInto}: the page is redirecting, there is nothing to draw.
    if (data && !person && !data.mergedInto && Array.isArray(data.mediaGallery)) {
      person = data;
      mountGallery(person);
      refreshLightbox(person);
    }
  } catch { /* the page stands without tag overlays */ }
}
catchUp();
