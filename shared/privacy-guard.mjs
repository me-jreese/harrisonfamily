// The one R-18 detector (HFY-PLN-002 D2-09, BRD2 section 5.2; task privacy-guard-core). Every write path, the chat Worker,
// the renderer and the graph verify() use this module; gramps/hfygramps/scanner.py is its Python port, and both pass the same
// cases in shared/privacy-guard.vectors.json. Pure ESM with no imports and no host APIs, so it runs unchanged in hfy-api, the
// auth edge, the islands bundle (es2020 / safari15: no lookbehind) and a Cloudflare Worker.
//
// A finding is {kind, start, end, rule}: offsets into the caller's own string (UTF-16 units here, code points in Python), never
// the matched text. Nothing here logs. Callers report kinds and spans only; the matched text never reaches a body or a log.
//
// Parity rules for the Python port: ASCII-only regex semantics (re.ASCII; JS without the u flag), no \s, no lookbehind, no
// end anchors, the same normalization tables, and every window (the dob window, the phone-word and reference windows)
// counted in code points: the detectors scan a normalized text with one unit per code point (normalize()) and findings are
// mapped back to the caller's offsets.

export const KINDS = Object.freeze(["phone", "email", "street_address", "po_box", "contact_url", "dob_heuristic"]);
export const DOB_KINDS = Object.freeze(["dob_heuristic"]);

/** Characters between a birth keyword and a date (BRD2 5.2). */
export const DOB_WINDOW = 60;

/** The member-facing copy for each refusal code (DS voice, BRD2 5.2). */
export const COPY = Object.freeze({
  contact_info: "this looks like a phone number or street address. we don't keep those on the site, so please remove it to continue.",
  dob_not_allowed: "we only keep the birth year on the site.",
});

/**
 * Birth keywords, lower case. The dob heuristic reads a nearby day or month as a birth date when one of these is the nearest
 * event word; on-this-day reuses the set to skip birthday posts. Multi-word entries match any run of spaces or tabs.
 */
export const BIRTHDAY_KEYWORDS = new Set([
  "birthday", "birthdays", "bday", "bdays", "b-day", "b-days", "b'day", "b'days", "hbd",
  "birthdate", "birthdates", "birth date", "date of birth", "dob", "d.o.b",
  "born", "birth", "births", "baptized", "baptised", "baptism", "christened", "christening",
]);

// Other event words: a date nearer to one of these than to a birth keyword belongs to that event (born 1920, died 5 May 1990).
const EVENT_WORDS = [
  "died", "dies", "death", "deaths", "deceased", "passed away", "buried", "burial", "interred",
  "married", "marriage", "marries", "marry", "wedding", "divorced", "divorce", "anniversary",
  "graduated", "graduation", "emigrated", "immigrated", "naturalized", "naturalised", "enlisted", "discharged", "retired",
  "census", "enumerated", "enumeration",
];
// Genealogy abbreviations, lower case only and case-sensitive ("Ph.D." and initials are not events).
const BIRTH_ABBREVIATIONS = ["b.", "bap.", "bapt.", "chr."];
const EVENT_ABBREVIATIONS = ["d.", "m.", "bur.", "div."];

/** Contact-channel hosts, matched by registrable-domain suffix (host === d or host ends with "." + d), never by substring. */
export const CONTACT_HOSTS = Object.freeze([
  "m.me", "ig.me", "wa.me", "wa.link", "t.me", "telegram.me", "telegram.dog", "messenger.com",
  "api.whatsapp.com", "chat.whatsapp.com", "signal.me", "signal.group",
]);
/** [domain, first path segment]: message paths on profile hosts (instagram.com/m/…, instagram.com/direct/…, facebook.com/messages/…). */
export const CONTACT_PATHS = Object.freeze([["instagram.com", "m"], ["instagram.com", "direct"], ["facebook.com", "messages"]]);
export const CONTACT_SCHEMES = Object.freeze([
  "mailto", "tel", "sms", "smsto", "mms", "callto", "facetime", "facetime-audio", "skype", "whatsapp", "viber", "sgnl", "tg",
  "fb-messenger", "imessage",
]);

/**
 * [lo, hi, out, step]: code points lo..hi fold to out (+ (cp - lo) when step is 1). Unicode spaces, dashes, curly apostrophes,
 * the small and fullwidth at signs and fullwidth ASCII fold to ASCII, one character to one character.
 */
export const FOLD = Object.freeze([
  [0x00a0, 0x00a0, 0x20, 0], [0x00b7, 0x00b7, 0x2e, 0], [0x02bc, 0x02bc, 0x27, 0], [0x1680, 0x1680, 0x20, 0],
  [0x2000, 0x200a, 0x20, 0], [0x2010, 0x2015, 0x2d, 0], [0x2018, 0x2019, 0x27, 0], [0x2024, 0x2024, 0x2e, 0],
  [0x2028, 0x2029, 0x20, 0], [0x202f, 0x202f, 0x20, 0], [0x205f, 0x205f, 0x20, 0], [0x2212, 0x2212, 0x2d, 0],
  [0x3000, 0x3000, 0x20, 0], [0xfe58, 0xfe58, 0x2d, 0], [0xfe63, 0xfe63, 0x2d, 0], [0xfe6b, 0xfe6b, 0x40, 0],
  [0xff01, 0xff5e, 0x21, 1],
].map((r) => Object.freeze(r)));

