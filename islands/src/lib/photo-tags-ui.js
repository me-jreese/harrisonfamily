// Photo tags (HFY-TSK-169, flag photoTags; HFY-PLN-002 surfaces 8.2): the DOM part. Fills the person page's gallery and lightbox from
// the cleaned tags (lib/photo-tags.js). It adds nodes next to the page's own and never edits the page's: a decorative layer inside
// each thumbnail button, a names list under each tagged photo, and, in the lightbox, a layer of interactive region links, a names
// list under the caption and a "names" toggle in the header. Each names-list chip is the name as a link to the person's page
// (ruling P2-R53, which applies P2-R46 to the names under a photo; lib/person-name.js) and, beside it, a 44px icon button that shows
// the tag's data and highlights its region.
//
// Every string that came from the data (a name, an attribute, a note, a citation title) is put in with textContent. Nothing here
// builds markup from data, so an <img onerror> value is shown as the text it is.
import {
  DENSE_ABOVE,
  ROLE_PHRASE,
  SOURCE_LINE,
  attributeLine,
  containedRect,
  personHref,
  readingOrder,
  regionBox,
  regionLabel,
  stackLabels,
  tagsOf
} from "./photo-tags.js";
import { personNameNode } from "./person-name.js";

let serial = 0;
const nextId = (prefix) => `${prefix}-${(serial += 1)}`;

function node(tag, className, text) {
  const n = document.createElement(tag);
  if (className) n.className = className;
  if (text != null) n.textContent = text;
  return n;
}

const hoverCapable = () => typeof matchMedia === "function" && matchMedia("(hover: hover)").matches;
const finePointer = (e) => e.pointerType !== "touch" && hoverCapable();
const HIDE_DELAY_MS = 160;
const CARD_MARGIN = 8;

// ---------------------------------------------------------------------------------------------------------------- details
/**
 * The tag data as text nodes: the Gramps data (area, attributes, notes, citations, source) and, apart, the site's own line. With `link`
 * (the pinned panel), the name heading the data is a link to the person's page when the tag names a Gramps person id (HFY-TSK-323,
 * ruling P2-R46: a listed name is a link; lib/person-name.js); the hovercard is a tooltip, plain text only, so there it stays text.
 */
export function buildDetails(view, { link = false } = {}) {
  const box = node("div", "photo-tags__details");
  const who = node("p", "photo-tags__who");
  who.append(personNameNode(document, { id: link ? view.grampsId : null, name: view.name }));
  if (view.isPrimary) who.append(document.createTextNode(" · their portrait"));
  box.append(who);
  const facts = node("dl", "photo-tags__facts");
  const row = (term, values) => {
    if (!values.length) return;
    facts.append(node("dt", "photo-tags__term", term));
    for (const v of values) facts.append(node("dd", "photo-tags__value", v));
  };
  row("area", [view.area]);
  row("attributes", view.attributes.map(attributeLine));
  row("notes", view.notes);
  row("citations", view.citations);
  row("source", [SOURCE_LINE[view.source]]);
  box.append(facts);
  // "family" is the fallback for someone outside this page's tree, not a relationship the site knows: no line rather than a placeholder.
  if (view.role && view.role !== "family" && ROLE_PHRASE[view.role]) {
    const site = node("p", "photo-tags__site");
    site.append(node("span", "photo-tags__site-label", "from this site, not the tag:"), document.createTextNode(` ${ROLE_PHRASE[view.role]}`));
    box.append(site);
  }
  return box;
}

// ---------------------------------------------------------------------------------------------------------------- hover cards
const scopes = new Set();

/** The scopes whose names list is still in the document; a gallery re-render leaves the old lists detached, so those are dropped here. */
function liveScopes() {
  for (const s of scopes) {
    if (!s.root.isConnected) {
      s.hideCard();
      scopes.delete(s);
    }
  }
  return scopes;
}

