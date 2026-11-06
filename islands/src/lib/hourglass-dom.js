// The two tiny DOM helpers both hourglass trees draw with (HFY-TSK-379): the small tree on the person page (tree-hourglass.js) and the big tree (tree-hourglass-big.js).
// Plain DOM, no React: `h` makes an element (an attribute that is null or false is left off), `avatar` a person's face or initials.
import { COPY } from "./hourglass-model.js";

export const px = (n) => `${n}px`;

export const h = (tag, cls, attrs, ...kids) => {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  for (const k in attrs) if (attrs[k] != null && attrs[k] !== false) e.setAttribute(k, attrs[k]);
  e.append(...kids.flat(2).filter(Boolean));
  return e;
};

/** A button (never a form submit) and a text link in the tree's link style. */
export const btn = (cls, attrs, ...kids) => h("button", cls, { type: "button", ...attrs }, ...kids);
export const lk = (href, ...kids) => h("a", "hfy-tree__lk", { href }, ...kids);

/** The face crop over the initials (a failed image takes itself away); `size` is the big tree's own diameter in px, else the CSS decides. */
export function avatar(c, size) {
  const a = h("span", "hfy-tree__av", { "aria-hidden": true }, c.initials);
  if (size) a.style.width = a.style.height = px(size);
  if (c.face) {
    const i = h("img", null, { src: c.face, alt: "", loading: "lazy", decoding: "async" });
    i.onerror = () => i.remove();
    a.append(i);
  }
  return a;
}

/** Place an absolutely positioned element: left and top, and width and height when given (px). */
export const box = (e, l, t, w, h) => {
  const s = e.style;
  s.left = px(l);
  s.top = px(t);
  if (w != null) { s.width = px(w); s.height = px(h); }
  return e;
};

/** A connector: a 2 px <i> under the cards, from a layout strip {x, y, w, h, dashed, rep}. */
export const strip = (s) => box(h("i", `hfy-tree__ln ${s.w > s.h ? "is-h" : "is-v"}${s.dashed ? " is-dash" : ""}${s.rep ? " is-rep" : ""}`), s.x, s.y, s.w, s.h);

/** Line weight (tree.line.w) and the two looks a line can have, spread onto a strip: dashed ("not known yet", a half brother's or sister's) and the gold repeat. */
export const LINE = 2;
export const DASH = { dashed: true };
export const REP = { rep: true };

/**
 * A comb between two rows: a stem down from each x in `tops` to the bar at `ym`, one bar across them and `drops`, and a drop from the bar to each x in
 * `drops` down to `h`. Strips are centred on their x, `y0` down from the comb's top. `st` is the look (DASH, REP or nothing). Returns [] with nothing to join.
 */
export function comb(tops, drops, h, st, ym = Math.round(h / 2), y0 = 0) {
  const xs = [...tops, ...drops];
  const mn = Math.min(...xs);
  const mx = Math.max(...xs);
  const s = (x, y, w, h2) => ({ x, y: y + y0, w, h: h2, ...st });
  return xs.length ? [...(mx - mn > 1 ? [s(mn - 1, ym - 1, mx - mn + 2, LINE)] : []), ...tops.map((x) => s(x - 1, 0, LINE, ym)), ...drops.map((x) => s(x - 1, ym, LINE, h - ym))] : [];
}

/** A card's insides: the face, then (when `text`) the name, the years and the relationship word (when `word`), then the "both sides" tag when `both`. */
export const body = (c, name, av, text, word, both) => [avatar(c, av), text && [h("span", "hfy-tree__nm", null, name), c.years && h("span", "hfy-tree__yr", null, c.years), word && c.word && h("span", "hfy-tree__wd", null, c.word)], both && h("span", "hfy-tree__both", null, COPY.bothSides)];

/** A ghost card's "know who? tell us" button: it answers with the thank-you through `say`. */
export const tell = (say) => {
  const b = btn("hfy-tree__lk", null, COPY.tellUs);
  b.onclick = () => say(COPY.thanks);
  return b;
};

/** A polite status line writer for `el`: the text stays six seconds. `.stop()` clears the timer. */
export const speaker = (el) => {
  let timer;
  const say = (t) => {
    el.textContent = t;
    clearTimeout(timer);
    timer = setTimeout(() => (el.textContent = ""), 6000);
  };
  say.stop = () => clearTimeout(timer);
  return say;
};
