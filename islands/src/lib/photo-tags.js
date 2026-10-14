// Photo tags (HFY-TSK-169, flag photoTags; HFY-PLN-002 surfaces 8): the pure part. Geometry, rect words, the role the site
// reads from the page's family tree, and the cleaning of mediaGallery[].tags[] into what the island shows. No DOM, so a node test
// can pin it (tests/photo-tags.test.mjs). Everything here returns plain strings and numbers; the island puts them into the page as
// text nodes only (a tag name, an attribute or a note is member-editable text and is never parsed as markup).

/** The tree vocabulary the DS uses for a person's place on a page; "family" is anyone else. */
export const ROLES = ["focus", "parent", "grandparent", "sibling", "spouse", "child", "grandchild", "family"];

/** At most this many tags show a label for every region at once; above it only the active region's label shows. */
export const DENSE_ABOVE = 12;

const MAX_LIST = 50;
const finite = (n) => typeof n === "number" && Number.isFinite(n);

/**
 * The rectangle an image occupies inside its box, as { x, y, w, h } in the box's pixels.
 * `contain` (the gallery's 4:5 box): s = min(boxW/natW, boxH/natH), centred. `cover` scales by the larger ratio, so x and y can be
 * negative; `fill` is the whole box. A box or image without a size falls back to the whole box.
 */
export function containedRect(boxW, boxH, natW, natH, fit = "contain") {
  const whole = { x: 0, y: 0, w: finite(boxW) ? boxW : 0, h: finite(boxH) ? boxH : 0 };
  if (!(boxW > 0) || !(boxH > 0) || !(natW > 0) || !(natH > 0) || fit === "fill") return whole;
  const s = fit === "cover" ? Math.max(boxW / natW, boxH / natH) : Math.min(boxW / natW, boxH / natH);
  const w = natW * s;
  const h = natH * s;
  return { x: (boxW - w) / 2, y: (boxH - h) / 2, w, h };
}

/**
 * A Gramps MediaRef rect ([x1, y1, x2, y2], integer percent of the image) as [x1, y1, x2, y2] with the corners ordered (min, max)
 * and every value held in 0..100. null when it is missing, malformed or has no area: such a tag is a person tagged without an area.
 */
export function normalizeRect(rect) {
  if (!Array.isArray(rect) || rect.length !== 4 || !rect.every(finite)) return null;
  const clamp = (n) => Math.min(100, Math.max(0, n));
  const [a, b, c, d] = rect.map(clamp);
  const out = [Math.min(a, c), Math.min(b, d), Math.max(a, c), Math.max(b, d)];
  return out[2] > out[0] && out[3] > out[1] ? out : null;
}

/** A normalised rect in pixels on the contained image: { left, top, width, height } relative to the same origin as `contained`. */
export function regionBox(rect, contained) {
  const [x1, y1, x2, y2] = rect;
  return {
    left: contained.x + (x1 / 100) * contained.w,
    top: contained.y + (y1 / 100) * contained.h,
    width: ((x2 - x1) / 100) * contained.w,
    height: ((y2 - y1) / 100) * contained.h
  };
}

/** The rect in words and numbers, for example `upper left · 12% from the left, 8% from the top, 20% wide, 25% tall`. */
export function areaWords(rect) {
  if (!rect) return "no area marked";
  const [x1, y1, x2, y2] = rect;
  const cx = (x1 + x2) / 2;
  const cy = (y1 + y2) / 2;
  const h = cx < 100 / 3 ? "left" : cx > 200 / 3 ? "right" : "center";
  const v = cy < 100 / 3 ? "upper" : cy > 200 / 3 ? "lower" : "middle";
  const where = v === "middle" ? (h === "center" ? "center" : h) : h === "center" ? v : `${v} ${h}`;
  const n = (x) => Math.round(x);
  return `${where} · ${n(x1)}% from the left, ${n(y1)}% from the top, ${n(x2 - x1)}% wide, ${n(y2 - y1)}% tall`;
}

/** The sentence fragment for the site's own line (never presented as Gramps data). */
export const ROLE_PHRASE = {
  focus: "this page's person",
  parent: "a parent of this page's person",
  grandparent: "a grandparent of this page's person",
  sibling: "a sibling of this page's person",
  spouse: "the spouse of this page's person",
  child: "a child of this page's person",
  grandchild: "a grandchild of this page's person",
  family: "family"
};

const idOf = (p) => (p && typeof p.grampsId === "string" ? p.grampsId : null);
const families = (list) => (Array.isArray(list) ? list : []);

/**
 * The tagged person's place relative to the page's person, read from person.familyTree: focus (the person themself), parent,
 * grandparent (a parent's parent), sibling, spouse, child, grandchild (a child's child), else family. The tree is one generation
 * either way, so a grandparent or grandchild is found only when the relative's own `parentFamilies` / `spouseFamilies` is present.
 */
