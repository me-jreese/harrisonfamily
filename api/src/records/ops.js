// EditOp engine (HFY-TSK-234, edit-ops-engine): keyed list addressing, apply, inverse, three-way rebase and Gramps
// handle minting. Format: editing design section 5.3; rebase table: section 7.5.
//
// PURE. No AWS import, no network, no filesystem, no clock beyond Date.now() for a handle, and no import of any
// kind: it runs under `node --test` and in a browser (canonical JSON and SHA-256 are implemented here, so the editor
// and the API compute the same key hashes).
//
// Nothing calls this module yet. It is not reachable from any route; its first caller is `edit-gramps-semantics`.
//
// Ops operate on a map of objects `{ "Person:<handle>": <Gramps JSON>, ... }`. An EditOp is
//   { id, op: "set"|"add"|"remove"|"move"|"create"|"delete", obj: "Person:<h>"|"new:1", cls?, path?, base?, base_hash?,
//     base_version?, sets?, value?, before? }
// and its `path` is an RFC 6901 pointer whose list segments are KEYS, never positions:
//   @ref=<handle>[#<n>][:<hash12>]  a *_ref_list element by its `ref`. n is the occurrence among equal refs (default
//                                   0 when it is the only one). With :<hash12> the element's content must still hash
//                                   to it. MediaRef elements (media_list) REQUIRE #n and :<hash12> (two tags of one
//                                   person in one photo are two elements); a media_list key without the hash is an
//                                   invalid_path. The other ref lists use the plain form unless refs repeat, so only
//                                   media_list matches the sync merge key (`ref#n` + hash) exactly.
//   @=<string>                      an element of a handle list (family_list, note_list, ...)
//   @k=<hash12>                     first 12 hex of sha256(canonical element), for the other secondary lists
// Every key is computed against the objects the ops are applied to at the start of the call (the "base"), so a key
// still names the same element after an earlier op in the same batch moved it or edited it. A key that no longer
// matches is a conflict, never a different element.
// An op with `seq: true` is the exception: its keys are relative to the state just before it, i.e. after the ops
// ahead of it in the list. Inverse ops are all `seq`, because they undo a batch one step at a time.

export const OP_KINDS = Object.freeze(["set", "add", "remove", "move", "create", "delete"]);

// Conflict and invalid reasons. Reasons in INVALID_REASONS mean the op itself is malformed, not that the data moved.
export const REASONS = Object.freeze({
  invalidOp: "invalid_op",
  invalidPath: "invalid_path",
  missingBase: "missing_base",
  missingVersion: "missing_version",
  missingObject: "missing_object",
  noSuchPath: "no_such_path",
  notAList: "not_a_list",
  keyNotFound: "key_not_found",
  staleKey: "stale_key",
  ambiguousKey: "ambiguous_key",
  keyExists: "key_exists",
  baseMismatch: "base_mismatch",
  contentChanged: "content_changed",
  hashMismatch: "hash_mismatch",
  versionChanged: "version_changed",
  objectExists: "object_exists",
});
export const INVALID_REASONS = Object.freeze(new Set(["invalid_op", "invalid_path", "missing_base"]));

// Which list fields hold which kind of element (editing design section 5.3). Any other array of objects is keyed @k.
export const REF_LISTS = Object.freeze(new Set(["event_ref_list", "child_ref_list", "media_list", "placeref_list", "person_ref_list", "reporef_list"]));
export const SINGLE_REF_LISTS = Object.freeze(new Set(["child_ref_list"])); // one child per ref; the others may repeat a ref
export const STRING_LISTS = Object.freeze(new Set(["family_list", "parent_family_list", "note_list", "citation_list", "tag_list"]));

export class OpsError extends Error {
  constructor(code, message) {
    super(message || code);
    this.name = "OpsError";
    this.code = code;
  }
}

// ---------------------------------------------------------------------------------------------------------------
// Canonical JSON and SHA-256 (isomorphic)
// ---------------------------------------------------------------------------------------------------------------

function cmpCodePoints(a, b) {
  // Python's sorted() orders str keys by code point; JS orders by UTF-16 unit. They differ for astral characters.
  const ia = a[Symbol.iterator]();
  const ib = b[Symbol.iterator]();
  for (;;) {
    const x = ia.next();
    const y = ib.next();
    if (x.done || y.done) return x.done === y.done ? 0 : x.done ? -1 : 1;
    const d = x.value.codePointAt(0) - y.value.codePointAt(0);
    if (d) return d;
  }
}

// Same bytes as the sync domain's canonical JSON (sorted keys, no spaces, raw non-ASCII). Integers only.
export function canonicalJson(v) {
  if (v === null || typeof v === "boolean" || typeof v === "string") return JSON.stringify(v);
  if (typeof v === "number") {
    if (!Number.isFinite(v)) throw new OpsError(REASONS.invalidOp, "non-finite number in JSON value");
    return JSON.stringify(v);
  }
  if (Array.isArray(v)) return "[" + v.map(canonicalJson).join(",") + "]";
  if (typeof v === "object") {
    const keys = Object.keys(v).sort(cmpCodePoints);
    return "{" + keys.map((k) => JSON.stringify(k) + ":" + canonicalJson(v[k])).join(",") + "}";
  }
  throw new OpsError(REASONS.invalidOp, `value of type ${typeof v} is not JSON`);
}

