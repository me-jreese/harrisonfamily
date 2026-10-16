// /admin/sync/ (HFY-TSK-279, sync-admin-status-page; sync.md 13.3, flag syncStatusV1): the pure model of the page. Words are plain, lowercase and
// short (the family voice); values are shown as text and never as markup. No dates or names are made up here: everything comes from the status read.

export const COPY = {
  title: "sync status",
  signedOut: "sign in to see the sync status.",
  notAllowed: "this page is for the people who look after the site.",
  off: "the sync status isn't available yet.",
  loadFailed: "the sync status didn't load. try again in a minute.",
  noDesktop: "the desktop hasn't checked in yet.",
  noConflicts: "no conflicts. the website and the desktop agree.",
  noBatches: "nothing has been sent yet.",
  ownerOnly: "only the owner of the site can decide a conflict. you can read it here.",
  keepWebsite: "keep website",
  keepDesktop: "keep desktop",
  confirmHelp: "the add-on applies this only if the website's value is still the one shown. if it changed, the conflict opens again.",
};

export const DECISIONS = Object.freeze({ keep_cloud: "keep_website", keep_desktop: "keep_desktop" });

const isObj = (v) => v !== null && typeof v === "object" && !Array.isArray(v);
const int = (v) => (Number.isInteger(v) ? v : null);

/** "2026-10-14T11:59:30.000Z" -> "2026-10-14 11:59 utc"; anything else -> "unknown". */
export function stamp(iso) {
  const m = typeof iso === "string" ? /^(\d{4}-\d{2}-\d{2})T(\d{2}:\d{2})/.exec(iso) : null;
  return m ? `${m[1]} ${m[2]} utc` : "unknown";
}

/** "5 minutes ago" style, from a clock the caller gives (so tests are exact). */
export function ago(iso, now = Date.now()) {
  const t = typeof iso === "string" ? Date.parse(iso) : NaN;
  if (!Number.isFinite(t)) return "unknown";
  const s = Math.max(0, Math.round((now - t) / 1000));
  if (s < 60) return "just now";
  const unit = (n, w) => `${n} ${w}${n === 1 ? "" : "s"} ago`;
  if (s < 3600) return unit(Math.floor(s / 60), "minute");
  if (s < 86400) return unit(Math.floor(s / 3600), "hour");
  return unit(Math.floor(s / 86400), "day");
}

/** "/primary_name/first_name" -> "primary name, first name". */
export function pathWords(path) {
  const parts = String(path ?? "").split("/").filter(Boolean).map((p) => p.replace(/_/g, " ").replace(/\[(\d+)\]/g, " $1"));
  return parts.length ? parts.join(", ") : "the whole record";
}

/** A value for display: text as is, other values as compact JSON, cut at 200 characters; null and undefined read "nothing". */
export function showValue(v) {
  if (v === undefined || v === null || v === "") return "nothing";
  let s;
  if (typeof v === "string") s = v;
  else { try { s = JSON.stringify(v); } catch { s = String(v); } }
  return s.length > 200 ? `${s.slice(0, 200)}…` : s;
}

/** The first path of a conflict that has both sides, as {label, website, desktop}; a conflict with several paths lists them all. */
export function conflictRows(conflict) {
  const paths = Array.isArray(conflict?.paths) ? conflict.paths : [];
  return paths.filter(isObj).map((p) => ({ label: pathWords(p.path), website: showValue(p.cloud), desktop: showValue(p.desktop) }));
}

/** The record a conflict is about, in words: the Gramps id when it has one, else the class. Never a name. */
export function recordLabel(conflict) {
  const cls = typeof conflict?.class === "string" && conflict.class ? conflict.class.toLowerCase() : "record";
  const id = typeof conflict?.gramps_id === "string" && conflict.gramps_id ? ` ${conflict.gramps_id}` : "";
  return `${cls}${id}`;
}

