// Pure, zero-dependency validator helpers (HFY-PLN-002 D2-10). Relative imports only: this file runs unchanged in the browser
// (bundled by islands/), in hfy-api and the auth edge (staged as src/shared/), and in a Cloudflare Worker.
// shared/shared.test.mjs enforces that rule for every shared/*.mjs.

/** True for a plain object (not null, not an array). */
export const isRecord = (v) => typeof v === "object" && v !== null && !Array.isArray(v);

/** A string trimmed of surrounding whitespace; anything that is not a string yields "". */
export const cleanText = (v) => (typeof v === "string" ? v.trim() : "");

/** `v` cleaned and checked against {min = 0, max = Infinity} length: `{ ok: true, value }` or `{ ok: false, reason }`. */
export function boundedText(v, { min = 0, max = Infinity } = {}) {
  const value = cleanText(v);
  if (value.length < min) return { ok: false, reason: "too-short" };
  if (value.length > max) return { ok: false, reason: "too-long" };
  return { ok: true, value };
}
