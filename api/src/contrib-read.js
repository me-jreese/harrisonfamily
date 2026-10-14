// The contributions read side (HFY-TSK-256, hfy-contrib-read-api; BRD2 D2-17, social.md 7.4 and 7.5). Three reads over the ledger that
// contrib.js writes:
//
//   list   GET /contributions?author=      a member's events, newest first, filtered by what the viewer may see
//   stats  GET /contributions/stats?author= a member's counters
//   site   GET /contributions/stats        the site total and the feed line, through the cached CSTAT#site/LINE row
//
// pickLine() is the pure window rule behind the feed line ("12 contributions in the past 3 days"). An event copies no body text, so a list
// row leaks ids, a kind and counts at most; what the viewer may see of it still follows the thing it is about (a post, a proposal thread).
import { canView } from "@io-kit/content";
import { HttpError } from "./http.js";
import { eventKeys, personKeys, siteKeys } from "./contrib.js";

export const DEFAULT_LIMIT = 10;
export const MAX_LIMIT = 50;
/** A cached feed line is reused for this long, then recomputed (social.md 7.4). */
export const LINE_TTL_MS = 3_600_000;
/** The LINE row expires from the table 2 hours after it was computed (BRD2 4.2). */
export const LINE_ROW_TTL_S = 7_200;
/** Posts and proposals are read for the visibility check in BatchGets of at most this many keys (social.md 7.5). */
export const BATCH_KEYS = 20;
/** Pages of events examined for one list call before it hands back a cursor (a long run of events the viewer cannot see). */
export const MAX_ROUNDS = 5;
/** The feed line never claims a window longer than this many years. */
export const MAX_YEARS = 10;
/** Windows longer than this many days are summed from the `M#` month buckets (the `D#` day rows live 800 days). */
export const MONTH_BUCKET_DAYS = 400;
/** The counter kinds `contributions.stats` reports: the event kinds plus `photo` (n_photo, the images attached). */
export const STAT_KINDS = Object.freeze(["post", "comment", "photo", "self_edit", "proposal_accepted", "tag", "photo_to_record"]);

const DAY_MS = 86_400_000;
const AUTHOR_RE = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,63}$/;
const EVENT_SK_RE = /^E#[0-9A-HJKMNP-TV-Z]{26}$/;
const DAY_RE = /^\d{4}-\d{2}-\d{2}$/;
const num = (v) => (Number.isFinite(v) && v > 0 ? v : 0);
const enc = encodeURIComponent;

// ---------------------------------------------------------------------------------------------------------------------------------
// pickLine: the pure window rule
// ---------------------------------------------------------------------------------------------------------------------------------

/**
 * The candidate windows, shortest first (social.md 7.4): 1 to 6 days, 7/14/21 days as weeks, 30/60/90/180 days as months, then 365 days
 * times 1, 2, ... as years. `y` is the number the copy shows, `unit` the word.
 */
export const CANDIDATES = Object.freeze([
  ...[1, 2, 3, 4, 5, 6].map((d) => ({ days: d, y: d, unit: "day" })),
  ...[7, 14, 21].map((d) => ({ days: d, y: d / 7, unit: "week" })),
  ...[30, 60, 90, 180].map((d) => ({ days: d, y: d / 30, unit: "month" })),
  ...Array.from({ length: MAX_YEARS }, (_, i) => ({ days: 365 * (i + 1), y: i + 1, unit: "year" })),
].map((c) => Object.freeze(c)));

/** The copy: lowercase, no trailing stop. `1 week` for one, `3 days` for several (DS voice). */
export const lineText = (x, y, unit) => `${x} contribution${x === 1 ? "" : "s"} in the past ${y === 1 ? unit : `${y} ${unit}s`}`;

/** Epoch day number of a `YYYY-MM-DD` day or an ISO timestamp (UTC), or undefined. */
function dayNumber(v) {
  if (typeof v !== "string" || v.length < 10 || !DAY_RE.test(v.slice(0, 10))) return undefined;
  const t = Date.parse(`${v.slice(0, 10)}T00:00:00Z`);
  return Number.isNaN(t) ? undefined : Math.floor(t / DAY_MS);
}
const dayKey = (n) => new Date(n * DAY_MS).toISOString().slice(0, 10);
const monthIndexOf = (n) => {
  const d = new Date(n * DAY_MS);
  return d.getUTCFullYear() * 12 + d.getUTCMonth();
};
const monthKey = (i) => `${String(Math.floor(i / 12)).padStart(4, "0")}-${String((i % 12) + 1).padStart(2, "0")}`;