/** The decision body for a button: "keep_website" -> keep_cloud (the API's word), "keep_desktop" -> keep_desktop. */
export function decisionBody(choice) {
  if (choice === "keep_website") return { decision: "keep_cloud" };
  if (choice === "keep_desktop") return { decision: "keep_desktop" };
  throw new TypeError("decision must be keep_website or keep_desktop");
}

/** The confirm sentence before a decision. */
export const confirmAsk = (conflict, choice) =>
  `keep the ${choice === "keep_website" ? "website's" : "desktop's"} value for ${recordLabel(conflict)}?`;

/** The result line after a decision. */
export const decidedLine = (choice) => (choice === "keep_website" ? "kept the website's value. the desktop picks it up on its next run." : "kept the desktop's value. the desktop applies it on its next run.");

/** A normalised status read: every member exists and has its type, so the view never reads through a missing one. */
export function normalizeStatus(body) {
  const b = isObj(body) ? body : {};
  const w = isObj(b.website) ? b.website : {};
  return {
    owner: b.owner === true,
    desktop: (Array.isArray(b.desktop) ? b.desktop : []).filter(isObj).map((d) => ({
      id: String(d.id ?? ""), addon: d.addon_version ?? null, gramps: d.gramps_version ?? null, at: d.updated_at ?? null,
      run: isObj(d.last_run) ? { action: d.last_run.action ?? null, result: d.last_run.result ?? null, counts: isObj(d.last_run.counts) ? d.last_run.counts : {}, at: d.last_run.finished_at ?? null } : null,
    })),
    website: {
      headSeq: int(w.head_seq) ?? 0, renderedSeq: int(w.rendered_seq) ?? 0, lag: int(w.render_lag) ?? 0, mode: w.render_mode ?? null,
      error: typeof w.last_render_error === "string" && w.last_render_error ? w.last_render_error : null, errorAt: w.last_render_error_at ?? null,
      paused: w.writes_enabled === false, seeded: w.seeded === true, bound: w.bound === true,
    },
    conflicts: (Array.isArray(b.conflicts) ? b.conflicts : []).filter((c) => isObj(c) && typeof c.id === "string"),
    batches: (Array.isArray(b.batches) ? b.batches : []).filter(isObj).map((x) => ({ id: String(x.id ?? ""), at: x.at ?? null, by: x.by ?? null, origin: x.origin ?? null, ops: int(x.ops) ?? 0, from: int(x.seq_from), to: int(x.seq_to) })),
  };
}

/** The counts of a run as "pulled 3, pushed 1" (keys with spaces for underscores), or "no counts". */
export const countsLine = (counts) => {
  const e = Object.entries(isObj(counts) ? counts : {}).filter(([, v]) => Number.isInteger(v));
  return e.length ? e.map(([k, v]) => `${k.replace(/_/g, " ")} ${v}`).join(", ") : "no counts";
};

/** One line for the website card's lag: "up to date" or "3 changes not on the site yet". */
export const lagLine = (n) => (n > 0 ? `${n} ${n === 1 ? "change" : "changes"} not on the site yet` : "up to date");

/** The words for an API error: kind "signin" asks for a fresh sign-in (401), "plain" is a line. */
export function describeError(err) {
  const status = err?.status;
  const code = err?.code;
  if (status === 401 && code === "step_up_required") return { kind: "signin", fresh: true, text: "to decide this, sign in again first." };
  if (status === 401) return { kind: "signin", fresh: false, text: "your sign-in ran out. sign in again." };
  if (status === 403 && code === "not_owner") return { kind: "plain", text: COPY.ownerOnly };
  if (status === 403) return { kind: "plain", text: COPY.notAllowed };
  if (status === 404 && code === "not_enabled") return { kind: "plain", text: COPY.off };
  if (status === 404) return { kind: "reload", text: "that conflict isn't there anymore. reload the list." };
  if (status === 409) return { kind: "reload", text: "that conflict was already decided. reload the list." };
  if (status === 503) return { kind: "plain", text: "the store is busy. try again in a minute." };
  return { kind: "plain", text: COPY.loadFailed };
}