/**
 * [lo, hi, value]: code point cp in lo..hi becomes the ASCII digits of value + (cp - lo). Every Unicode decimal digit (Nd:
 * Arabic-Indic, Devanagari, math bold and the rest) and every character whose NFKC form is ASCII digits (superscripts,
 * subscripts, circled numbers: ⑫ becomes "12"). A fixed table, not the runtime's Unicode data, so both ports agree.
 */
export const DIGITS = Object.freeze([
  [0x00b2, 0x00b3, 2], [0x00b9, 0x00b9, 1], [0x0660, 0x0669, 0], [0x06f0, 0x06f9, 0], [0x07c0, 0x07c9, 0], [0x0966, 0x096f, 0],
  [0x09e6, 0x09ef, 0], [0x0a66, 0x0a6f, 0], [0x0ae6, 0x0aef, 0], [0x0b66, 0x0b6f, 0], [0x0be6, 0x0bef, 0], [0x0c66, 0x0c6f, 0],
  [0x0ce6, 0x0cef, 0], [0x0d66, 0x0d6f, 0], [0x0de6, 0x0def, 0], [0x0e50, 0x0e59, 0], [0x0ed0, 0x0ed9, 0], [0x0f20, 0x0f29, 0],
  [0x1040, 0x1049, 0], [0x1090, 0x1099, 0], [0x17e0, 0x17e9, 0], [0x1810, 0x1819, 0], [0x1946, 0x194f, 0], [0x19d0, 0x19d9, 0],
  [0x1a80, 0x1a89, 0], [0x1a90, 0x1a99, 0], [0x1b50, 0x1b59, 0], [0x1bb0, 0x1bb9, 0], [0x1c40, 0x1c49, 0], [0x1c50, 0x1c59, 0],
  [0x2070, 0x2070, 0], [0x2074, 0x2079, 4], [0x2080, 0x2089, 0], [0x2460, 0x2473, 1], [0x24ea, 0x24ea, 0],
  [0x3251, 0x325f, 21], [0x32b1, 0x32bf, 36], [0xa620, 0xa629, 0], [0xa8d0, 0xa8d9, 0], [0xa900, 0xa909, 0],
  [0xa9d0, 0xa9d9, 0], [0xa9f0, 0xa9f9, 0], [0xaa50, 0xaa59, 0], [0xabf0, 0xabf9, 0], [0x104a0, 0x104a9, 0],
  [0x10d30, 0x10d39, 0], [0x11066, 0x1106f, 0], [0x110f0, 0x110f9, 0], [0x11136, 0x1113f, 0], [0x111d0, 0x111d9, 0],
  [0x112f0, 0x112f9, 0], [0x11450, 0x11459, 0], [0x114d0, 0x114d9, 0], [0x11650, 0x11659, 0], [0x116c0, 0x116c9, 0],
  [0x11730, 0x11739, 0], [0x118e0, 0x118e9, 0], [0x11950, 0x11959, 0], [0x11c50, 0x11c59, 0], [0x11d50, 0x11d59, 0],
  [0x11da0, 0x11da9, 0], [0x11f50, 0x11f59, 0], [0x16a60, 0x16a69, 0], [0x16ac0, 0x16ac9, 0], [0x16b50, 0x16b59, 0],
  [0x1d7ce, 0x1d7d7, 0], [0x1d7d8, 0x1d7e1, 0], [0x1d7e2, 0x1d7eb, 0], [0x1d7ec, 0x1d7f5, 0], [0x1d7f6, 0x1d7ff, 0],
  [0x1e140, 0x1e149, 0], [0x1e2f0, 0x1e2f9, 0], [0x1e4f0, 0x1e4f9, 0], [0x1e950, 0x1e959, 0], [0x1fbf0, 0x1fbf9, 0],
].map((r) => Object.freeze(r)));

/**
 * [lo, hi]: removed before scanning. The Unicode default-ignorable characters: soft hyphen, zero-width space, non-joiner and
 * joiner, word joiner, byte-order mark, bidi and other format controls, fillers, variation selectors and tags, which render as
 * nothing and would otherwise split a number or an address (jane\u200b@example.org).
 */
export const DROP = Object.freeze([
  [0x00ad, 0x00ad], [0x034f, 0x034f], [0x061c, 0x061c], [0x115f, 0x1160], [0x17b4, 0x17b5], [0x180b, 0x180f],
  [0x200b, 0x200f], [0x202a, 0x202e], [0x2060, 0x206f], [0x3164, 0x3164], [0xfe00, 0xfe0f], [0xfeff, 0xfeff],
  [0xffa0, 0xffa0], [0xfff0, 0xfff8], [0x1bca0, 0x1bca3], [0x1d173, 0x1d17a], [0xe0000, 0xe0fff],
].map((r) => Object.freeze(r)));

