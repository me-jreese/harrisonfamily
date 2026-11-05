// The faces tab's model (HFY-TSK-308, viz-v2-faces-tab, flag familyVizFaces; viz ADR 4.4). Pure: no DOM, no fetch, so tests/tree-faces-tab.test.mjs runs
// every case in node. It reads only the published graph: `photoEdges` ([{media, people}], graph.json minor 2) and each person's `face`. The builder
// has already left a private Media, a private MediaRef, a private person and a RECT_INVALID tag out of that block; a face that is null (RECT_INVALID,
// a 0-byte placeholder or missing media) is shown as initials, never a crop guessed from a region. No region geometry lives here: the photo's
// regions are drawn by lib/photo-tags-ui.js (surf-photo-tags-ui), the one implementation.
import { faceUrl, initials } from "./navigator-model.js";

/** At most this many face slots in the first view; "show more photos" adds the next groups. */
export const FIRST_VIEW_FACES = 24;
/** The person files tried, in order, for a photo's tags: one is enough in practice, a few cover a private or missing page. */
export const TRY_PEOPLE = 3;

/**
 * The mosaic: one group per `photoEdges` entry, in the graph's order, each with the people the graph holds (a person it does not hold, a repeated
 * id and a malformed entry are skipped). A group left with nobody is dropped. Returns [{media, index, people: [{id, name, initials, face}]}] where
 * `face` is a served URL or null.
 */
export function facesGroups(graph) {
  const edges = graph && graph.data && graph.data.photoEdges;
  if (!Array.isArray(edges)) return [];
  const groups = [];
  const seen = new Set();
  for (const e of edges) {
    if (!e || typeof e.media !== "string" || !Array.isArray(e.people) || seen.has(e.media)) continue;
    seen.add(e.media);
    const people = [];
    const ids = new Set();
    for (const id of e.people) {
      if (typeof id !== "string" || ids.has(id)) continue;
      const p = graph.person(id);
      if (!p) continue;
      ids.add(id);
      people.push({ id, name: p.name, initials: initials(p), face: faceUrl(p.face) });
    }
    if (people.length) groups.push({ media: e.media, index: groups.length + 1, people });
  }
  return groups;
}

/** How many groups the first view holds: as many as fit in `limit` face slots, and always at least one. */
export function firstViewCount(groups, limit = FIRST_VIEW_FACES) {
  let slots = 0;
  let n = 0;
  for (const g of groups) {
    if (n > 0 && slots + g.people.length > limit) break;
    slots += g.people.length;
    n += 1;
  }
  return n;
}

/** The media ids of the groups `id` is in. */
export function mediaOf(groups, id) {
  return new Set(groups.filter((g) => g.people.some((p) => p.id === id)).map((g) => g.media));
}

/** Everyone in the mosaic once, by name (then id): the order of the face picker. */
export function facePeople(groups) {
  const all = new Map();
  for (const g of groups) for (const p of g.people) if (!all.has(p.id)) all.set(p.id, p);
  return [...all.values()].sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : a.id < b.id ? -1 : 1));
}

const EXT = { "image/jpeg": ".jpg", "image/png": ".png", "image/webp": ".webp", "image/gif": ".gif" };

/** The mediaGallery item of a person's JSON that is the photo `media` (a Gramps media id), or null. */
export function galleryItem(person, media) {
  const list = person && Array.isArray(person.mediaGallery) ? person.mediaGallery : [];
  return list.find((m) => m && m.grampsId === media) || null;
}

/** The served image URL of a gallery item (the person page's rule: handle plus the mime's extension, under /media/), or null. */
export function photoSrc(item) {
  if (!item) return null;
  const file = typeof item.s3Key === "string" && item.s3Key ? item.s3Key.split("/").pop() : typeof item.handle === "string" && item.handle ? `${item.handle}${EXT[item.mime] || ".jpg"}` : "";
  return /^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(file) ? `/media/${file}` : null;
}
