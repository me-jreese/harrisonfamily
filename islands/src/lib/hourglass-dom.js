// The two tiny DOM helpers both hourglass trees draw with (HFY-TSK-379): the small tree on the person page (tree-hourglass.js) and the big tree (tree-hourglass-big.js).
// Plain DOM, no React: `h` makes an element (an attribute that is null or false is left off), `avatar` a person's face or initials.
export const px = (n) => `${n}px`;

export const h = (tag, cls, attrs, ...kids) => {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  for (const k in attrs) if (attrs[k] != null && attrs[k] !== false) e.setAttribute(k, attrs[k]);
  e.append(...kids.flat().filter(Boolean));
  return e;
};

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