const NORM = new Map(); // code point -> its replacement ("" removes it)
for (const [lo, hi, out, step] of FOLD) {
  for (let cp = lo; cp <= hi; cp++) NORM.set(cp, String.fromCharCode(out + (cp - lo) * step));
}
for (const [lo, hi, value] of DIGITS) for (let cp = lo; cp <= hi; cp++) NORM.set(cp, String(value + cp - lo));
for (const [lo, hi] of DROP) for (let cp = lo; cp <= hi; cp++) NORM.set(cp, "");
const hex = (n) => "\\u" + n.toString(16).padStart(4, "0");
// Any character normalize() changes: a table entry, or a surrogate (an astral character becomes one unit).
const NEEDS_NORM = new RegExp("[" + [...FOLD, ...DIGITS, ...DROP].filter(([lo]) => lo <= 0xffff)
  .map(([lo, hi]) => (lo === hi ? hex(lo) : hex(lo) + "-" + hex(hi))).join("") + "\\ud800-\\udfff]");
const ASTRAL = "\ufffd"; // one unit for an astral character the tables leave alone: like it, no letter, digit or space

/**
 * {t, from, to}: the text the detectors scan, with one unit per code point, and for each unit of t the caller offsets of the
 * character it came from (from[i] up to to[i]); from is null when t is the caller's text unchanged.
 */
function normalize(text) {
  if (!NEEDS_NORM.test(text)) return { t: text, from: null, to: null };
  const out = [], from = [], to = [];
  for (let i = 0; i < text.length;) {
    const cp = text.codePointAt(i);
    const next = i + (cp > 0xffff ? 2 : 1);
    const rep = NORM.get(cp);
    const s = rep !== undefined ? rep : cp > 0xffff ? ASTRAL : text[i];
    for (let k = 0; k < s.length; k++) {
      out.push(s[k]);
      from.push(i);
      to.push(next);
    }
    i = next;
  }
  return { t: out.join(""), from, to };
}

const WORD_CHARS = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789_";
const SPACE_CHARS = " \t\r\n\f\v";
const isWordChar = (ch) => ch !== undefined && ch !== "" && WORD_CHARS.includes(ch);
const isDigit = (ch) => ch !== undefined && ch !== "" && "0123456789".includes(ch);
const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\\-']/g, "\\$&");
const byLength = (a, b) => b.length - a.length || (a < b ? -1 : a > b ? 1 : 0);
const alternation = (words) => [...words].sort(byLength).map((w) => escapeRe(w).replace(/ /g, "[ \\t]+")).join("|");

// ---------------------------------------------------------------- phone