export function roleOf(person, grampsId) {
  if (!grampsId || !person) return "family";
  if (grampsId === person.grampsId) return "focus";
  const tree = person.familyTree || {};
  const me = person.grampsId;
  for (const fam of families(tree.parentFamilies)) {
    for (const parent of [fam.father, fam.mother]) {
      if (idOf(parent) === grampsId) return "parent";
      for (const up of families(parent && parent.parentFamilies)) {
        if ([up.father, up.mother].some((g) => idOf(g) === grampsId)) return "grandparent";
      }
    }
    if (families(fam.children).some((c) => idOf(c) === grampsId && grampsId !== me)) return "sibling";
  }
  for (const fam of families(tree.spouseFamilies)) {
    for (const spouse of [fam.father, fam.mother]) {
      if (idOf(spouse) === grampsId && grampsId !== me) return "spouse";
    }
    for (const child of families(fam.children)) {
      if (idOf(child) === grampsId) return "child";
      for (const down of families(child && child.spouseFamilies)) {
        if (families(down.children).some((g) => idOf(g) === grampsId)) return "grandchild";
      }
    }
  }
  return "family";
}

const text = (v) => (typeof v === "string" ? v.trim() : typeof v === "number" && Number.isFinite(v) ? String(v) : "");
const first = (...vals) => vals.map(text).find(Boolean) || "";

function textList(list, pick) {
  if (!Array.isArray(list)) return [];
  const out = [];
  for (const item of list) {
    const s = typeof item === "object" && item ? first(...pick.map((k) => item[k])) : text(item);
    if (s) out.push(s);
    if (out.length >= MAX_LIST) break;
  }
  return out;
}

/** The MediaRef attributes as [{ type, value }]; an entry with neither a type nor a value is dropped. */
export function cleanAttributes(list) {
  if (!Array.isArray(list)) return [];
  const out = [];
  for (const a of list) {
    if (!a || typeof a !== "object") continue;
    const type = text(a.type);
    const value = text(a.value);
    if (type || value) out.push({ type, value });
    if (out.length >= MAX_LIST) break;
  }
  return out;
}

/** "type: value", or whichever half exists. */
export const attributeLine = (a) => (a.type && a.value ? `${a.type}: ${a.value}` : a.type || a.value);

export const SOURCE_LINE = { gramps: "tagged in the family tree", site: "tagged on the site" };

/**
 * One tag as the island shows it: { grampsId, name, rect (normalised or null), isPrimary, attributes, notes, citations, source, role,
 * area }. `notes` are the MediaRef notes (already guarded text from the data build) and `citations` their titles. A tag with neither
 * a name nor a Gramps id is dropped (null).
 */
export function tagView(tag, person) {
  if (!tag || typeof tag !== "object") return null;
  const grampsId = text(tag.grampsId) || null;
  const name = text(tag.name);
  if (!name && !grampsId) return null;
  const rect = normalizeRect(tag.rect);
  return {
    grampsId,
    name: name || "someone",
    rect,
    isPrimary: tag.isPrimary === true,
    attributes: cleanAttributes(tag.attributes),
    notes: textList(tag.notes, ["text", "raw", "string"]),
    citations: textList(tag.citations, ["title", "text"]),
    source: tag.source === "site" ? "site" : "gramps",
    role: roleOf(person, grampsId),
    area: areaWords(rect)
  };
}

/** The cleaned tags of one mediaGallery item, in the order the data lists them. */
export function tagsOf(media, person) {
  if (!media || !Array.isArray(media.tags)) return [];
  return media.tags.map((t) => tagView(t, person)).filter(Boolean);
}

/** Tag indexes with an area, top to bottom and then left to right: the order the lightbox regions are in the DOM, so Tab walks them. */
export function readingOrder(views) {
  return views
    .map((v, i) => ({ v, i }))
    .filter(({ v }) => v.rect)
    .sort((a, b) => a.v.rect[1] - b.v.rect[1] || a.v.rect[0] - b.v.rect[0] || a.i - b.i)
    .map(({ i }) => i);
}

/** `/person/?id=<id>` for a tag that names a Gramps id, else null. */
export const personHref = (view) => (view.grampsId ? `/person/?id=${encodeURIComponent(view.grampsId)}` : null);

/** The lightbox region's accessible name: `{name}, {role}. open their page`. */
export const regionLabel = (view) => `${view.name}, ${view.role === "focus" ? "this person" : view.role}. open their page`;

/**
 * Where each label goes. `items` are { x, y, w, h (the region's box), lw, lh (the label's size) } in the layer's pixels, `bounds` is
 * { w, h } of the image. A label sits under its region, flips above near the bottom edge, is clamped inside the image, and a
 * label that would cover an earlier one is moved down (above: up) by the overlap, greedily, in the order given.
 * Returns [{ left, top }] in the layer's pixels, in the same order.
 */
export function stackLabels(items, bounds, gap = 0) {
  const placed = [];
  const clampTo = (v, size, max) => Math.max(0, Math.min(v, Math.max(0, max - size)));
  return items.map((it) => {
    const left = clampTo(it.x, it.lw, bounds.w);
    const below = it.y + it.h + it.lh <= bounds.h;
    let top = below ? it.y + it.h : it.y - it.lh;
    for (let pass = 0; pass < items.length; pass += 1) {
      const hit = placed.find((p) => left < p.right && left + it.lw > p.left && top < p.bottom && top + it.lh > p.top);
      if (!hit) break;
      top = below ? hit.bottom + gap : hit.top - it.lh - gap;
    }
    top = clampTo(top, it.lh, bounds.h);
    placed.push({ left, right: left + it.lw, top, bottom: top + it.lh });
    return { left, top };
  });
}
