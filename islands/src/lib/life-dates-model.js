// Life dates on the person page (HFY-TSK-388-0D, flag lifeDatesV1; BRD 5.7, D-17..D-28, board B5): the copy, the plain-language line, the
// year validation and the request and reply helpers of the Born and Died block. Pure: no DOM, no CSS. The words "event", "life event",
// "role", "MediaRef" and "region" never appear in anything the member reads (P4-R2: lower-case copy). The route is POST /api/life-dates
// (HFY-TSK-387-0F); only a year is ever sent (D-25, L-8).
export const MIN_YEAR = 1600;
export const MAX_LIFESPAN = 120;

export const COPY = Object.freeze({
  label: "life dates",
  edit: "edit years",
  add: "add years",
  born: "born",
  died: "died",
  yearBorn: "year of birth",
  yearDied: "year of death",
  aboutBorn: "about, for year of birth",
  aboutDied: "about, for year of death",
  about: "about",
  unknown: "died, year unknown",
  save: "save",
  saving: "saving",
  cancel: "cancel",
  pending: "pending review",
  pendingNote: "thank you. a family admin will look at this before it shows for everyone.",
  preciseNote: "a more exact date is on file",
  suggest: "suggest a correction",
  sureYes: "yes, save",
  sureNo: "no, go back",
  noChange: "no changes to save.",
  unchanged: "that year is already on file.",
  shared: "that date is shared with another person's page, so it can't be changed here.",
  precise: "a more exact date is on file, so the year was left alone. use suggest a correction.",
  signIn: "sign in to suggest years.",
  network: "couldn't reach the site. check your connection and try again.",
  conflict: "this page changed while you were editing. reload it and try again.",
  limit: "that's a lot of suggestions at once. try again a little later.",
  failed: "couldn't save that. try again.",
  digits: "use 4 digits, like 1890.",
  diedBeforeBorn: "died can't be before born."
});

export const rangeError = (now = new Date()) => `enter a year from ${MIN_YEAR} to ${now.getFullYear()}.`;
export const sureText = (years) => `that's ${years} years between born and died. are you sure?`;

const yr = (m) => (m && Number.isInteger(Number(m.year)) && Number(m.year) > 0 ? Number(m.year) : null);
const isAbout = (m) => Boolean(m) && (m.about === true || m.quality === "estimated" || m.modifier === "about");
const isPrecise = (m) => Boolean(m) && (Boolean(m.month) || Boolean(m.day) || m.precise === true);

/** What the person JSON shows: { birth: {year, about, precise}|null, death: {year, about, precise, unknown}|null }. A living person's death is not shown. */
export function readLife(person) {
  const life = (person && person.lifespan) || {};
  const read = (m, isDeath) => {
    if (!m || typeof m !== "object") return null;
    const year = yr(m);
    if (!year && !isDeath) return null;
    return { year, about: isAbout(m), precise: isPrecise(m), ...(isDeath ? { unknown: !year } : {}) };
  };
  const living = person && person.isLiving === true;
  return { birth: read(life.birth, false), death: living ? null : read(life.death, true) };
}

const part = (verb, row) => `${verb} ${row.about ? "about " : ""}${row.year}`;

/** 'born about 1890 · died 1962', 'born 1925 · date of death unknown', 'birth year not recorded · no death recorded'. */
export function lineText({ birth, death }) {
  const b = birth && birth.year ? part(COPY.born, birth) : "birth year not recorded";
  let d;
  if (death && death.unknown) d = COPY.unknown;
  else if (death && death.year) d = part(COPY.died, death);
  else d = birth && birth.year ? "date of death unknown" : "no death recorded";
  return `${b} · ${d}`;
}

/** The editor's starting draft from what is shown. */
export function draftFrom({ birth, death }) {
  return {
    birth: { year: birth && birth.year ? String(birth.year) : "", about: Boolean(birth && birth.about) },
    death: { year: death && death.year ? String(death.year) : "", about: Boolean(death && death.about), unknown: Boolean(death && death.unknown) }
  };
}

function checkYear(text, now) {
  const t = String(text).trim();
  if (!t) return { ok: true, year: null };
  if (!/^\d{4}$/.test(t)) return { error: /^\d+$/.test(t) && t.length > 4 ? rangeError(now) : COPY.digits };
  const n = Number(t);
  if (n < MIN_YEAR || n > now.getFullYear()) return { error: rangeError(now) };
  return { ok: true, year: n };
}