const PRIMES = (() => {
  const out = [];
  for (let n = 2; out.length < 64; n++) if (out.every((p) => n % p)) out.push(n);
  return out;
})();
const K256 = Uint32Array.from(PRIMES, (p) => Math.floor((Math.cbrt(p) % 1) * 4294967296));
const H256 = Uint32Array.from(PRIMES.slice(0, 8), (p) => Math.floor((Math.sqrt(p) % 1) * 4294967296));

export function sha256Hex(text) {
  const bytes = new TextEncoder().encode(text);
  const len = bytes.length;
  const padded = ((len + 9 + 63) >> 6) << 6;
  const buf = new Uint8Array(padded);
  buf.set(bytes);
  buf[len] = 0x80;
  const dv = new DataView(buf.buffer);
  dv.setUint32(padded - 8, Math.floor((len * 8) / 4294967296));
  dv.setUint32(padded - 4, (len * 8) >>> 0);
  const h = Uint32Array.from(H256);
  const w = new Uint32Array(64);
  const rotr = (x, n) => (x >>> n) | (x << (32 - n));
  for (let off = 0; off < padded; off += 64) {
    for (let i = 0; i < 16; i++) w[i] = dv.getUint32(off + i * 4);
    for (let i = 16; i < 64; i++) {
      const s0 = rotr(w[i - 15], 7) ^ rotr(w[i - 15], 18) ^ (w[i - 15] >>> 3);
      const s1 = rotr(w[i - 2], 17) ^ rotr(w[i - 2], 19) ^ (w[i - 2] >>> 10);
      w[i] = (w[i - 16] + s0 + w[i - 7] + s1) >>> 0;
    }
    let [a, b, c, d, e, f, g, hh] = h;
    for (let i = 0; i < 64; i++) {
      const S1 = rotr(e, 6) ^ rotr(e, 11) ^ rotr(e, 25);
      const ch = (e & f) ^ (~e & g);
      const t1 = (hh + S1 + ch + K256[i] + w[i]) >>> 0;
      const S0 = rotr(a, 2) ^ rotr(a, 13) ^ rotr(a, 22);
      const maj = (a & b) ^ (a & c) ^ (b & c);
      const t2 = (S0 + maj) >>> 0;
      hh = g; g = f; f = e; e = (d + t1) >>> 0; d = c; c = b; b = a; a = (t1 + t2) >>> 0;
    }
    h[0] += a; h[1] += b; h[2] += c; h[3] += d; h[4] += e; h[5] += f; h[6] += g; h[7] += hh;
  }
  return Array.from(h, (x) => x.toString(16).padStart(8, "0")).join("");
}

export const contentHash = (v) => sha256Hex(canonicalJson(v));
export const hash12 = (v) => contentHash(v).slice(0, 12);
// The store's object hash: sha256 of the canonical object without its `change` key (sync design section 5).
export function hashObject(obj) {
  const { change, ...rest } = obj; // eslint-disable-line no-unused-vars
  return contentHash(rest);
}

export function deepClone(v) {
  if (Array.isArray(v)) return v.map(deepClone);
  if (v && typeof v === "object") {
    const o = {};
    // an own "__proto__" key (JSON.parse makes one) must stay an own key, not set the clone's prototype
    for (const k of Object.keys(v)) {
      if (k === "__proto__") Object.defineProperty(o, k, { value: deepClone(v[k]), enumerable: true, writable: true, configurable: true });
      else o[k] = deepClone(v[k]);
    }
    return o;
  }
  return v;
}
const deepEqual = (a, b) => canonicalJson(a) === canonicalJson(b);

// ---------------------------------------------------------------------------------------------------------------
// Handle minting (Gramps create_id: "%08x%08x" % (int(time*10000), rand63), lowercase hex)
// ---------------------------------------------------------------------------------------------------------------

function defaultRandom63() {
  const [hi, lo] = globalThis.crypto.getRandomValues(new Uint32Array(2));
  return (BigInt(hi & 0x7fffffff) << 32n) | BigInt(lo);
}

// opts.now() is milliseconds; opts.random63() returns a BigInt in [0, 2^63). Both are injectable for tests.
export function mintHandle(opts = {}) {
  const now = opts.now ? opts.now() : Date.now();
  const rand = opts.random63 ? opts.random63() : defaultRandom63();
  return Math.floor(now * 10).toString(16).padStart(8, "0") + BigInt(rand).toString(16).padStart(8, "0");
}
// 11 or 12 hex digits of time, then 8 to 16 of random: the shape Gramps' own create_id() produces.
export const HANDLE_SHAPE = /^[0-9a-f]{19,28}$/;

// ---------------------------------------------------------------------------------------------------------------
// Paths and key segments
// ---------------------------------------------------------------------------------------------------------------

