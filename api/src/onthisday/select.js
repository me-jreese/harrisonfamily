// On this day, the pure selector (HFY-PLN-002 surfaces section 4.1, 4.2 and 4.4). No I/O and no clock: the date is an argument,
// and the only "randomness" is a shuffle seeded by sha256(date), so one date always gives one answer and the next date a different one.
import { createHash } from "node:crypto";
import { templateFor } from "../shared/onthisday-copy.mjs";

const MAX_ITEMS = 3;
const WEEK_DAYS = 3;
const DAY_MS = 86_400_000;
const EMOJI = Object.freeze({ marriage: "❤️", graduation: "\u{1F44F}\u{1F3FE}", degree: "\u{1F44F}\u{1F3FE}" });
const EMOJI_MIN_YEARS = 50;
const KINDS = new Set(["marriage", "graduation", "degree", "education", "birth", "residence", "death", "burial"]);
const TONES = new Set(["celebrate", "neutral", "remember"]);
const pad = (n) => String(n).padStart(2, "0");

function parseDate(date) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(date));
  if (!m) throw new TypeError("date must be YYYY-MM-DD");
  const [y, mo, d] = [+m[1], +m[2], +m[3]];
  const t = new Date(Date.UTC(y, mo - 1, d));
  if (t.getUTCFullYear() !== y || t.getUTCMonth() !== mo - 1 || t.getUTCDate() !== d) throw new TypeError("date must be a real calendar day");
  return { y, mo, d };
}