/** Hides every hovercard (Esc). Returns true when one was showing. */
export function dismissCards() {
  let any = false;
  for (const s of liveScopes()) any = s.hideCard() || any;
  return any;
}
if (typeof document !== "undefined") {
  // Capture phase: Esc closes the card first and the lightbox (Bootstrap's own Esc) only when no card was showing (WCAG 1.4.13).
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape" && dismissCards()) {
      e.preventDefault();
      e.stopPropagation();
    }
  }, true);
  // The card is position:fixed and placed once when it opens; a scroll (the page, the lightbox) or a resize moves its anchor, so it is placed again.
  const reposition = () => { for (const s of liveScopes()) s.reposition(); };
  window.addEventListener("scroll", reposition, { capture: true, passive: true });
  window.addEventListener("resize", reposition, { passive: true });
}

function placeCard(card, anchor) {
  card.style.left = "0px";
  card.style.top = "0px";
  card.hidden = false;
  const a = anchor.getBoundingClientRect();
  const c = card.getBoundingClientRect();
  const vw = document.documentElement.clientWidth;
  const vh = window.innerHeight;
  let left = Math.min(Math.max(CARD_MARGIN, a.left), Math.max(CARD_MARGIN, vw - c.width - CARD_MARGIN));
  let top = a.bottom;
  if (top + c.height + CARD_MARGIN > vh && a.top - c.height >= CARD_MARGIN) top = a.top - c.height;
  top = Math.max(CARD_MARGIN, top);
  card.style.left = `${left}px`;
  card.style.top = `${top}px`;
}

// ---------------------------------------------------------------------------------------------------------------- names list
/**
 * The names list for one photo: `ul.photo-tags__names`, one chip (`li.photo-tags__item`) per tag, the hovercards inside the chips
 * and one pinned panel per tag after the list. A chip holds the name, `a.hfy-person-name.photo-tags__name` to the person's page
 * (a span when the tag names no Gramps person id; ruling P2-R53), and `button.photo-tags__show` ("show where {name} is in the
 * photo"), which does what the whole chip did before: keyboard focus shows the hovercard, a click, tap or Enter pins the panel, and
 * it carries aria-expanded and aria-controls. A fine-pointer hover anywhere on the chip shows the card too. `regions` maps a tag
 * index to its region element (or nothing), kept live by the caller, so a hover, a focus and a pin highlight the region.
 * Returns { root, list, regions, setActive, hideCard, destroy }.
 */