// A run of digit groups joined by - / . or one or two spaces, with an optional leading + and parentheses: (555) 010-0123.
const PHONE_RUN = /(?:\+[ \t]?)?(?:\([ \t]?)?[0-9]+(?:[ \t]?\))?(?:(?:[ \t]{0,2}[\-\/][ \t]{0,2}|\.|[ \t]{1,2})?(?:\([ \t]?)?[0-9]+(?:[ \t]?\))?)*/g;
const DIGIT_GROUP = /[0-9]+/g;
const AREA_CODE = /^\([ \t]?[0-9]{1,5}[ \t]?\)/; // (555) 010-0123: the only parentheses that make a run phone-shaped
const YEAR_LIKE = /^(?:1[0-9]{3}|20[0-9]{2})$/;
const HOST_PATH = /[A-Za-z0-9\-]\.[A-Za-z]{2,24}(?::[0-9]{1,5})?[\/?#]/g;
// Words that make a number a phone number whatever its shape (call 1955 0123), anywhere in the 24 characters before it.
const PHONE_WORD = /\b(?:tel|tele|telephone|phone|ph|cell|cellphone|mobile|mob|call|text|txt|fax|whatsapp)\b/i;
// A citation or reference label directly before the number: page 1234567, Find a Grave memorial 12345678, ISBN
// 978-0-12-345678-9. It makes an unseparated run a reference, and a separated one too unless the groups are phone-shaped
// (case 555-010-0123 is still a phone number).
const REFERENCE = new RegExp(
  "\\b(?:" + alternation([
    "p", "pp", "pg", "pgs", "page", "pages", "vol", "vols", "volume", "no", "nos", "nr", "film", "roll", "fiche", "folio", "fol",
    "item", "image", "img", "dgs", "cert", "certificate", "record", "rec", "ref", "reference", "id", "isbn", "issn", "case", "file",
    "lot", "plot", "grave", "row", "sec", "section", "entry", "frame", "register", "reg", "batch", "serial", "census",
    "book", "bk", "chapter", "ch", "memorial", "find a grave", "serial number", "service number", "database", "accession",
  ]) + ")\\.?[ \\t]*(?:[:#][ \\t]*)?$", "i");

const sepCore = (sep) => sep.replace(/[ \t()]/g, "");
const dayMonth = (a, b) => a >= 1 && b >= 1 && ((a <= 12 && b <= 31) || (a <= 31 && b <= 12));
/** Group lengths laid out like a phone number: 555-010-0123, 1-800-555-0199, 0207 946 0123, 01 23 45 67 89. */
const phoneShaped = (lens) => lens.length <= 5 && lens[0] <= 4 && lens.slice(1).every((l) => l >= 2 && l <= 4);
/** groups[from..] are five two-digit groups with one separator throughout, the French layout: 01 23 45 67 89. */
const fiveTwos = (groups, seps, from) => groups.length - from === 5 &&
  groups.slice(from).every((g) => g.d.length === 2) && seps.slice(from).every((s) => s === seps[from]);

/** Three digit groups that read as a date: 12-05-1950, 5.12.50, 1950-05-12 (one separator kind throughout). */
function isDateTriple(groups, seps) {
  const [ca, cb] = seps.map(sepCore);
  if (ca !== cb) return false;
  const [a, b, c] = groups.map((g) => g.d);
  if (a.length === 4 && b.length <= 2 && c.length <= 2) return +b >= 1 && +b <= 12 && +c >= 1 && +c <= 31;
  if (a.length <= 2 && b.length <= 2 && (c.length === 2 || c.length === 4)) return dayMonth(+a, +b);
  return false;
}

/**
 * url[p] is 1 when the space-delimited token of t up to offset p already reads as a URL (it holds "://" or host.tld/ before
 * p). A separator-free digit run there after / = ? & # is a numeric id, not a phone number. One pass, so linear in the text.
 */
function urlPrefixes(t) {
  const url = new Uint8Array(t.length + 1);
  for (let k = t.indexOf("://"); k !== -1; k = t.indexOf("://", k + 1)) url[k + 3] = 1;
  for (const m of t.matchAll(HOST_PATH)) url[m.index + m[0].length] = 1; // the token's first match ends first
  let on = 0;
  for (let p = 1; p <= t.length; p++) {
    if (SPACE_CHARS.includes(t[p - 1])) on = 0;
    else if (url[p]) on = 1;
    url[p] = on;
  }
  return url;
}

function phoneExcluded(groups, seps, before) {
  const lens = groups.map((g) => g.d.length);
  const n = lens.reduce((x, y) => x + y, 0);
  const core = seps.map(sepCore);
  if (groups.every((g) => YEAR_LIKE.test(g.d))) return true; // years, year ranges, lists of years
  if (groups.length === 3 && isDateTriple(groups, seps)) return true; // dates
  if (lens.every((l) => l <= 2) && n < 10) return true; // scores, clock times, small counts
  if (groups.length >= 3 && seps.every((s) => s === seps[0]) && (seps[0] === "." || seps[0] === " ") &&
      lens[0] <= 3 && lens.slice(1).every((l) => l === 3)) return true; // 1.234.567
  if (groups.length === 2) {
    const [a, b] = groups.map((g) => +g.d);
    if (core[0] === "-" && lens[0] === lens[1] && b > a && b - a < 10 ** (lens[0] - 1)) return true; // page range 1234-1256
    if (core[0] === "" && Math.min(lens[0], lens[1]) <= 4 && groups.some((g) => YEAR_LIKE.test(g.d))) return true; // in 1850 555 people
  }
  return REFERENCE.test(before) && !phoneShaped(lens); // ISBN 978-0-12-345678-9, record 1234567-8
}

function phoneVerdict(t, s, run, groups, inUrl) {
  // seps[i] is the text between groups[i] and groups[i + 1]
  const seps = groups.slice(1).map((g, i) => run.slice(groups[i].at + groups[i].d.length, g.at));
  let n = groups.reduce((x, g) => x + g.d.length, 0);
  for (let from = 0; ; from += 3) {
    if (from > 0) n -= groups[from - 3].d.length + groups[from - 2].d.length + groups[from - 1].d.length;
    if (n < 7) return null;
    const off = groups[from].at;
    if (from === 0 && run[0] === "+") return { off: 0, rule: "plus" };
    const before = t.slice(Math.max(0, s + off - 24), s + off);
    if (groups.length - from === 1) {
      if (n > 15 || inUrl(s + off) || REFERENCE.test(before)) return null;
      return { off, rule: "run" };
    }
    if (!AREA_CODE.test(run.slice(from === 0 ? 0 : off, off + 9)) && !PHONE_WORD.test(before)) {
      // a date followed by more digits (5/12/2020 10:30): judge what follows the date on its own, unless the groups are five
      // two-digit groups (01 23 45 67 89 is a phone number, not 01/23/45 and more)
      if (groups.length - from > 3 && isDateTriple(groups.slice(from, from + 3), seps.slice(from, from + 2)) &&
          !fiveTwos(groups, seps, from)) continue;
      if (phoneExcluded(groups.slice(from), seps.slice(from), before)) return null;
    }
    return { off: from === 0 ? 0 : off, rule: "grouped" };
  }
}

/** [a, b]: the run without wrapping parentheses, "(1920-1985)" -> "1920-1985", keeping an area code's: "(555) 010-0123". */
function unwrap(run) {
  let a = 0, b = run.length;
  if (run[0] === "(" && !AREA_CODE.test(run)) {
    a = 1;
    while (a < b && " \t".includes(run[a])) a++;
  }
  const inner = run.slice(a, b);
  if (run[b - 1] === ")" && inner.split(")").length > inner.split("(").length) {
    b--;
    while (b > a && " \t".includes(run[b - 1])) b--;
  }
  return [a, b];
}

function scanPhones(t, add) {
  let url = null; // urlPrefixes(t), built on first use
  const inUrl = (pos) => pos > 0 && "/=?&#".includes(t[pos - 1]) && (url || (url = urlPrefixes(t)))[pos] === 1;
  for (const m of t.matchAll(PHONE_RUN)) {
    if (m.index > 0 && isWordChar(t[m.index - 1])) continue; // part of a word or an id: I0001234
    const [a, b] = unwrap(m[0]);
    const s = m.index + a;
    const run = m[0].slice(a, b);
    if (!run) continue;
    const groups = [...run.matchAll(DIGIT_GROUP)].map((g) => ({ at: g.index, d: g[0] }));
    const v = phoneVerdict(t, s, run, groups, inUrl);
    if (v) add("phone", s + v.off, s + run.length, v.rule);
  }
}

// ---------------------------------------------------------------- email

const LOCAL_CHARS = WORD_CHARS + ".%+-";
const DOMAIN = /(?:[A-Za-z0-9](?:[A-Za-z0-9\-]{0,61}[A-Za-z0-9])?\.){1,8}[A-Za-z]{2,24}\b/y;
const DOMAIN_SPELLED = /(?:[A-Za-z0-9\-]{1,63}(?:[ \t]*(?:\[dot\]|\(dot\)|\{dot\}|<dot>)[ \t]*|[ \t]+dot[ \t]+|\.)){1,8}[A-Za-z]{2,24}\b/iy;
const AT_SPELLED = /(?:\[at\]|\(at\)|\{at\}|<at>)[ \t]*/gi;

function localStart(t, at, spaced) {
  if (spaced) while (at > 0 && " \t".includes(t[at - 1])) at--; // ann [at] example [dot] org
  let i = at;
  while (i > 0 && at - i < 64 && LOCAL_CHARS.includes(t[i - 1])) i--;
  while (i < at && ".-".includes(t[i])) i++;
  for (let j = i; j < at; j++) if (WORD_CHARS.includes(t[j]) && t[j] !== "_") return i;
  return -1;
}

function domainEnd(t, pos, plainOk) {
  if (plainOk) {
    DOMAIN.lastIndex = pos;
    const m = DOMAIN.exec(t);
    if (m) return { end: pos + m[0].length, spelled: false };
  }
  DOMAIN_SPELLED.lastIndex = pos;
  const m = DOMAIN_SPELLED.exec(t);
  return m ? { end: pos + m[0].length, spelled: true } : null;
}

function scanEmails(t, add) {
  for (let at = t.indexOf("@"); at !== -1; at = t.indexOf("@", at + 1)) {
    const s = localStart(t, at);
    const d = s === -1 ? null : domainEnd(t, at + 1, true);
    if (d) add("email", s, d.end, d.spelled ? "spelled" : "address");
  }
  for (const m of t.matchAll(AT_SPELLED)) {
    const s = localStart(t, m.index, true);
    const d = s === -1 ? null : domainEnd(t, m.index + m[0].length, true);
    if (d) add("email", s, d.end, "spelled");
  }
}

// ---------------------------------------------------------------- street address and PO box

const STREET_STOP = [
  "to", "the", "a", "an", "in", "on", "at", "of", "and", "or", "from", "by", "for", "with", "near", "he", "she", "they", "we",
  "it", "was", "were", "is", "are", "his", "her", "their", "our", "my", "moved", "lived", "went", "times", "years", "months",
  "weeks", "days", "hours", "minutes", "kids", "children", "sons", "daughters", "people", "miles", "acres", "feet",
  "generations", "grandchildren", "cousins", "siblings", "brothers", "sisters", "year", "month", "week", "day", "hour",
  "minute", "foot", "percent", "degree", "degrees",
];
const STRONG_SUFFIXES = [
  "street", "st", "avenue", "ave", "av", "road", "rd", "lane", "ln", "drive", "dr", "boulevard", "blvd", "highway", "hwy",
  "parkway", "pkwy", "turnpike", "tpke", "expressway", "expy", "freeway", "fwy", "pike", "alley", "aly", "crescent", "cres",
];
const WEAK_SUFFIXES = [
  "court", "ct", "place", "pl", "terrace", "ter", "way", "circle", "cir", "square", "sq", "trail", "trl", "close", "row",
  "loop", "path", "walk", "plaza", "plz", "grove", "grv", "glen", "gardens", "gdns", "heights", "hts", "hill", "park",
  "point", "ridge", "rdg", "cove", "manor", "mews", "vale", "wynd", "quay", "crossing", "xing", "bend", "trace", "esplanade",
  "promenade",
];
const STRONG = new Set(STRONG_SUFFIXES);
// house number, then one to four street-name words (not a stop word), then a street suffix: 42 Elm Street, 221B Baker St.
const STREET = new RegExp(
  "\\b([0-9]{1,6})([A-Za-z]?)(?:-[0-9]{1,5}[A-Za-z]?)?[ \\t]+" +
  "(?:(?!(?:" + alternation(STREET_STOP) + ")\\b)(?:[A-Za-z][A-Za-z'.\\-]*|[0-9]{1,3}(?:st|nd|rd|th))[ \\t]+){1,4}?" +
  "(" + alternation([...STRONG_SUFFIXES, ...WEAK_SUFFIXES]) + ")\\b\\.?", "gi");
// (no two adjacent [ \t]* around an optional token: "p" or "pmb" followed by a long run of spaces must stay linear)
const PO_BOX = /\b(?:g?p[ \t]*(?:\.[ \t]*)?o\.?[ \t]*|post[ \t]+office[ \t]+)box[ \t]*(?:no\.?[ \t]*|#[ \t]*)?[0-9]{1,8}\b|\bpmb[ \t]*(?:#[ \t]*)?[0-9]{1,8}\b/gi;
// Rural-route and highway-contract boxes, either order: RR 2 Box 15, HC 65 Box 10, Rural Route 3, Box 120, Box 42, R.R. 1.
const ROUTE = "(?:r\\.?[ \\t]*r\\.?|r\\.?[ \\t]*f\\.?[ \\t]*d\\.?|h\\.?[ \\t]*c\\.?|rural[ \\t]+route|highway[ \\t]+contract" +
  "|star[ \\t]+route|route|rte\\.?|rt\\.?)[ \\t]*(?:#[ \\t]*)?[0-9]{1,4}";
const RURAL_BOX = new RegExp(
  `\\b${ROUTE}[ \\t]*(?:,[ \\t]*)?box[ \\t]*(?:#[ \\t]*)?[0-9]{1,6}\\b` +
  `|\\bbox[ \\t]*(?:#[ \\t]*)?[0-9]{1,6}[ \\t]*(?:,[ \\t]*)?${ROUTE}\\b`, "gi");
// A year directly after one of these is a date, not a house number: In 1850 Main Street was paved.
const YEAR_WORDS = new Set(["in", "by", "since", "until", "circa", "ca.", "c."]);

/** The word (with a trailing period) that ends just before the spaces at offset i, lower case; "" when there is none. */
function wordBefore(t, i) {
  let e = i;
  while (e > 0 && " \t".includes(t[e - 1])) e--;
  if (e === i) return "";
  let s = e > 0 && t[e - 1] === "." ? e - 1 : e;
  while (s > 0 && e - s < 8 && isWordChar(t[s - 1])) s--;
  return s > 0 && isWordChar(t[s - 1]) ? "" : t.slice(s, e).toLowerCase();
}

function scanAddresses(t, add) {
  for (const m of t.matchAll(STREET)) {
    if (!m[2] && YEAR_LIKE.test(m[1])) {
      // a year-like number is prose, not a house number, with a weak suffix (the 1920 Census Place) or after in, by, since,
      // until or circa (In 1850 Main Street was paved)
      if (!STRONG.has(m[3].toLowerCase()) || YEAR_WORDS.has(wordBefore(t, m.index))) continue;
    }
    add("street_address", m.index, m.index + m[0].length, "number-street");
  }
  for (const m of t.matchAll(RURAL_BOX)) add("street_address", m.index, m.index + m[0].length, "rural-route");
  for (const m of t.matchAll(PO_BOX)) add("po_box", m.index, m.index + m[0].length, "box");
}

// ---------------------------------------------------------------- contact channels

const SCHEME = new RegExp("\\b(?:" + alternation(CONTACT_SCHEMES) + "):[^ \\t\\r\\n\\f\\v<>\"']+", "gi");
const URLISH = /(?:[A-Za-z][A-Za-z0-9+.\-]{0,20}:\/\/)?((?:[A-Za-z0-9](?:[A-Za-z0-9\-]{0,61}[A-Za-z0-9])?\.){1,8}[A-Za-z]{2,24})(?![A-Za-z0-9\-])(?::[0-9]{1,5})?([\/?#][^ \t\r\n\f\v<>"']*)?/g;
const TRAILING = ".,;:!?)]}'\"";

const normHost = (host) => String(host).toLowerCase().replace(/\.+$/, "");
/** True when host is domain or a subdomain of it (registrable-domain suffix match, never a substring match). */
export const matchesDomain = (host, domain) => {
  const h = normHost(host);
  return h === domain || h.endsWith("." + domain);
};
const firstSegment = (path) => String(path || "").replace(/^\//, "").split(/[\/?#]/)[0].toLowerCase();

/** True for a messaging link: a contact host (wa.me, t.me, m.me, …) or a message path on a profile host (instagram.com/m/…). */
export function isContactChannel(host, path = "") {
  if (CONTACT_HOSTS.some((d) => matchesDomain(host, d))) return true;
  const seg = firstSegment(path);
  return CONTACT_PATHS.some(([d, s]) => seg === s && matchesDomain(host, d));
}

function trimEnd(t, start, end) {
  while (end > start && TRAILING.includes(t[end - 1])) end--;
  return end;
}

function scanContactUrls(t, add) {
  for (const m of t.matchAll(SCHEME)) add("contact_url", m.index, trimEnd(t, m.index, m.index + m[0].length), "scheme");
  for (const m of t.matchAll(URLISH)) {
    const s = m.index;
    if (s > 0 && (isWordChar(t[s - 1]) || "@.-".includes(t[s - 1]))) continue;
    const host = m[1].toLowerCase();
    const viaHost = CONTACT_HOSTS.some((d) => matchesDomain(host, d));
    if (!viaHost && !isContactChannel(host, m[2] || "")) continue;
    const hostEnd = m[0].indexOf(m[1]) + m[1].length;
    add("contact_url", s, trimEnd(t, s + hostEnd, s + m[0].length), viaHost ? "host" : "path");
  }
}

// ---------------------------------------------------------------- dob heuristic

const MONTH = "(?:jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|june?|july?|aug(?:ust)?|sep(?:t(?:ember)?)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)";
const DAY = "(?:3[01]|[12][0-9]|0?[1-9])";
const ORD = "(?:st|nd|rd|th)";
const UNITS = "(?:first|second|third|fourth|fifth|sixth|seventh|eighth|ninth)";
const WORD_ORD = `(?:twenty[ \\t\\-]?${UNITS}|thirty[ \\t\\-]?first|${UNITS}|tenth|eleventh|twelfth|thirteenth|fourteenth|fifteenth|sixteenth|seventeenth|eighteenth|nineteenth|twentieth|thirtieth)`;
const YEAR_TAIL = "(?:,?[ \\t]*(?:[0-9]{4}|'[0-9]{2})\\b)?";

// [rule, regex, kind of numeric check]; earlier and longer candidates win an overlap.
const DATE_FORMS = [
  ["month-day", new RegExp(`\\b${MONTH}\\b\\.?(?:[ \\t]+the)?[ \\t]+(?:${DAY}${ORD}?|${WORD_ORD})\\b${YEAR_TAIL}`, "gi"), null],
  ["day-month", new RegExp(`\\b(?:${DAY}${ORD}?(?:[ \\t]+of)?|${WORD_ORD}[ \\t]+of)[ \\t]+${MONTH}\\b\\.?${YEAR_TAIL}`, "gi"), null],
  ["numeric", /\b[0-9]{4}([\-\/.])(?:1[0-2]|0?[1-9])\1(?:3[01]|[12][0-9]|0?[1-9])\b/g, "free"],
  ["numeric", /\b([0-9]{1,2})([\-\/.])([0-9]{1,2})\2(?:[0-9]{4}|[0-9]{2})\b/g, "dmy"],
  ["numeric", /\b([0-9]{1,2})\/([0-9]{1,2})\b/g, "md"],
  // full dates with the month as letters: 5-Mar-1950, 05MAR1950, 5/mar/50 and Mar-05-1950, Mar.5.50
  ["day-month", new RegExp(`\\b${DAY}([\\-\\/.]?)${MONTH}\\1(?:[0-9]{4}|[0-9]{2})\\b`, "gi"), null],
  ["month-day", new RegExp(`\\b${MONTH}([\\-\\/.])${DAY}\\1(?:[0-9]{4}|[0-9]{2})\\b`, "gi"), null],
  ["month-year", new RegExp(`\\b${MONTH}\\b\\.?,?[ \\t]+(?:of[ \\t]+)?[0-9]{4}\\b`, "gi"), null],
  ["month-year", /\b(?:1[0-2]|0?[1-9])\/[0-9]{4}\b/g, "free"],
];
const RULE_ORDER = ["month-day", "day-month", "numeric", "month-year"];

const WORD_KEYWORD = new RegExp("\\b(?:" + alternation([...BIRTHDAY_KEYWORDS, ...EVENT_WORDS]) + ")\\b", "gi");
const ABBR_KEYWORD = new RegExp("\\b(?:" + alternation([...BIRTH_ABBREVIATIONS, ...EVENT_ABBREVIATIONS].map((a) => a.slice(0, -1))) + ")\\.", "g");
const BIRTH_ABBR = new Set(BIRTH_ABBREVIATIONS);

/** A numeric date that is part of a longer dotted or slashed number (an IP address, 1.12.05.50) is not a date. */
function numericIsolated(t, s, e) {
  const sepDigit = (i, j) => "-/.".includes(t[i] || "x") && isDigit(t[j]);
  return !sepDigit(e, e + 1) && !(s >= 2 && sepDigit(s - 1, s - 2));
}

function dateCandidates(t) {
  const found = [];
  for (const [rule, re, check] of DATE_FORMS) {
    for (const m of t.matchAll(re)) {
      const s = m.index, e = s + m[0].length;
      if (check) {
        if (!numericIsolated(t, s, e)) continue;
        if (check === "dmy" && !dayMonth(+m[1], +m[3])) continue;
        if (check === "md" && !dayMonth(+m[1], +m[2])) continue;
      }
      found.push({ start: s, end: e, rule });
    }
  }
  found.sort((a, b) => a.start - b.start || b.end - a.end || RULE_ORDER.indexOf(a.rule) - RULE_ORDER.indexOf(b.rule));
  const out = [];
  for (const c of found) if (!out.length || c.start >= out[out.length - 1].end) out.push(c);
  return out;
}

/** Event keywords sorted by start; they never overlap, so their ends are sorted too. */
function keywords(t) {
  const words = [...t.matchAll(WORD_KEYWORD)].map((m) => ({
    start: m.index, end: m.index + m[0].length, birth: BIRTHDAY_KEYWORDS.has(m[0].toLowerCase().replace(/[ \t]+/g, " ")),
  }));
  const abbrs = [];
  let w = 0; // the first word that ends after this abbreviation starts
  for (const m of t.matchAll(ABBR_KEYWORD)) {
    const s = m.index, e = s + m[0].length;
    if (s > 0 && ".'".includes(t[s - 1])) continue; // p.m., a.m.
    while (w < words.length && words[w].end <= s) w++;
    if (w < words.length && words[w].start < e) continue; // inside d.o.b
    abbrs.push({ start: s, end: e, birth: BIRTH_ABBR.has(m[0]) });
  }
  return [...words, ...abbrs].sort((a, b) => a.start - b.start);
}

function scanDob(t, add) {
  const dates = dateCandidates(t); // sorted and non-overlapping
  if (!dates.length) return;
  const kws = keywords(t);
  // The nearest event word owns the date: the last keyword ending at or before it, or the first starting at or after its end
  // (not for a month-year); a tie goes to the birth keyword. Two cursors, so linear in dates plus keywords.
  let before = 0, after = 0;
  for (const d of dates) {
    while (before < kws.length && kws[before].end <= d.start) before++;
    while (after < kws.length && kws[after].start < d.end) after++;
    let best = Infinity, birth = false;
    if (before > 0 && d.start - kws[before - 1].end <= DOB_WINDOW) {
      best = d.start - kws[before - 1].end;
      birth = kws[before - 1].birth;
    }
    if (d.rule !== "month-year" && after < kws.length) {
      const gap = kws[after].start - d.end;
      if (gap <= DOB_WINDOW && (gap < best || (gap === best && kws[after].birth))) birth = kws[after].birth;
    }
    if (birth) add("dob_heuristic", d.start, d.end, d.rule);
  }
}

// ---------------------------------------------------------------- API

const DETECTORS = [scanPhones, scanEmails, scanAddresses, scanContactUrls, scanDob];

/**
 * Every R-18 / R-19 finding in `text`, sorted by start, end and kind. `opts.kinds` limits the result to those kinds.
 * null and undefined scan as empty; any other non-string is a TypeError.
 * @param {string} text
 * @param {{ kinds?: Iterable<string> }} [opts]
 * @returns {{ kind: string, start: number, end: number, rule: string }[]}
 */
export function scanText(text, opts = {}) {
  if (text === null || text === undefined) return [];
  if (typeof text !== "string") throw new TypeError("scanText: text must be a string");
  const want = opts && opts.kinds != null ? new Set(opts.kinds) : null;
  const { t, from, to } = normalize(text);
  const hits = [];
  const seen = new Set();
  const add = (kind, start, end, rule) => {
    if ((want && !want.has(kind)) || end <= start) return;
    if (from) [start, end] = [from[start], to[end - 1]]; // back to the caller's offsets
    const key = kind + ":" + start + ":" + end;
    if (seen.has(key)) return;
    seen.add(key);
    hits.push({ kind, start, end, rule });
  };
  for (const detect of DETECTORS) detect(t, add);
  return hits.sort((a, b) => a.start - b.start || a.end - b.end || KINDS.indexOf(a.kind) - KINDS.indexOf(b.kind));
}

/**
 * The write-path verdict: `{ ok: true }`, or `{ ok: false, code, message, kinds, spans }` where code is `dob_not_allowed` when
 * every hit is a dob kind and `contact_info` otherwise. Spans are `{kind, start, end}`; the matched text is never included.
 * @param {string} text
 * @param {{ kinds?: Iterable<string> }} [opts]
 */
export function rejectContactInfo(text, opts = {}) {
  const hits = scanText(text, opts);
  if (hits.length === 0) return { ok: true };
  const kinds = KINDS.filter((k) => hits.some((h) => h.kind === k));
  const code = kinds.every((k) => DOB_KINDS.includes(k)) ? "dob_not_allowed" : "contact_info";
  return { ok: false, code, message: COPY[code], kinds, spans: hits.map(({ kind, start, end }) => ({ kind, start, end })) };
}