/**
 * Validates a draft against what is shown. Returns { errors: {birth?, death?}, years, needsSure }. A row on file with a more exact date is
 * read-only and never judged. `years` is the span in force when both years are known; `needsSure` when it is over 120 (D-25).
 */
export function validate(draft, current, now = new Date()) {
  const errors = {};
  const b = current.birth && current.birth.precise ? { ok: true, year: current.birth.year } : checkYear(draft.birth.year, now);
  const dRow = current.death && current.death.precise;
  const d = draft.death.unknown ? { ok: true, year: null } : dRow ? { ok: true, year: current.death.year } : checkYear(draft.death.year, now);
  if (b.error) errors.birth = b.error;
  if (d.error) errors.death = d.error;
  const born = b.ok ? b.year || (current.birth && current.birth.year) || null : null;
  const died = d.ok ? d.year || (draft.death.unknown ? null : current.death && current.death.year) || null : null;
  let years = null;
  if (born && died) {
    if (died < born) errors.death = COPY.diedBeforeBorn;
    else years = died - born;
  }
  return { errors, years, needsSure: years !== null && years > MAX_LIFESPAN };
}

/** The body for POST /api/life-dates, or null when no row changed. Rows with a more exact date on file are never sent. */
export function buildBody(handle, draft, current, { confirm = false } = {}) {
  const body = { target: `Person:${handle}` };
  const by = checkYear(draft.birth.year, new Date(9999, 0, 1)).year;
  const cb = current.birth;
  if (by && !(cb && cb.precise) && (!cb || cb.year !== by || Boolean(cb.about) !== draft.birth.about)) body.birth = { year: by, ...(draft.birth.about ? { about: true } : {}) };
  const cd = current.death;
  if (!(cd && cd.precise)) {
    if (draft.death.unknown) {
      if (!(cd && cd.unknown)) body.death = { unknown: true };
    } else {
      const dy = checkYear(draft.death.year, new Date(9999, 0, 1)).year;
      if (dy && (!cd || cd.year !== dy || Boolean(cd.about) !== draft.death.about)) body.death = { year: dy, ...(draft.death.about ? { about: true } : {}) };
    }
  }
  if (!body.birth && !body.death) return null;
  if (confirm) body.confirm = true;
  return body;
}

/**
 * Reads a 200/201 reply. { confirm: true, years } when the server wants the "are you sure?" step; otherwise { saved: {birth?, death?},
 * notes: [plain sentences] } where `saved` holds the rows that became a suggestion.
 */
export function readReply(res, body) {
  if (res && res.confirm_needed) return { confirm: true, years: Number(res.lifespan) || null };
  const rows = (res && res.rows) || {};
  const saved = {};
  const notes = [];
  for (const name of ["birth", "death"]) {
    const row = rows[name];
    if (!row || !body[name]) continue;
    if (row.status === "proposed") saved[name] = body[name].unknown ? { unknown: true, year: null } : { year: body[name].year, about: body[name].about === true };
    else if (row.status === "precise_on_file") notes.push(COPY.precise);
    else if (row.status === "shared_event") notes.push(COPY.shared);
    else if (row.status === "unchanged") notes.push(COPY.unchanged);
  }
  if (!Object.keys(saved).length && !notes.length) notes.push(COPY.noChange);
  return { saved, notes: [...new Set(notes)] };
}

/** Plain copy for a failed request. */
export function errorText(err) {
  const s = err && err.status;
  const code = err && err.code;
  if (s === 0) return COPY.network;
  if (s === 401) return COPY.signIn;
  if (s === 409) return COPY.conflict;
  if (s === 429) return COPY.limit;
  if (s === 400 && code === "year_range") return rangeError();
  if (s === 400 && code === "death_before_birth") return COPY.diedBeforeBorn;
  return COPY.failed;
}

/** The line a sender sees after saving: what is shown, with their proposed rows laid over it. */
export function withPending(current, pending) {
  if (!pending) return current;
  return {
    birth: pending.birth ? { year: pending.birth.year, about: pending.birth.about === true, precise: false } : current.birth,
    death: pending.death ? { year: pending.death.year || null, about: pending.death.about === true, precise: false, unknown: pending.death.unknown === true } : current.death
  };
}