/**
 * pickLine(buckets, today, firstAt, prev?) -> { x, y, unit, window_days, text } | null
 *
 * `buckets` maps a UTC day (`YYYY-MM-DD`) or a month (`YYYY-MM`) to its contribution count; a missing bucket is 0 and a negative or
 * non-numeric one is clamped to 0 (a revoke past a day row's ttl can leave one). `today` is the UTC day, `firstAt` the site's first
 * contribution (an ISO timestamp). The windows are CANDIDATES. For window `w`, X(w) sums the w most recent day buckets, today included,
 * and P(w) the w before them; a window over 400 days sums 12 * years month buckets instead. A window is eligible only if the site's
 * history (firstAt through today) is at least as long, so a young site never claims "the past 2 years". Then:
 *   1. Hot: the shortest eligible window of 30 days or fewer with X >= 5 and X >= P (flat or rising).
 *   2. Volume: otherwise the shortest eligible window with X >= 3.
 *   3. Otherwise null (the UI shows the no-number line; "1 contribution in the past day" is never produced).
 * Dwell: `prev` is the pick cached earlier, `{ window_days, day }`. If it was made on the same UTC day, its window is still eligible
 * with X >= 3, and the fresh pick is at most one candidate step away, that window is kept (with its current X), so reloads never
 * flicker between neighbours. A missing or unreadable `firstAt` or `today` gives null.
 * Approximation: a multi-year window is 12 * years whole calendar month buckets (the partial current month included), so the days it
 * covers differ a little from `window_days`. Windows are capped at MAX_YEARS years; the design lists no upper bound.
 */
export function pickLine(buckets, today, firstAt, prev) {
  const t = dayNumber(today);
  const f = dayNumber(firstAt);
  if (t === undefined || f === undefined) return null;
  const history = t - f + 1;
  if (history < 1) return null;
  const map = buckets && typeof buckets === "object" ? buckets : {};
  const at = (key) => num(map[key]);
  const sum = (from, count, key) => {
    let s = 0;
    for (let i = from; i < from + count; i += 1) s += at(key(i));
    return s;
  };
  const sums = (c) => {
    if (c.days > MONTH_BUCKET_DAYS) {
      const m = monthIndexOf(t);
      const n = 12 * c.y;
      return [sum(m - n + 1, n, monthKey), sum(m - 2 * n + 1, n, monthKey)];
    }
    return [sum(t - c.days + 1, c.days, dayKey), sum(t - 2 * c.days + 1, c.days, dayKey)];
  };
  const eligible = CANDIDATES.filter((c) => history >= c.days);
  const hot = eligible.find((c) => {
    if (c.days > 30) return false;
    const [x, p] = sums(c);
    return x >= 5 && x >= p;
  });
  const pick = hot ?? eligible.find((c) => sums(c)[0] >= 3);
  if (!pick) return null;

  let chosen = pick;
  const kept = prev && prev.day === dayKey(t) ? eligible.find((c) => c.days === prev.window_days) : undefined;
  if (kept && sums(kept)[0] >= 3 && Math.abs(CANDIDATES.indexOf(kept) - CANDIDATES.indexOf(pick)) <= 1) chosen = kept;
  const x = sums(chosen)[0];
  return { x, y: chosen.y, unit: chosen.unit, window_days: chosen.days, text: lineText(x, chosen.y, chosen.unit) };
}

// ---------------------------------------------------------------------------------------------------------------------------------
// What a viewer may see of an event
// ---------------------------------------------------------------------------------------------------------------------------------

/**
 * Who may see a proposal's thread (editing.md 7.4, D2-13): the proposer, admins, and the owners of the pages it targets. The proposal store
 * (proposal-store-api) records the owners as `owners: [principal]` on the proposal; until it does, the owner of the page the proposal is
 * about (`subject.gramps_id`) counts. Anyone else, and a proposal that is gone, sees nothing. createContribReader takes a replacement.
 * Hard dependency: proposal-store-api (or proposal-decision-api) must either write `owners[]` for every targeted page or pass its own rule
 * through createContribReader({ proposalVisible }). Until then the circle is narrower than the design, and it fails closed.
 */