const esc = (s) => String(s).replace(/~/g, "~0").replace(/\//g, "~1");
const unesc = (s) => s.replace(/~1/g, "/").replace(/~0/g, "~");

export function parsePath(path) {
  if (typeof path !== "string") throw new OpsError(REASONS.invalidPath, "path must be a string");
  if (path === "") return [];
  if (path[0] !== "/") throw new OpsError(REASONS.invalidPath, "path must start with /");
  return path.slice(1).split("/").map((raw) => parseSegment(unesc(raw)));
}

const HASH12 = /^[0-9a-f]{12}$/;

export function parseSegment(s) {
  if (s[0] === "@") {
    if (s.startsWith("@k=")) {
      const hash = s.slice(3);
      if (!HASH12.test(hash)) throw new OpsError(REASONS.invalidPath, "@k needs 12 lowercase hex digits");
      return { t: "k", hash };
    }
    if (s.startsWith("@ref=")) {
      const m = /^@ref=(.+?)(?:#(\d+))?(?::([0-9a-f]{12}))?$/.exec(s);
      if (!m) throw new OpsError(REASONS.invalidPath, "malformed @ref segment");
      return { t: "ref", ref: m[1], n: m[2] === undefined ? undefined : Number(m[2]), hash: m[3] };
    }
    if (s.startsWith("@=")) return { t: "item", value: s.slice(2) };
    throw new OpsError(REASONS.invalidPath, "unknown key segment");
  }
  if (/^(0|[1-9]\d*)$/.test(s)) return { t: "index", i: Number(s), name: s };
  if (s === "__proto__" || s === "constructor" || s === "prototype") throw new OpsError(REASONS.invalidPath, "reserved name");
  return { t: "prop", name: s };
}

const isPlain = (v) => v !== null && typeof v === "object" && !Array.isArray(v);

// The key segment text for arr[idx] (the element's *current* content). listName is the field that holds the array.
export function keyFor(listName, arr, idx) {
  const el = arr[idx];
  if (typeof el === "string") return `@=${el}`;
  if (isPlain(el)) {
    if (REF_LISTS.has(listName) && typeof el.ref === "string") {
      if (SINGLE_REF_LISTS.has(listName)) return `@ref=${el.ref}`;
      const same = [];
      arr.forEach((o, i) => { if (isPlain(o) && o.ref === el.ref) same.push(i); });
      if (listName === "media_list" || same.length > 1) return `@ref=${el.ref}#${same.indexOf(idx)}:${hash12(el)}`;
      return `@ref=${el.ref}`;
    }
    return `@k=${hash12(el)}`;
  }
  return String(idx); // numbers and booleans have no identity: fixed-shape tuples such as dateval stay positional
}
// The same, escaped for use inside a pointer.
export const keySegment = (listName, arr, idx) => esc(keyFor(listName, arr, idx));

// ---------------------------------------------------------------------------------------------------------------
// Engine state: a registry that remembers each list element's identity at the start of the call
// ---------------------------------------------------------------------------------------------------------------

function register(node, reg) {
  if (Array.isArray(node)) {
    const counts = new Map();
    for (const el of node) {
      if (isPlain(el)) {
        let n = 0;
        if (typeof el.ref === "string") {
          n = counts.get(el.ref) || 0;
          counts.set(el.ref, n + 1);
        }
        reg.set(el, { canon: canonicalJson(el), n, ref: el.ref });
      }
      register(el, reg);
    }
  } else if (isPlain(node)) {
    for (const k of Object.keys(node)) register(node[k], reg);
  }
}

const metaHash12 = (meta) => (meta.h12 ??= sha256Hex(meta.canon).slice(0, 12));
const elHash12 = (st, el) => {
  const meta = isPlain(el) ? st.reg.get(el) : null;
  return meta ? metaHash12(meta) : hash12(el);
};

// Forget the start-of-call identities and take the present state as the base (for a `seq` op).
function refresh(st) {
  st.reg = new WeakMap();
  for (const [k, v] of st.objs) {
    register(v, st.reg);
    st.origin.set(k, hashObject(v));
  }
}

function makeState(objects, ctx) {
  const st = {
    objs: new Map(),
    reg: new WeakMap(),
    origin: new Map(), // object key -> store hash at the start of the call
    versions: ctx.versions || null,
    inverse: [],
    minted: {},
    mint: ctx.mint || (() => mintHandle()),
  };
  for (const [k, v] of Object.entries(objects || {})) {
    const c = deepClone(v);
    st.objs.set(k, c);
    st.origin.set(k, hashObject(c));
    register(c, st.reg);
  }
  return st;
}

// ---------------------------------------------------------------------------------------------------------------
// Locating a path in an object
// ---------------------------------------------------------------------------------------------------------------

function fail(reason, extra = {}) {
  return { ok: false, reason, ...extra };
}

// Find the element a key segment names. Returns { ok:true, idx } or a failure with a reason.
function matchKey(st, arr, seg) {
  if (seg.t === "item") {
    const hits = [];
    arr.forEach((el, i) => { if (el === seg.value) hits.push(i); });
    if (hits.length === 1) return { ok: true, idx: hits[0] };
    return fail(hits.length ? REASONS.ambiguousKey : REASONS.keyNotFound);
  }
  if (seg.t === "k") {
    const hits = [];
    arr.forEach((el, i) => { if (el !== null && typeof el === "object" && elHash12(st, el) === seg.hash) hits.push(i); });
    if (hits.length === 1) return { ok: true, idx: hits[0] };
    return fail(hits.length ? REASONS.ambiguousKey : REASONS.staleKey);
  }
  // ref
  // an element is named by the ref it had at the start of the call, so editing its `ref` in the same batch is safe
  const refOf = (el) => (st.reg.get(el) ? st.reg.get(el).ref : el.ref);
  const occ = [];
  arr.forEach((el, i) => { if (isPlain(el) && refOf(el) === seg.ref) occ.push(i); });
  if (!occ.length) return fail(REASONS.keyNotFound);
  const occN = (i) => st.reg.get(arr[i])?.n ?? occ.indexOf(i);
  let cand = seg.n === undefined ? occ : occ.filter((i) => occN(i) === seg.n);
  if (seg.hash) {
    const hashed = cand.filter((i) => elHash12(st, arr[i]) === seg.hash);
    if (hashed.length) cand = hashed;
    else {
      // The nth occurrence is not that content any more. If exactly one element with this ref still has the content,
      // equal refs were reordered and it is the same element; otherwise the key is stale.
      const alt = occ.filter((i) => elHash12(st, arr[i]) === seg.hash);
      if (alt.length !== 1) return fail(REASONS.staleKey);
      cand = alt;
    }
  }
  if (cand.length === 1) return { ok: true, idx: cand[0] };
  return fail(cand.length ? REASONS.ambiguousKey : REASONS.keyNotFound);
}

// Walk segs from root. The result's chain lists each step so a path can be rebuilt after the object changes.
function locate(st, root, segs) {
  const chain = [];
  let node = root;
  let listName;
  for (let i = 0; i < segs.length; i++) {
    const seg = segs[i];
    const last = i === segs.length - 1;
    let key;
    let child;
    if (Array.isArray(node)) {
      if (seg.t === "prop") return fail(REASONS.noSuchPath, { at: i, last });
      if (seg.t === "index") {
        if (seg.i >= node.length) return fail(REASONS.noSuchPath, { at: i, last });
        key = seg.i;
      } else {
        if (seg.t === "ref" && listName === "media_list" && !seg.hash) return fail(REASONS.invalidPath, { at: i, last, seg });
        const m = matchKey(st, node, seg);
        if (!m.ok) return { ...m, at: i, last, seg };
        key = m.idx;
      }
      child = node[key];
      chain.push({ container: node, key, seg, listName, child });
    } else if (isPlain(node)) {
      const name = seg.t === "index" ? seg.name : seg.t === "prop" ? seg.name : null;
      if (name === null) return fail(REASONS.invalidPath, { at: i, last });
      if (!Object.prototype.hasOwnProperty.call(node, name)) return fail(REASONS.noSuchPath, { at: i, last, absent: { node, name, chain: chain.slice() } });
      key = name;
      child = node[name];
      chain.push({ container: node, key, seg: { t: "prop", name }, listName: undefined, child });
    } else {
      return fail(REASONS.noSuchPath, { at: i, last });
    }
    listName = Array.isArray(child) && isPlain(node) ? key : undefined;
    node = child;
  }
  const lastLink = chain[chain.length - 1];
  return { ok: true, chain, value: node, parent: lastLink ? lastLink.container : null, key: lastLink ? lastLink.key : null };
}

// The path of chain[0..upto) in the object's present state: keyed segments are recomputed from current content.
function rebuildPath(chain, upto = chain.length) {
  let out = "";
  for (let i = 0; i < upto; i++) {
    const l = chain[i];
    if (Array.isArray(l.container)) {
      const idx = l.seg.t === "index" ? l.key : l.container.indexOf(l.child);
      out += "/" + (l.seg.t === "index" || idx < 0 ? String(l.key) : keySegment(l.listName, l.container, idx));
    } else {
      out += "/" + esc(l.key);
    }
  }
  return out;
}

// ---------------------------------------------------------------------------------------------------------------
// Op handlers. Each returns { status: "clean" | "noop" | "conflict", reason?, current? }. A handler mutates only
// when it returns "clean", and then pushes the inverse op.
// ---------------------------------------------------------------------------------------------------------------

const clean = () => ({ status: "clean" });
const noop = () => ({ status: "noop" });
const conflict = (reason, extra = {}) => ({ status: "conflict", reason, ...extra });
const hasKey = (o, k) => Object.prototype.hasOwnProperty.call(o, k);
// Properties an op may never add or drop: they are the object's identity.
const RESERVED_FIELDS = new Set(["handle", "_class"]);

export function isDateValue(v) {
  return isPlain(v) && Array.isArray(v.dateval);
}

// A Date set from a reduced view (publishView: the viewer saw the year only) keeps the stored day, month and text
// unless the op lists them in `sets` (any of "day", "month", "day2", "month2", "text"). sortval is derived and stays.
export function mergeReducedDate(stored, incoming, sets = []) {
  const out = deepClone(incoming);
  const keep = [["day", 0], ["month", 1], ["day2", 4], ["month2", 5]];
  for (const [name, i] of keep) {
    if (!sets.includes(name) && Array.isArray(stored.dateval) && i < stored.dateval.length && i < out.dateval.length) out.dateval[i] = stored.dateval[i];
  }
  if (!sets.includes("text") && hasKey(stored, "text")) out.text = stored.text;
  if (hasKey(stored, "sortval")) out.sortval = stored.sortval;
  return out;
}

function getObj(st, op) {
  return st.objs.get(op.obj);
}

function adopt(st, newVal, oldVal) {
  register(newVal, st.reg);
  const meta = isPlain(oldVal) && isPlain(newVal) ? st.reg.get(oldVal) : null;
  if (meta) st.reg.set(newVal, meta); // a replaced element keeps the identity its key was computed from
}

// True when the located value is a Date or sits inside one (a sub-path such as /date/dateval/2).
const inDate = (chain) => chain.some((l) => isDateValue(l.child));

function opSet(st, op) {
  const obj = getObj(st, op);
  if (!obj) return conflict(REASONS.missingObject);
  const segs = parsePath(op.path);
  if (!segs.length) throw new OpsError(REASONS.invalidPath, "set needs a path");
  const loc = locate(st, obj, segs);
  if (!loc.ok) {
    // set creates a property the stored object lacks (Gramps JSON omits empty optional fields) when the proposer's
    // base was "absent": `base: null`. The inverse is a remove of the property.
    const ab = loc.absent;
    if (ab && loc.last && op.base_version === undefined && op.base === null && !RESERVED_FIELDS.has(ab.name)) {
      const next = deepClone(op.value);
      ab.node[ab.name] = next;
      register(next, st.reg);
      st.inverse.push({ id: `inv:${op.id}`, op: "remove", obj: op.obj, path: rebuildPath(ab.chain) + "/" + esc(ab.name), base: deepClone(next) });
      return clean();
    }
    return conflict(loc.reason);
  }
  const cur = loc.value;
  let reduced = op.base_version !== undefined;
  // A base_version set is only meaningful on a Date (or inside one): a reduced view is a Date view. On anything else
  // the plain value base is the only staleness check there is.
  if (reduced && !inDate(loc.chain)) {
    if (!hasKey(op, "base")) throw new OpsError(REASONS.missingBase, "base_version applies to a Date; set anything else with base");
    reduced = false;
  }
  if (reduced) {
    // Reduced ops carry no value base, so the object version is the only staleness guard: without it the set cannot be
    // judged and must not apply.
    const v = st.versions ? st.versions[op.obj] : undefined;
    if (v === undefined) return conflict(REASONS.missingVersion, { current: cur });
  }
  let proposed = op.value;
  if (reduced && isDateValue(proposed) && isDateValue(cur)) proposed = mergeReducedDate(cur, proposed, op.sets || []);
  if (deepEqual(cur, proposed)) return noop(); // already applied
  if (reduced) {
    if (st.versions[op.obj] !== op.base_version) return conflict(REASONS.versionChanged, { current: cur });
  } else if (!deepEqual(cur, op.base)) {
    return conflict(REASONS.baseMismatch, { current: cur });
  }
  const next = deepClone(proposed);
  loc.parent[loc.key] = next;
  adopt(st, next, cur);
  st.inverse.push({ id: `inv:${op.id}`, op: "set", obj: op.obj, path: rebuildPath(loc.chain), base: deepClone(next), value: deepClone(cur) });
  return clean();
}

function resolveList(st, op) {
  const obj = getObj(st, op);
  if (!obj) return conflict(REASONS.missingObject);
  const loc = locate(st, obj, parsePath(op.path));
  if (!loc.ok) return conflict(loc.reason);
  if (!Array.isArray(loc.value)) return conflict(REASONS.notAList);
  return { loc };
}

function anchorIndex(st, arr, before, listName) {
  if (before === undefined || before === null) return { ok: true, idx: arr.length };
  const text = String(before);
  const seg = parseSegment(unesc(text[0] === "/" ? text.slice(1) : text));
  if (seg.t === "index") return { ok: true, idx: Math.min(seg.i, arr.length) };
  if (seg.t === "prop") throw new OpsError(REASONS.invalidPath, "before must be a key segment");
  if (seg.t === "ref" && listName === "media_list" && !seg.hash) throw new OpsError(REASONS.invalidPath, "a media_list key needs :<hash12>");
  return matchKey(st, arr, seg);
}

function opAdd(st, op) {
  const r = resolveList(st, op);
  if (!r.loc) return r;
  const { loc } = r;
  const arr = loc.value;
  const tail = loc.chain[loc.chain.length - 1];
  const listName = tail && isPlain(tail.container) ? tail.key : undefined;
  const v = op.value;
  if (arr.some((el) => deepEqual(el, v))) return noop(); // an identical element is present
  if (isPlain(v) && typeof v.ref === "string" && SINGLE_REF_LISTS.has(listName) && arr.some((el) => isPlain(el) && el.ref === v.ref)) {
    return conflict(REASONS.keyExists);
  }
  const a = anchorIndex(st, arr, op.before, listName);
  if (!a.ok) return conflict(a.reason); // the element the proposer meant to sit before is gone: the position is lost
  const at = a.idx;
  const el = deepClone(v);
  register(el, st.reg);
  if (isPlain(el)) st.reg.set(el, { canon: canonicalJson(el), n: typeof el.ref === "string" ? arr.filter((o) => isPlain(o) && o.ref === el.ref).length : 0, ref: el.ref });
  arr.splice(at, 0, el);
  const listPath = rebuildPath(loc.chain);
  st.inverse.push({ id: `inv:${op.id}`, op: "remove", obj: op.obj, path: `${listPath}/${keySegment(listName, arr, at)}`, base: deepClone(el) });
  return clean();
}

function expectedElementHash(op) {
  if (op.base_hash !== undefined) return op.base_hash;
  if (op.base !== undefined) return contentHash(op.base);
  throw new OpsError(REASONS.missingBase, "remove needs base or base_hash");
}

// remove drops a list element, or (inverse of a set that created it) an object property.
function opRemove(st, op) {
  const obj = getObj(st, op);
  if (!obj) return conflict(REASONS.missingObject);
  const segs = parsePath(op.path);
  const lastSeg = segs[segs.length - 1];
  if (!lastSeg || !["ref", "item", "k", "index", "prop"].includes(lastSeg.t)) throw new OpsError(REASONS.invalidPath, "remove must end in a list element or a property");
  if (lastSeg.t === "prop" && RESERVED_FIELDS.has(lastSeg.name)) throw new OpsError(REASONS.invalidPath, "reserved property");
  const want = expectedElementHash(op);
  const loc = locate(st, obj, segs);
  if (!loc.ok) {
    // Absent is a no-op only when the key says "not there" (key_not_found, or a property that is not there). A stale
    // @k or @ref hash means the element exists with other content: that is a conflict, never an absence.
    if (loc.last && (loc.reason === REASONS.keyNotFound || (loc.reason === REASONS.noSuchPath && loc.absent))) return noop();
    return conflict(loc.reason);
  }
  const el = loc.value;
  const meta = isPlain(el) ? st.reg.get(el) : null;
  const same = contentHash(el) === want || (meta && sha256Hex(meta.canon) === want);
  if (!same) return conflict(REASONS.contentChanged, { current: el });
  const container = loc.parent;
  if (!Array.isArray(container)) {
    delete container[loc.key];
    st.inverse.push({ id: `inv:${op.id}`, op: "set", obj: op.obj, path: rebuildPath(loc.chain), base: null, value: deepClone(el) });
    return clean();
  }
  const arr = container;
  const idx = loc.key;
  const listName = loc.chain[loc.chain.length - 1].listName;
  arr.splice(idx, 1);
  const inv = { id: `inv:${op.id}`, op: "add", obj: op.obj, path: rebuildPath(loc.chain, loc.chain.length - 1), value: deepClone(el) };
  if (idx < arr.length) inv.before = keySegment(listName, arr, idx);
  st.inverse.push(inv);
  return clean();
}

function opMove(st, op) {
  const obj = getObj(st, op);
  if (!obj) return conflict(REASONS.missingObject);
  const segs = parsePath(op.path);
  const lastSeg = segs[segs.length - 1];
  if (!lastSeg || !["ref", "item", "k", "index"].includes(lastSeg.t)) throw new OpsError(REASONS.invalidPath, "move must end in a list element");
  const loc = locate(st, obj, segs);
  if (!loc.ok) return conflict(loc.reason);
  const arr = loc.parent;
  const from = loc.key;
  const link = loc.chain[loc.chain.length - 1];
  const el = arr[from];
  const nextEl = arr[from + 1];
  let anchor = null;
  if (op.before !== undefined && op.before !== null) {
    const a = anchorIndex(st, arr, op.before, link.listName);
    if (!a.ok) return conflict(a.reason);
    anchor = arr[a.idx];
  }
  if (anchor === el) return noop(); // before itself: the list stays as it is
  arr.splice(from, 1);
  const to = anchor === null ? arr.length : arr.indexOf(anchor);
  arr.splice(to, 0, el);
  const inv = { id: `inv:${op.id}`, op: "move", obj: op.obj, path: rebuildPath(loc.chain.slice(0, -1)) + "/" + keySegment(link.listName, arr, to) };
  if (nextEl !== undefined) inv.before = keySegment(link.listName, arr, arr.indexOf(nextEl));
  st.inverse.push(inv);
  return clean();
}

function splitKey(key) {
  const i = key.indexOf(":");
  if (i < 1) throw new OpsError(REASONS.invalidOp, "obj must look like Class:handle");
  return [key.slice(0, i), key.slice(i + 1)];
}

function opCreate(st, op) {
  const [cls, handle] = splitKey(op.obj);
  const value = deepClone(op.value);
  if (!isPlain(value)) throw new OpsError(REASONS.invalidOp, "create needs an object value");
  value.handle = handle;
  value._class = cls;
  if (st.objs.has(op.obj)) return deepEqual(st.objs.get(op.obj), value) ? noop() : conflict(REASONS.objectExists, { current: st.objs.get(op.obj) });
  st.objs.set(op.obj, value);
  register(value, st.reg);
  st.inverse.push({ id: `inv:${op.id}`, op: "delete", obj: op.obj, base: hashObject(value) });
  return clean();
}

function opDelete(st, op) {
  const cur = st.objs.get(op.obj);
  if (!cur) return conflict(REASONS.missingObject);
  const want = op.base_hash !== undefined ? op.base_hash : op.base;
  if (typeof want !== "string") throw new OpsError(REASONS.missingBase, "delete needs the object's content hash in base");
  if (hashObject(cur) !== want && st.origin.get(op.obj) !== want) return conflict(REASONS.hashMismatch, { current: cur });
  st.objs.delete(op.obj);
  const [cls] = splitKey(op.obj);
  st.inverse.push({ id: `inv:${op.id}`, op: "create", obj: op.obj, cls, value: deepClone(cur) });
  return clean();
}

const HANDLERS = { set: opSet, add: opAdd, remove: opRemove, move: opMove, create: opCreate, delete: opDelete };

// ---------------------------------------------------------------------------------------------------------------
// Validation, temp handles, the run loop
// ---------------------------------------------------------------------------------------------------------------

// An own "__proto__" key in a value (JSON.parse creates one) would make the stored object disagree with its hash.
function hasProtoKey(v) {
  if (Array.isArray(v)) return v.some(hasProtoKey);
  if (v && typeof v === "object") return Object.keys(v).some((k) => k === "__proto__" || hasProtoKey(v[k]));
  return false;
}

export function validateOps(ops) {
  const problems = [];
  if (!Array.isArray(ops)) return [{ id: null, reason: REASONS.invalidOp, message: "ops must be an array" }];
  ops.forEach((op, i) => {
    const id = op && op.id !== undefined ? op.id : `#${i}`;
    const bad = (reason, message) => problems.push({ id, reason, message });
    if (!isPlain(op)) return bad(REASONS.invalidOp, "op must be an object");
    if (!OP_KINDS.includes(op.op)) return bad(REASONS.invalidOp, `unknown op ${String(op.op)}`);
    if (typeof op.obj !== "string" || !op.obj) return bad(REASONS.invalidOp, "obj is required");
    if ((hasKey(op, "value") && hasProtoKey(op.value)) || (hasKey(op, "base") && hasProtoKey(op.base))) return bad(REASONS.invalidOp, "a value may not carry a __proto__ key");
    if (op.op === "create") {
      if (!hasKey(op, "value")) return bad(REASONS.invalidOp, "create needs a value");
      if (/^new:\d+$/.test(op.obj) && typeof op.cls !== "string") return bad(REASONS.invalidOp, "create of a new object needs cls");
      return;
    }
    if (op.op === "delete") {
      if (typeof (op.base_hash !== undefined ? op.base_hash : op.base) !== "string") bad(REASONS.missingBase, "delete needs the object's content hash in base");
      return;
    }
    if (typeof op.path !== "string") return bad(REASONS.invalidPath, "path is required");
    try {
      const segs = parsePath(op.path);
      if (op.op !== "set" && !segs.length) return bad(REASONS.invalidPath, `${op.op} needs a path`);
      // a MediaRef key is ref#n plus a content hash; without the hash a stale key could select another tag
      segs.forEach((sg, j) => {
        if (sg.t === "ref" && !sg.hash && j > 0 && segs[j - 1].t === "prop" && segs[j - 1].name === "media_list") throw new OpsError(REASONS.invalidPath, "a media_list key needs :<hash12>");
      });
      if (op.before !== undefined && op.before !== null) {
        const bs = parseSegment(unesc(String(op.before)[0] === "/" ? String(op.before).slice(1) : String(op.before)));
        const listSeg = op.op === "add" ? segs[segs.length - 1] : segs[segs.length - 2];
        if (bs.t === "ref" && !bs.hash && listSeg && listSeg.t === "prop" && listSeg.name === "media_list") throw new OpsError(REASONS.invalidPath, "a media_list key needs :<hash12>");
      }
    } catch (e) {
      return bad(e.code || REASONS.invalidPath, e.message);
    }
    if (op.op === "set") {
      if (!hasKey(op, "value")) return bad(REASONS.invalidOp, "set needs a value");
      if (!hasKey(op, "base") && op.base_version === undefined) bad(REASONS.missingBase, "set needs base, or base_version for a reduced view");
    } else if (op.op === "add") {
      if (!hasKey(op, "value")) bad(REASONS.invalidOp, "add needs a value");
    } else if (op.op === "remove") {
      if (!hasKey(op, "base") && op.base_hash === undefined) bad(REASONS.missingBase, "remove needs base or base_hash");
    }
  });
  return problems;
}

const TEMP = /\bnew:(\d+)\b/g;

// The fields whose string values are Gramps handles, and so may name a not-yet-minted object.
const isRefField = (name) => typeof name === "string" && (name === "ref" || name === "place" || name.endsWith("_handle") || STRING_LISTS.has(name));
// The property an op's value lands in: the last property name on its path (a key segment names an element of the
// list before it, so the list's name is what counts).
function fieldOfPath(path) {
  if (typeof path !== "string") return undefined;
  let segs;
  try { segs = parsePath(path.replace(TEMP, "x")); } catch { return undefined; }
  for (let i = segs.length - 1; i >= 0; i--) if (segs[i].t === "prop") return segs[i].name;
  return undefined;
}

// Mint a handle for every `create` of a new:n object and rewrite references to it. Returns { ops, minted, keys }.
function substituteTemps(ops, st, objectsHave) {
  const keys = {}; // "new:1" -> "Person:<handle>"
  const handles = {}; // "new:1" -> "<handle>"
  for (const op of ops) {
    if (op.op === "create" && /^new:\d+$/.test(op.obj) && !handles[op.obj]) {
      let h;
      do h = st.mint(); while (objectsHave(h));
      handles[op.obj] = h;
      keys[op.obj] = `${op.cls}:${h}`;
    }
  }
  if (!Object.keys(handles).length) return { ops, handles };
  const text = (s) => s.replace(TEMP, (m) => handles[m] ?? m);
  // Only fields that hold a handle are rewritten: free text such as a note's `text` that reads "new:1" stays as typed.
  // `field` is the name of the property (or list) the string sits in.
  const val = (v, field) => {
    if (typeof v === "string") return isRefField(field) ? handles[v] ?? v : v;
    if (Array.isArray(v)) return v.map((x) => val(x, field));
    if (isPlain(v)) return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, val(x, k)]));
    return v;
  };
  const out = ops.map((op) => {
    const o = { ...op };
    o.obj = keys[op.obj] ?? op.obj;
    if (typeof o.path === "string") o.path = text(o.path);
    if (typeof o.before === "string") o.before = text(o.before);
    const field = fieldOfPath(op.path);
    if (hasKey(o, "value")) o.value = val(o.value, field);
    if (hasKey(o, "base")) o.base = val(o.base, field);
    return o;
  });
  return { ops: out, handles };
}

