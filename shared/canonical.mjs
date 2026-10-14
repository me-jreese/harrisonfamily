// Canonical JSON and the object hash (HFY-PLN-002 sync.md 4.1; task projection-py). The Python original is
// gramps/hfygramps/canonical.py; both pass the vectors in shared/canonical.vectors.json byte for byte.
//
// The format: keys sorted by code point (not by UTF-16 code unit, which orders astral characters before U+E000..U+FFFF), no
// whitespace, non-ASCII characters as they are, the escapes of JSON.stringify (the same as Python's json.dumps with
// ensure_ascii=False). Only values both languages agree on are accepted; anything else throws a CanonicalError:
//   - integers only, within +/-(2**53 - 1): no fraction, NaN or infinity (Gramps latitude and longitude are strings);
//   - plain objects with string keys, arrays, strings, booleans and null; no undefined, function, symbol, bigint, Date or Map;
//   - strings with no lone surrogate (it has no UTF-8 form).
// Pure ESM with no import, so it runs in a browser, a Worker and Lambda. sha256 uses globalThis.crypto.subtle (async).

export class CanonicalError extends Error {
  constructor(message) {
    super(message);
    this.name = "CanonicalError";
  }
}

/** Top-level keys that are never part of a stored object: Gramps' own last-changed stamp is derived (sync.md 6.1). */
export const DERIVED_KEYS = ["change"];

const MAX_DEPTH = 200;

function wellFormed(s) {
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (c >= 0xd800 && c <= 0xdbff) {
      const d = i + 1 < s.length ? s.charCodeAt(i + 1) : 0;
      if (d < 0xdc00 || d > 0xdfff) return false;
      i++;
    } else if (c >= 0xdc00 && c <= 0xdfff) {
      return false;
    }
  }
  return true;
}

/** Compare two strings by code point. */
export function compareCodePoints(a, b) {
  let i = 0;
  let j = 0;
  while (i < a.length && j < b.length) {
    const x = a.codePointAt(i);
    const y = b.codePointAt(j);
    if (x !== y) return x < y ? -1 : 1;
    i += x > 0xffff ? 2 : 1;
    j += y > 0xffff ? 2 : 1;
  }
  if (i < a.length) return 1;
  if (j < b.length) return -1;
  return 0;
}

function str(s) {
  if (!wellFormed(s)) throw new CanonicalError("string with a lone surrogate");
  return JSON.stringify(s);
}

function write(value, depth) {
  if (depth > MAX_DEPTH) throw new CanonicalError("nesting too deep");
  if (value === null) return "null";
  switch (typeof value) {
    case "boolean":
      return value ? "true" : "false";
    case "number":
      if (!Number.isSafeInteger(value)) throw new CanonicalError("numbers must be integers within +/-(2**53 - 1)");
      return String(value === 0 ? 0 : value);
    case "string":
      return str(value);
    case "object": {
      if (Array.isArray(value)) return "[" + value.map((v) => write(v, depth + 1)).join(",") + "]";
      const proto = Object.getPrototypeOf(value);
      if (proto !== Object.prototype && proto !== null) throw new CanonicalError("only plain objects are supported");
      const keys = Object.keys(value).sort(compareCodePoints);
      return "{" + keys.map((k) => str(k) + ":" + write(value[k], depth + 1)).join(",") + "}";
    }
    default:
      throw new CanonicalError("unsupported type " + typeof value);
  }
}

/** The canonical JSON text of a value. */
export function canonicalJson(value) {
  return write(value, 0);
}

/** The canonical JSON as UTF-8 bytes: what is hashed and what is stored. */
export function canonicalBytes(value) {
  return new TextEncoder().encode(canonicalJson(value));
}

async function sha256Hex(bytes) {
  const digest = await globalThis.crypto.subtle.digest("SHA-256", bytes);
  return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, "0")).join("");
}

/** sha256 hex of the canonical bytes of a value. */
export function canonicalSha256(value) {
  return sha256Hex(canonicalBytes(value));
}

/** A stored object: a shallow copy without the derived top-level keys. */
export function storedForm(obj) {
  const out = {};
  for (const k of Object.keys(obj)) if (!DERIVED_KEYS.includes(k)) out[k] = obj[k];
  return out;
}

/** obj_json of a projected Gramps object (no change key). */
export function objectJson(obj) {
  return canonicalJson(storedForm(obj));
}

/** hash of a projected Gramps object: sha256 hex of its obj_json. */
export function objectHash(obj) {
  return sha256Hex(new TextEncoder().encode(objectJson(obj)));
}
