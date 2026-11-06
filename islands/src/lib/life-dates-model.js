// Life dates on the person page (HFY-TSK-388-0D, flag lifeDatesV1; BRD 5.7, D-17..D-28, board B5): the copy, the plain-language line, the
// year validation and the request and reply helpers of the Born and Died block. Pure: no DOM, no CSS. The words "event", "life event",
// "role", "MediaRef" and "region" never appear in anything the member reads (P4-R2: lower-case copy). The routes are POST /api/life-dates
// (HFY-TSK-387-0F; only a year is ever sent, D-25, L-8) and GET /api/life-dates?target=Person:<handle> (ruling P4-R29), which says, per row, how
// exact the date on file is: none | year | about | precise, with the year only. The published person JSON carries no day or month (R-19), so the
// island never guesses precision from it; it reads the classes from the route and treats anything it cannot read as locked.
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
  sharedNote: "this date is shared with another person's page",
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

/**
 * The fallback the person JSON gives while the classes load, or when they cannot be read: only the year, shown as a plain line. It carries no
 * "about" and no precision, so nothing is ever editable from it. A living person's death is not shown.
 */
export function readLife(person) {
  const life = (person && person.lifespan) || {};
  const read = (m, isDeath) => {
    if (!m || typeof m !== "object") return null;
    const year = yr(m);
    if (!year && !isDeath) return null;
    return { year, about: false, locked: true, ...(isDeath ? { unknown: !year } : {}) };
  };
  const living = person && person.isLiving === true;
  return { birth: read(life.birth, false), death: living ? null : read(life.death, true) };
}

const CLASSES = new Set(["none", "year", "about", "precise"]);

/**
 * Reads a GET /api/life-dates reply: { birth: {cls, year, shared}, death: {cls, year, shared}, living } or null when the reply is not exactly
 * the shape the route sends (an unknown class counts as unreadable, so the block stays read-only).
 */
export function readClasses(reply) {
  if (!reply || typeof reply !== "object" || typeof reply.livingByRule !== "boolean") return null;
  const shared = reply.sharedEvent && typeof reply.sharedEvent === "object" ? reply.sharedEvent : {};
  const row = (m, isShared) => {
    if (!m || typeof m !== "object" || !CLASSES.has(m.class)) return null;
    return { cls: m.class, year: yr(m), shared: isShared === true };
  };
  const birth = row(reply.birth, shared.birth);
  const death = row(reply.death, shared.death);
  return birth && death ? { birth, death, living: reply.livingByRule } : null;
}

/**
 * What the editor works from: { birth: {year, about, locked, shared}|null, death: {..., unknown}|null }. none and year are editable, about is
 * editable with 'about' preselected; precise, or a date shared with another person's page, is locked (read-only with 'suggest a correction').
 * A death with no date that is not living by the rule reads 'died, year unknown'.
 */
export function rowsFrom(classes) {
  const row = (r, isDeath) => {
    const locked = r.cls === "precise" || r.shared;
    if (r.cls === "none" && !locked) return isDeath && !classes.living ? { year: null, about: false, locked: false, shared: false, unknown: true } : null;
    return { year: r.year, about: r.cls === "about", locked, shared: r.shared, ...(isDeath ? { unknown: false } : {}) };
  };
  return { birth: row(classes.birth, false), death: row(classes.death, true) };
}

const part = (verb, row) => `${verb} ${row.about ? "about " : ""}${row.year}`;

/** 'born about 1890 · died 1962', 'born 1925 · date of death unknown', 'birth year not recorded · no death recorded'. */
export function lineText({ birth, death }) {
  const b = birth && birth.year ? part(COPY.born, birth) : birth && birth.locked ? COPY.born : "birth year not recorded";
  let d;
  if (death && death.unknown) d = COPY.unknown;
  else if (death && death.year) d = part(COPY.died, death);
  else if (death && death.locked) d = COPY.died;
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
 * Validates a draft against what is shown. Returns { errors: {birth?, death?}, years, needsSure }. A locked row (a more exact date, or a shared one) is
 * read-only and never judged. `years` is the span in force when both years are known; `needsSure` when it is over 120 (D-25).
 */
export function validate(draft, current, now = new Date()) {
  const errors = {};
  const b = current.birth && current.birth.locked ? { ok: true, year: current.birth.year } : checkYear(draft.birth.year, now);
  const dRow = current.death && current.death.locked;
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

/** The body for POST /api/life-dates, or null when no row changed. Locked rows (a more exact or shared date on file) are never sent. */
export function buildBody(handle, draft, current, { confirm = false } = {}) {
  const body = { target: `Person:${handle}` };
  const by = checkYear(draft.birth.year, new Date(9999, 0, 1)).year;
  const cb = current.birth;
  if (by && !(cb && cb.locked) && (!cb || cb.year !== by || Boolean(cb.about) !== draft.birth.about)) body.birth = { year: by, ...(draft.birth.about ? { about: true } : {}) };
  const cd = current.death;
  if (!(cd && cd.locked)) {
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
    birth: pending.birth ? { year: pending.birth.year, about: pending.birth.about === true, locked: false } : current.birth,
    death: pending.death ? { year: pending.death.year || null, about: pending.death.about === true, locked: false, unknown: pending.death.unknown === true } : current.death
  };
}