function toPlain(map) {
  return Object.fromEntries(map);
}

// Core loop shared by apply, invert and rebase. Ops run in order against the progressively edited copy; an op that
// conflicts or is a no-op changes nothing. The input objects are never mutated.
function run(objects, ops, ctx) {
  const problems = validateOps(ops);
  const st = makeState(objects, ctx);
  if (problems.length) {
    const conflicts = problems.map((p) => ({ opId: p.id, obj: null, op: null, path: null, reason: p.reason, message: p.message, base: null, current: null, proposed: null }));
    return { st, ok: false, invalid: true, results: problems.map((p) => ({ id: p.id, status: "conflict", reason: p.reason })), conflicts, minted: {} };
  }
  const prepared = substituteTemps(ops, st, (h) => [...st.objs.keys()].some((k) => k.endsWith(`:${h}`)));
  const results = [];
  const conflicts = [];
  prepared.ops.forEach((op, i) => {
    const orig = ops[i];
    const id = orig.id !== undefined ? orig.id : `#${i}`;
    let r;
    try {
      if (op.seq) refresh(st);
      r = HANDLERS[op.op](st, op);
    } catch (e) {
      if (!(e instanceof OpsError)) throw e;
      r = conflict(e.code);
      r.message = e.message;
    }
    results.push({ id, obj: op.obj, status: r.status, ...(r.reason ? { reason: r.reason } : {}) });
    if (r.status === "conflict") {
      conflicts.push({
        opId: id,
        obj: op.obj,
        op: op.op,
        path: op.path ?? null,
        reason: r.reason,
        ...(r.message ? { message: r.message } : {}),
        base: hasKey(op, "base") ? op.base : op.base_version !== undefined ? { base_version: op.base_version } : null,
        current: r.current === undefined ? null : r.current,
        proposed: hasKey(op, "value") ? op.value : null,
      });
    }
  });
  return { st, ok: conflicts.length === 0, invalid: false, results, conflicts, minted: prepared.handles };
}