export function proposalVisible(proposal, viewer) {
  if (!proposal || !viewer?.id) return false;
  if (viewer.admin === true) return true;
  if (proposal.proposer?.id === viewer.id) return true;
  if (proposal.subject?.gramps_id === viewer.id) return true;
  return Array.isArray(proposal.owners) && proposal.owners.includes(viewer.id);
}

/** The record id of a subject (`person:I0001` or a bare gramps id), or undefined for a post or proposal subject. */
function personOf(subject) {
  if (typeof subject !== "string") return undefined;
  const id = subject.startsWith("person:") ? subject.slice(7) : subject;
  return AUTHOR_RE.test(id) ? id : undefined;
}

/** The thread a comment event belongs to (`person:<id>`, `post:<id>`, `proposal:<ulid>`). */
const threadOf = (e) => (typeof e.ref?.thread === "string" ? e.ref.thread : typeof e.subject === "string" ? e.subject : undefined);

/**
 * What an event depends on for visibility: `{ post }`, `{ proposal }` or nothing (a person thread, a record, a tag, a photo). A `proposal`
 * ref event (kind proposal_accepted) depends on nothing: it is written only when a proposal is accepted, and an accepted proposal is public
 * (social.md 7.5, PS-09 name proposal-thread comments only). Person pages are not per-viewer in this design, so person-thread and record
 * events need no target check either.
 */
function dependency(e) {
  if (e.ref?.type === "post" && typeof e.ref.id === "string") return { post: e.ref.id };
  if (e.ref?.type === "comment") {
    const t = threadOf(e);
    if (t?.startsWith("post:")) return { post: t.slice(5) };
    if (t?.startsWith("proposal:")) return { proposal: t.slice(9) };
  }
  return {};
}

/**
 * The link the server computes for an event (social.md 7.5): a post to `/posts/?id=`, a comment to its page with `#comment-<ulid>`,
 * a proposal, record or tag to the person's page, and a photo to `#photos`. `proposals` maps a visible proposal id to its document
 * (a proposal thread's comment links to the page the proposal is about). null when the page cannot be named.
 */
export function hrefOf(e, proposals = new Map()) {
  const person = (id, hash = "") => (id ? `/person/?id=${enc(id)}${hash}` : null);
  switch (e.ref?.type) {
    case "post":
      return `/posts/?id=${enc(e.ref.id)}`;
    case "comment": {
      const t = threadOf(e);
      const anchor = `#comment-${e.ref.id}`;
      if (t?.startsWith("post:")) return `/posts/?id=${enc(t.slice(5))}${anchor}`;
      if (t?.startsWith("proposal:")) return person(proposals.get(t.slice(9))?.subject?.gramps_id, anchor);
      return person(personOf(t?.startsWith("person:") ? t : e.subject), anchor);
    }
    case "media":
      return person(personOf(e.subject), "#photos");
    case "proposal":
    case "record":
    case "tag":
      return person(personOf(e.subject));
    default:
      return null;
  }
}

/** A list row: the event without its keys, actor or origin. */
const rowOf = (e, href) => ({
  id: e.id, kind: e.kind, at: e.at, weight: e.weight, photos: e.photos ?? 0,
  ref: { type: e.ref.type, id: e.ref.id, ...(e.ref.thread !== undefined ? { thread: e.ref.thread } : {}) },
  ...(e.subject !== undefined ? { subject: e.subject } : {}),
  href,
  ...(e.hidden ? { hidden: true } : {}),
});

const encodeCursor = (sk) => Buffer.from(sk, "utf8").toString("base64url");
function decodeCursor(cursor) {
  const sk = typeof cursor === "string" && /^[A-Za-z0-9_-]{1,64}$/.test(cursor) ? Buffer.from(cursor, "base64url").toString("utf8") : "";
  if (!EVENT_SK_RE.test(sk)) throw new HttpError(400, "cursor_invalid", "that cursor is not valid. start again.");
  return sk;
}