export function buildNames(views, { regions = new Map(), listId = nextId("photo-tags-list") } = {}) {
  const root = node("div", "photo-tags__block");
  const list = node("ul", "photo-tags__names");
  list.id = listId;
  list.setAttribute("aria-label", "in this photo");
  root.append(list);
  const chips = [];
  const buttons = [];
  const cards = [];
  const panels = [];
  let pinned = -1;
  let hovered = -1;
  let shown = -1;
  let anchored = null;
  let timer = 0;

  const setActive = (i, on) => {
    const region = regions.get(i);
    if (region) region.classList.toggle("is-active", on);
    chips[i].classList.toggle("is-active", on);
  };
  const refresh = (i) => setActive(i, i === pinned || i === hovered);
  const hideCard = () => {
    window.clearTimeout(timer);
    if (shown < 0) return false;
    const i = shown;
    shown = -1;
    anchored = null;
    cards[i].hidden = true;
    for (const el of [buttons[i], regions.get(i)]) if (el) el.removeAttribute("aria-describedby");
    return true;
  };
  const showCard = (i, anchor) => {
    window.clearTimeout(timer);
    if (shown >= 0 && shown !== i) {
      const prev = shown;
      hideCard();
      hovered = hovered === prev ? -1 : hovered;
      refresh(prev);
    }
    shown = i;
    anchored = anchor;
    hovered = i;
    refresh(i);
    placeCard(cards[i], anchor);
    for (const el of [buttons[i], regions.get(i)]) if (el) el.setAttribute("aria-describedby", cards[i].id);
  };
  const reposition = () => {
    if (shown < 0) return;
    if (anchored && anchored.isConnected) placeCard(cards[shown], anchored);
    else hideCard();
  };
  const leave = (i) => {
    window.clearTimeout(timer);
    timer = window.setTimeout(() => {
      if (hovered === i) hovered = -1;
      hideCard();
      refresh(i);
    }, HIDE_DELAY_MS);
  };
  const togglePin = (i) => {
    const open = pinned !== i;
    if (pinned >= 0) {
      const prev = pinned;
      pinned = -1;
      panels[prev].hidden = true;
      buttons[prev].setAttribute("aria-expanded", "false");
      refresh(prev);
    }
    hideCard();
    if (open) {
      pinned = i;
      panels[i].hidden = false;
      buttons[i].setAttribute("aria-expanded", "true");
    }
    refresh(i);
  };

  views.forEach((view, i) => {
    const li = node("li", "photo-tags__item");
    const name = personNameNode(document, { id: view.grampsId, name: view.name, className: "photo-tags__name" });
    const button = node("button", "photo-tags__show");
    button.type = "button";
    button.setAttribute("aria-label", `show where ${view.name} is in the photo`);
    button.setAttribute("aria-expanded", "false");
    const icon = node("span", "photo-tags__show-icon");
    icon.setAttribute("aria-hidden", "true");
    button.append(icon);
    const card = node("div", "photo-tags__card");
    card.id = nextId("photo-tags-card");
    card.setAttribute("role", "tooltip");
    card.hidden = true;
    card.append(buildDetails(view));
    const panel = node("div", "photo-tags__panel");
    panel.id = nextId("photo-tags-panel");
    panel.hidden = true;
    panel.append(buildDetails(view, { link: true }));
    const href = personHref(view);
    if (href) {
      const open = node("a", "photo-tags__open", `open ${view.name}'s page`);
      open.href = href;
      panel.append(open);
    }
    button.setAttribute("aria-controls", panel.id);
    // The card sits under the chip, whichever half of it (the name or the button) the pointer or the focus is on. Not on the <li>: the
    // card is inside it, so entering the card would re-anchor a card that a lightbox region opened.
    for (const el of [name, button]) {
      el.addEventListener("pointerenter", (e) => { if (finePointer(e)) showCard(i, li); });
      el.addEventListener("pointerleave", (e) => { if (finePointer(e)) leave(i); });
    }
    button.addEventListener("focus", () => { if (button.matches(":focus-visible")) showCard(i, li); });
    button.addEventListener("blur", () => { hovered = -1; hideCard(); refresh(i); });
    button.addEventListener("click", () => togglePin(i));
    card.addEventListener("pointerenter", () => window.clearTimeout(timer));
    card.addEventListener("pointerleave", (e) => { if (finePointer(e)) leave(i); });
    li.append(name, button, card);
    list.append(li);
    root.append(panel);
    chips.push(li);
    buttons.push(button);
    cards.push(card);
    panels.push(panel);
  });

  const scope = {
    root,
    hideCard,
    reposition,
    // The lightbox regions share this list's cards: hover or keyboard focus on a region shows the same card, anchored to it.
    regionEnter: (i, region) => showCard(i, region),
    regionLeave: (i) => leave(i)
  };
  scopes.add(scope);
  return { root, list, regions, setActive: refresh, hideCard, scope, destroy: () => { hideCard(); scopes.delete(scope); root.remove(); } };
}

// ---------------------------------------------------------------------------------------------------------------- layers
/**
 * A layer of regions over an image. `interactive` makes each region a link to the person's page (the lightbox); otherwise a
 * decorative span (the layer is aria-hidden). Returns { layer, regions (Map tag index -> element), order, layout }.
 */
