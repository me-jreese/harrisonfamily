// WCAG 2.2 contrast helpers for the Family Card Navigator's non-text pairs (HFY-TSK-302, viz-mvp-visual-perf AC4; viz ADR 4.9).
// Pure functions: tree-contrast.test.mjs checks the maths, tree-contrast.spec.mjs feeds them the colours the built page resolves for the
// tokens it pins. (The kit ships no contrast helper in @io-kit/tokens 0.4.1; if a later kit version does, this file may be replaced by it.)

/** Linear-light value of one 0..255 sRGB channel (WCAG 2.2 relative luminance). */
const channel = (v) => {
  const c = v / 255;
  return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
};

/** Relative luminance of {r, g, b} (0..255). */
export const luminance = ({ r, g, b }) => 0.2126 * channel(r) + 0.7152 * channel(g) + 0.0722 * channel(b);

/** The WCAG contrast ratio of two {r, g, b} colours, 1 to 21. */
export function contrast(a, b) {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
}

/** Parses "#rgb", "#rrggbb" or "rgb(r, g, b)" / "rgba(r, g, b, a)" (comma or space separated) into {r, g, b}; alpha is composited over `over` when given. */
export function parseColor(text, over = null) {
  const s = String(text).trim().toLowerCase();
  let m = /^#([0-9a-f]{3})$/.exec(s);
  if (m) return { r: parseInt(m[1][0] + m[1][0], 16), g: parseInt(m[1][1] + m[1][1], 16), b: parseInt(m[1][2] + m[1][2], 16) };
  m = /^#([0-9a-f]{6})$/.exec(s);
  if (m) return { r: parseInt(m[1].slice(0, 2), 16), g: parseInt(m[1].slice(2, 4), 16), b: parseInt(m[1].slice(4, 6), 16) };
  m = /^rgba?\(\s*([\d.]+)[\s,]+([\d.]+)[\s,]+([\d.]+)(?:[\s,/]+([\d.]+%?))?\s*\)$/.exec(s);
  if (!m) throw new Error(`cannot parse the colour ${JSON.stringify(text)}`);
  const alpha = m[4] === undefined ? 1 : m[4].endsWith("%") ? parseFloat(m[4]) / 100 : parseFloat(m[4]);
  const [r, g, b] = [m[1], m[2], m[3]].map(Number);
  if (alpha >= 1 || !over) return { r, g, b };
  return { r: r * alpha + over.r * (1 - alpha), g: g * alpha + over.g * (1 - alpha), b: b * alpha + over.b * (1 - alpha) };
}

/** WCAG 2.2 non-text contrast (1.4.11) minimum. */
export const NON_TEXT_MIN = 3;