function parseLimit(v) {
  if (v === undefined || v === "") return DEFAULT_LIMIT;
  const n = Number(v);
  if (!Number.isInteger(n) || n < 1 || n > MAX_LIMIT) throw new HttpError(400, "validation", `limit must be a whole number from 1 to ${MAX_LIMIT}`);
  return n;
}
function parseAuthor(v) {
  if (typeof v !== "string" || v === "") throw new HttpError(400, "validation", "author is required");
  if (!AUTHOR_RE.test(v)) throw new HttpError(400, "validation", "author must be a gramps id");
  return v;
}

// ---------------------------------------------------------------------------------------------------------------------------------
// The reader
// ---------------------------------------------------------------------------------------------------------------------------------

/**
 * Builds the three reads for one request. `actor` is the viewer ({id, admin}); `now` the clock in milliseconds (injected, so the LINE
 * cache is testable). `proposalVisible` can be replaced by the proposal store's own rule.
 */
export function createContribReader({ ddb, cmds, table, actor, now = () => Date.now(), log = console, proposalVisible: canSeeProposal = proposalVisible }) {
  const viewer = actor ?? null;

  /** BatchGet of unique keys in chunks of BATCH_KEYS; unprocessed keys are retried once. Returns Map(`PK|SK` -> item); a key never read is absent. */
  async function readItems(keys) {
    const out = new Map();
    const seen = new Set();
    const unique = keys.filter((k) => !seen.has(`${k.PK}|${k.SK}`) && seen.add(`${k.PK}|${k.SK}`));
    for (let i = 0; i < unique.length; i += BATCH_KEYS) {
      let pending = unique.slice(i, i + BATCH_KEYS);
      for (let attempt = 0; attempt < 2 && pending.length > 0; attempt += 1) {
        const r = await ddb.send(new cmds.BatchGetCommand({ RequestItems: { [table]: { Keys: pending } } }));
        for (const item of r.Responses?.[table] ?? []) out.set(`${item.PK}|${item.SK}`, item);
        pending = r.UnprocessedKeys?.[table]?.Keys ?? [];
      }
      // Whatever is still unprocessed is left out of the map; a missing item reads as "cannot see", so the event is omitted (fail closed).
    }
    return out;
  }

  /** The rows of one page of events the viewer may see, in order. */
  async function visibleRows(events, author) {
    const own = viewer?.id === author || viewer?.admin === true;
    const shown = events.filter((e) => e && typeof e.id === "string" && e.ref && (own || !e.hidden));
    const deps = shown.map(dependency);
    const keys = deps.flatMap((d) => (d.post ? [{ PK: `POST#${d.post}`, SK: "META" }] : d.proposal ? [{ PK: `PROP#${d.proposal}`, SK: "META" }] : []));
    const items = keys.length > 0 ? await readItems(keys) : new Map();
    const proposals = new Map();
    const rows = [];
    shown.forEach((e, i) => {
      const d = deps[i];
      if (d.post) {
        const post = items.get(`POST#${d.post}|META`)?.post;
        if (!post || !canView(post, viewer)) return;
      }
      if (d.proposal) {
        const proposal = items.get(`PROP#${d.proposal}|META`)?.proposal;
        if (!proposal || !canSeeProposal(proposal, viewer)) return;
        proposals.set(d.proposal, proposal);
      }
      rows.push({ source: e, row: rowOf(e, hrefOf(e, proposals)) });
    });
    return rows;
  }

  return {
    /** contributions.list: { items, cursor }. Newest first; `cursor` is opaque and null at the end. */
    async list(authorId, { cursor, limit } = {}) {
      const author = parseAuthor(authorId);
      const size = parseLimit(limit);
      let start = cursor !== undefined && cursor !== "" ? decodeCursor(cursor) : undefined;
      const items = [];
      for (let round = 0; round < MAX_ROUNDS; round += 1) {
        const r = await ddb.send(new cmds.QueryCommand({
          TableName: table, KeyConditionExpression: "PK = :pk AND begins_with(SK, :sk)",
          ExpressionAttributeValues: { ":pk": `CONTRIB#${author}`, ":sk": "E#" }, ScanIndexForward: false, Limit: size,
          ...(start ? { ExclusiveStartKey: eventKeys(author, start.slice(2)) } : {}),
        }));
        const page = r.Items ?? [];
        const visible = new Map((await visibleRows(page, author)).map((v) => [v.source.id, v.row]));
        for (let i = 0; i < page.length; i += 1) {
          const row = visible.get(page[i].id);
          if (!row) continue;
          items.push(row);
          if (items.length === size) return { items, cursor: i === page.length - 1 && !r.LastEvaluatedKey ? null : encodeCursor(page[i].SK) };
        }
        if (!r.LastEvaluatedKey) return { items, cursor: null };
        start = r.LastEvaluatedKey.SK;
      }
      return { items, cursor: encodeCursor(start) }; // a long run the viewer cannot see: they continue from here
    },

    /** contributions.stats: a member's counters, clamped at 0. An unknown author reads as zeros. */
    async stats(authorId) {
      const author = parseAuthor(authorId);
      const r = await ddb.send(new cmds.GetCommand({ TableName: table, Key: personKeys(author, "TOTAL") }));
      const row = r.Item ?? {};
      return {
        author,
        total: num(row.n),
        by_kind: Object.fromEntries(STAT_KINDS.map((k) => [k, num(row[`n_${k}`])])),
        ...(typeof row.first_at === "string" ? { first_at: row.first_at } : {}),
      };
    },

    /** contributions.site: the site total and the feed line, through the cached LINE row (recomputed once it is an hour old). */
    async site() {
      const at = now();
      const total = await ddb.send(new cmds.GetCommand({ TableName: table, Key: siteKeys("TOTAL") }));
      const sum = num(total.Item?.n);
      const cached = (await ddb.send(new cmds.GetCommand({ TableName: table, Key: siteKeys("LINE") }))).Item;
      const age = cached ? at - Date.parse(cached.computed_at) : Infinity;
      if (cached && age >= 0 && age < LINE_TTL_MS) return { total: sum, line: lineOf(cached), computed_at: cached.computed_at };

      const today = new Date(at).toISOString().slice(0, 10);
      const firstAt = total.Item?.first_at;
      const buckets = await readBuckets(today, firstAt);
      const prev = cached?.window_days ? { window_days: cached.window_days, day: String(cached.computed_at).slice(0, 10) } : undefined;
      const line = pickLine(buckets, today, firstAt, prev);
      const computedAt = new Date(at).toISOString();
      try {
        await ddb.send(new cmds.PutCommand({
          TableName: table,
          Item: { ...siteKeys("LINE"), ...(line ?? {}), computed_at: computedAt, ttl: Math.floor(at / 1000) + LINE_ROW_TTL_S },
        }));
      } catch (e) {
        log.error?.("contribution line cache write failed (served uncached)", { name: e?.name });
      }
      return { total: sum, line, computed_at: computedAt };
    },
  };

  function lineOf(row) {
    return typeof row.text === "string" && Number.isFinite(row.x) ? { x: row.x, y: row.y, unit: row.unit, window_days: row.window_days, text: row.text } : null;
  }

  /** The `D#` day rows of the last 366 days and, for a site old enough to use a multi-year window, the `M#` month rows. */
  async function readBuckets(today, firstAt) {
    const buckets = {};
    const t = dayNumber(today);
    const read = async (lo, hi, prefix) => {
      let key;
      for (let i = 0; i < MAX_ROUNDS; i += 1) {
        const r = await ddb.send(new cmds.QueryCommand({
          TableName: table, KeyConditionExpression: "PK = :pk AND SK BETWEEN :lo AND :hi",
          ExpressionAttributeValues: { ":pk": "CSTAT#site", ":lo": `${prefix}${lo}`, ":hi": `${prefix}${hi}` }, ...(key ? { ExclusiveStartKey: key } : {}),
        }));
        for (const it of r.Items ?? []) buckets[it.SK.slice(prefix.length)] = it.n;
        key = r.LastEvaluatedKey;
        if (!key) break;
      }
    };
    await read(dayKey(t - 365), today, "D#");
    const first = dayNumber(firstAt);
    if (first !== undefined && t - first + 1 >= 730) {
      const m = monthIndexOf(t);
      await read(monthKey(m - 12 * MAX_YEARS + 1), monthKey(m), "M#");
    }
    return buckets;
  }
}