function buildLayer(views, { interactive, img, host }) {
  const layer = node("span", `photo-tags__layer${interactive ? " photo-tags__layer--lightbox" : ""}`);
  if (interactive) {
    layer.setAttribute("role", "group");
    layer.setAttribute("aria-label", "people in this photo");
  } else {
    layer.setAttribute("aria-hidden", "true");
  }
  const order = readingOrder(views);
  const regions = new Map();
  const labels = new Map();
  for (const i of order) {
    const view = views[i];
    const href = interactive ? personHref(view) : null;
    const region = node(href ? "a" : "span", "photo-tags__region");
    if (href) {
      region.href = href;
      region.setAttribute("aria-label", regionLabel(view));
    }
    region.dataset.role = view.role;
    region.dataset.tag = String(i);
    const label = node("span", "photo-tags__label", view.name);
    region.append(label);
    layer.append(region);
    regions.set(i, region);
    labels.set(i, label);
  }
  if (order.length > DENSE_ABOVE) layer.classList.add("photo-tags__layer--dense");

  function layout() {
    const r = img.getBoundingClientRect();
    if (built.broken || !img.complete || !img.naturalWidth || !r.width || !r.height) {
      layer.hidden = true;
      return;
    }
    layer.hidden = false;
    const cs = getComputedStyle(img);
    const bl = parseFloat(cs.borderLeftWidth) || 0;
    const bt = parseFloat(cs.borderTopWidth) || 0;
    const w = r.width - bl - (parseFloat(cs.borderRightWidth) || 0);
    const h = r.height - bt - (parseFloat(cs.borderBottomWidth) || 0);
    const hr = host.getBoundingClientRect();
    layer.style.left = `${r.left + bl - (hr.left + host.clientLeft)}px`;
    layer.style.top = `${r.top + bt - (hr.top + host.clientTop)}px`;
    layer.style.width = `${w}px`;
    layer.style.height = `${h}px`;
    const contained = containedRect(w, h, img.naturalWidth, img.naturalHeight);
    const boxes = new Map();
    for (const i of order) {
      const b = regionBox(views[i].rect, contained);
      boxes.set(i, b);
      const el = regions.get(i);
      el.style.left = `${b.left}px`;
      el.style.top = `${b.top}px`;
      el.style.width = `${b.width}px`;
      el.style.height = `${b.height}px`;
      labels.get(i).style.maxWidth = `${contained.w}px`;
    }
    const items = order.map((i) => {
      const b = boxes.get(i);
      const l = labels.get(i);
      return { x: b.left - contained.x, y: b.top - contained.y, w: b.width, h: b.height, lw: l.offsetWidth, lh: l.offsetHeight };
    });
    const spots = stackLabels(items, { w: contained.w, h: contained.h });
    order.forEach((i, k) => {
      const b = boxes.get(i);
      const border = regions.get(i).clientLeft;
      labels.get(i).style.left = `${spots[k].left + contained.x - b.left - border}px`;
      labels.get(i).style.top = `${spots[k].top + contained.y - b.top - border}px`;
    });
  }
  const built = { layer, regions, order, layout, broken: false, stop: null };
  return built;
}

/** Lays a layer out now, on the image's load, and whenever the image or its host changes size. An image that failed (the page swaps in a placeholder) loses its layer for good. */
function track(img, host, built) {
  const run = () => built.layout();
  const failed = () => { built.broken = true; built.layout(); };
  img.addEventListener("load", run);
  img.addEventListener("error", failed);
  const ro = typeof ResizeObserver === "function" ? new ResizeObserver(run) : null;
  if (ro) {
    ro.observe(img);
    ro.observe(host);
  }
  built.stop = () => {
    img.removeEventListener("load", run);
    img.removeEventListener("error", failed);
    if (ro) ro.disconnect();
  };
  run();
  if (document.fonts && document.fonts.ready) document.fonts.ready.then(run, () => {});
}

// ---------------------------------------------------------------------------------------------------------------- gallery
/** Overlays and names lists for every tagged photo in `#person-media-grid`. Safe to call again after a render; a figure is done once. */
export function mountGallery(person) {
  liveScopes();
  const grid = document.getElementById("person-media-grid");
  const items = person && Array.isArray(person.mediaGallery) ? person.mediaGallery : [];
  if (!grid) return 0;
  let tagged = 0;
  grid.querySelectorAll(".gallery-item").forEach((figure, index) => {
    if (figure.hasAttribute("data-photo-tags")) return;
    const views = tagsOf(items[index], person);
    if (!views.length) return;
    figure.setAttribute("data-photo-tags", "");
    tagged += 1;
    const trigger = figure.querySelector("button.media-lightbox-trigger");
    const img = trigger && trigger.querySelector("img");
    // A missing image has no trigger and no layer; the names list still renders.
    const regions = new Map();
    const names = buildNames(views, { regions });
    const caption = figure.querySelector(".gallery-caption");
    (caption || trigger || figure.lastElementChild || figure).after(names.root);
    if (!img) return;
    const built = buildLayer(views, { interactive: false, img, host: trigger });
    for (const [i, el] of built.regions) regions.set(i, el);
    trigger.append(built.layer);
    const describedBy = (img.getAttribute("aria-describedby") || "").split(/\s+/).filter(Boolean);
    img.setAttribute("aria-describedby", [...describedBy, names.list.id].join(" "));
    track(img, trigger, built);
  });
  return tagged;
}