/** Mulberry32 over the first 32 bits of sha256(date): small, fast, and stable across platforms. */
function rng(date) {
  let a = createHash("sha256").update(String(date)).digest().readUInt32BE(0);
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const shuffled = (arr, rand) => {
  const out = [...arr].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  for (let i = out.length - 1; i > 0; i -= 1) {
    const j = Math.floor(rand() * (i + 1));
    [out[i], out[j]] = [out[j], out[i]];
  }
  return out;
};

/** Absolute day distance between the item's month-day and today's, across a year boundary. */
function dayDistance(item, today) {
  let best = Infinity;
  for (const dy of [-1, 0, 1]) {
    const t = Date.UTC(today.y + dy, item.month - 1, item.day);
    best = Math.min(best, Math.abs(t - Date.UTC(today.y, today.mo - 1, today.d)) / DAY_MS);
  }
  return best;
}

const yearRank = (it) => (it.n % 25 === 0 ? 0 : it.n % 10 === 0 ? 1 : it.n % 5 === 0 ? 2 : 3);
const yearEligible = (it) => it.n >= 10 && (it.kind === "birth" ? it.n % 10 === 0 || it.n === 25 || it.n === 75 : it.n % 5 === 0);

/** An index item as the served shape, or null when this module must not show it. */
function shape(raw, when, today, hiddenSet) {
  if (!raw || typeof raw !== "object" || hiddenSet.has(raw.id)) return null;
  if (!KINDS.has(raw.kind) || !Number.isInteger(raw.year) || !Array.isArray(raw.people) || !raw.people.length) return null;
  const n = today.y - raw.year;
  if (n < 1) return null;
  const birth = raw.kind === "birth";
  let tone = TONES.has(raw.tone) ? raw.tone : "neutral";
  // Defence in depth: a birth is year-only and only a living person up to 100 is celebrated; remember is for death and burial alone.
  if (birth && !(tone === "celebrate" && raw.people[0]?.lifeState === "living" && n <= 100)) tone = "neutral";
  if (!birth && raw.kind !== "death" && raw.kind !== "burial" && tone === "remember") tone = "neutral";
  if ((raw.kind === "death" || raw.kind === "burial")) tone = "remember";
  const item = { id: raw.id, kind: raw.kind, tone, when, n, year: raw.year, people: raw.people.map((p) => ({ grampsId: p.grampsId, name: p.name, lifeState: p.lifeState })) };
  if (raw.place) item.place = raw.place;
  if (raw.detail) item.detail = raw.detail;
  if (!birth && raw.month && raw.day) { item.month = raw.month; item.day = raw.day; }
  return templateFor(item) ? item : null;
}

/** Up to MAX_ITEMS in order: distinct people, varied kinds first, at most one remember row. Celebrations come before the remember row. */
function pick(ordered) {
  const chosen = [];
  const people = new Set();
  let remember = 0;
  const take = (it) => {
    if (it.people.some((p) => people.has(p.grampsId))) return false;
    if (it.tone === "remember" && remember) return false;
    chosen.push(it);
    it.people.forEach((p) => people.add(p.grampsId));
    if (it.tone === "remember") remember += 1;
    return true;
  };
  const kinds = new Set();
  for (const it of ordered) { if (chosen.length < MAX_ITEMS && !kinds.has(it.kind) && take(it)) kinds.add(it.kind); }
  for (const it of ordered) if (chosen.length < MAX_ITEMS && !chosen.includes(it)) take(it);
  const rank = (it) => (it.tone === "remember" ? 1 : 0);
  return chosen.map((it, i) => [it, i]).sort((a, b) => rank(a[0]) - rank(b[0]) || a[1] - b[1]).map(([it]) => it);
}

function candidates(index, today, hiddenSet) {
  const key = `${pad(today.mo)}-${pad(today.d)}`;
  const dated = (list, when) => (Array.isArray(list) ? list : []).map((r) => (r?.kind === "birth" ? null : shape(r, when, today, hiddenSet))).filter(Boolean);
  const day = dated(index?.day?.[key], "day");
  if (day.length) return { tier: "day", list: day };
  const months = new Set();
  for (let off = -WEEK_DAYS; off <= WEEK_DAYS; off += 1) months.add(pad(new Date(Date.UTC(today.y, today.mo - 1, today.d + off)).getUTCMonth() + 1));
  const near = [...months].flatMap((m) => (Array.isArray(index?.month?.[m]) ? index.month[m] : []))
    .filter((r) => r && r.month && r.day && dayDistance(r, today) <= WEEK_DAYS);
  const week = dated(near, "week");
  if (week.length) return { tier: "week", list: week };
  const year = (Array.isArray(index?.year) ? index.year : []).map((r) => shape(r, "year", today, hiddenSet)).filter((it) => it && yearEligible(it));
  return year.length ? { tier: "year", list: year } : { tier: null, list: [] };
}

/**
 * selectOnThisDay(index, { date, posts, hidden }) -> `{ date, tier, items, posts, prompt, indexVersion }`.
 * `posts` are the already-fetched published posts of past years on this local day (`{ id, n, author, excerpt, photo }`);
 * `hidden` is an iterable of hidden item or post ids. Ladder: day, week, year, then archive (posts only), then a prompt.
 */
export function selectOnThisDay(index, { date, posts = [], hidden = [] } = {}) {
  const today = parseDate(date);
  const hiddenSet = new Set(hidden);
  const rand = rng(date);
  const { tier: itemTier, list } = candidates(index, today, hiddenSet);

  let ordered = shuffled(list, rand);
  if (itemTier === "year") ordered = ordered.map((it, i) => [it, i]).sort((a, b) => yearRank(a[0]) - yearRank(b[0]) || a[1] - b[1]).map(([it]) => it);
  const items = pick(ordered);

  // At most one emoji in the whole module: a celebrate row of 50 years or more, never a remember row.
  const lucky = items.find((it) => it.tone === "celebrate" && it.n >= EMOJI_MIN_YEARS && EMOJI[it.kind]);
  if (lucky) lucky.emoji = EMOJI[lucky.kind];

  const post = (Array.isArray(posts) ? posts : []).find((p) => p && typeof p.id === "string" && Number.isInteger(p.n) && p.n >= 1 && p.author && !hiddenSet.has(p.id));
  const outPosts = post ? [post] : [];

  let prompt = null;
  if (items.length < 2) {
    const asks = shuffled((Array.isArray(index?.year) ? index.year : []).filter((r) => r && r.kind === "marriage" && r.tone === "celebrate" && !r.day && Array.isArray(r.people) && r.people.length >= 2 && !hiddenSet.has(r.id)), rng(`${date}:prompt`));
    prompt = asks.length
      ? { kind: "add_day", itemId: asks[0].id, people: asks[0].people.slice(0, 2).map((p) => ({ grampsId: p.grampsId, name: p.name })) }
      : { kind: "generic" };
  }
  return { date, tier: items.length ? itemTier : outPosts.length ? "archive" : "prompt", items, posts: outPosts, prompt, indexVersion: index?.sourceVersion ?? null };
}