// Apply ops to objects. All or nothing: any conflict leaves `objects` as given (a copy) and lists every conflict.
//   ctx: { versions?: {"Person:h": n}, mint?: () => handle }
// -> { ok, objects, minted: {"new:1": handle}, results: [{id, obj, status}], conflicts: [...], inverse: EditOp[] }
export function applyOps(objects, ops, ctx = {}) {
  const r = run(objects, ops, ctx);
  if (!r.ok) {
    return { ok: false, objects: Object.fromEntries(Object.entries(objects || {}).map(([k, v]) => [k, deepClone(v)])), minted: {}, results: r.results, conflicts: r.conflicts, inverse: [] };
  }
  return { ok: true, objects: toPlain(r.st.objs), minted: r.minted, results: r.results, conflicts: [], inverse: r.st.inverse.slice().reverse().map((o) => ({ ...o, seq: true })) };
}

// The ops that undo `ops` when applied to the result. Throws OpsError when the ops do not apply to `objects`.
export function invertOps(objects, ops, ctx = {}) {
  const r = applyOps(objects, ops, ctx);
  if (!r.ok) throw new OpsError(r.conflicts[0].reason, `ops do not apply: ${r.conflicts.map((c) => `${c.opId}:${c.reason}`).join(", ")}`);
  return r.inverse;
}

// Three-way rebase (editing design section 7.5): `ops` carry the base each was made against, `current` is the store now.
//   ctx: { versions?, baseVersions? }
// -> { status: "current" | "clean" | "conflict", results, conflicts, objects, minted }
// status "current" means every target object is still at its base version; "clean" means every op is clean or a
// no-op; "conflict" lists a row per conflicting op: { opId, obj, path, reason, base, current, proposed }.
export function rebaseOps(ops, current, ctx = {}) {
  const r = run(current, ops, ctx);
  let status = "clean";
  if (!r.ok) status = "conflict";
  else if (ctx.versions && ctx.baseVersions) {
    const keys = Object.keys(ctx.baseVersions);
    if (keys.length && keys.every((k) => ctx.versions[k] === ctx.baseVersions[k])) status = "current";
  }
  return { status, results: r.results, conflicts: r.conflicts, objects: r.ok ? toPlain(r.st.objs) : null, minted: r.minted };
}