// ---------------------------------------------------------------------------------------------------------------- lightbox
let lightbox = null; // { layer, names, built, token } for the photo now shown
let namesOn = null; // the header toggle's state; null until chosen, then it carries across photos
let toggleBtn = null;
let closeWatch = false;

function clearLightbox() {
  if (!lightbox) return;
  if (lightbox.built && lightbox.built.stop) lightbox.built.stop();
  if (lightbox.layer) lightbox.layer.remove();
  if (lightbox.names) lightbox.names.destroy();
  if (lightbox.img) lightbox.img.removeAttribute("aria-describedby");
  lightbox = null;
  if (toggleBtn) toggleBtn.hidden = true;
}

function ensureToggle(modal) {
  if (toggleBtn && toggleBtn.isConnected) return toggleBtn;
  toggleBtn = node("button", "photo-tags__toggle", "names");
  toggleBtn.type = "button";
  toggleBtn.hidden = true;
  toggleBtn.addEventListener("click", () => {
    namesOn = !namesOn;
    applyToggle();
  });
  const host = modal.querySelector(".lightbox-actions") || modal.querySelector(".modal-header");
  if (host) host.insertBefore(toggleBtn, host.firstChild);
  return toggleBtn;
}

function applyToggle() {
  if (!toggleBtn) return;
  toggleBtn.setAttribute("aria-pressed", namesOn ? "true" : "false");
  if (lightbox && lightbox.layer) lightbox.layer.classList.toggle("photo-tags__layer--names", namesOn === true);
}

/** The person arrived after the lightbox opened (or changed): draws the photo now shown again, so its roles are the page's. */
export function refreshLightbox(person) {
  const detail = lightbox && lightbox.detail;
  if (!detail || !detail.img || detail.img.classList.contains("d-none")) return;
  showLightbox(detail, person);
}

/**
 * Renders the tags of the photo now in the lightbox. `detail` is the hfy:lightbox-media detail { index, media, img, box }; `person` is
 * the page's person (for the site's relationship line).
 */
export function showLightbox(detail, person) {
  clearLightbox();
  const { media, img, box } = detail || {};
  if (!media || !img || !box) return;
  const views = tagsOf(media, person);
  if (!views.length) return;
  const modal = img.closest(".modal") || document.getElementById("mediaLightbox");
  if (modal && !closeWatch) {
    closeWatch = true;
    modal.addEventListener("hidden.bs.modal", clearLightbox);
    // The page hides the image (d-none) while the next photo loads; the regions must not float over the spinner.
    new MutationObserver(() => { if (lightbox && img.classList.contains("d-none")) clearLightbox(); }).observe(img, { attributes: true, attributeFilter: ["class"] });
  }
  const regions = new Map();
  const names = buildNames(views, { regions });
  const built = buildLayer(views, { interactive: true, img, host: box });
  for (const [i, el] of built.regions) {
    regions.set(i, el);
    el.addEventListener("pointerenter", (e) => { if (finePointer(e)) names.scope.regionEnter(i, el); });
    el.addEventListener("pointerleave", (e) => { if (finePointer(e)) names.scope.regionLeave(i); });
    el.addEventListener("focus", () => { if (el.matches(":focus-visible")) names.scope.regionEnter(i, el); });
    el.addEventListener("blur", () => names.scope.regionLeave(i));
  }
  const caption = document.getElementById("mediaLightboxCaption");
  if (caption && caption.parentElement) caption.after(names.root);
  else box.after(names.root);
  img.setAttribute("aria-describedby", names.list.id);
  if (built.order.length) box.append(built.layer);
  lightbox = { layer: built.order.length ? built.layer : null, names, built, img, detail };
  if (modal) {
    const btn = ensureToggle(modal);
    if (namesOn === null) namesOn = typeof matchMedia === "function" && matchMedia("(pointer: coarse)").matches;
    btn.hidden = !built.order.length;
    applyToggle();
  }
  if (built.order.length) track(img, box, built);
}
