// The /join/ page's pure side (HFY-TSK-140, flag accessRequests; HFY-PLN-002 surfaces 7.10): the words, the field list, the client-side
// check (the Legacy Form validator the edge runs, shared/legacy-form.mjs, bundled here so a field error reads the same before and after
// the request), the sessionStorage draft and the three edge calls. No DOM and no CSS in this file, so a node test can pin all of it.
//
// Privacy rules this file keeps (surfaces 7.10, 7.2):
//   - the draft holds the form's answers only: never the code, the ticket, the email or the consent tick (draftOf allow-lists the keys);
//   - the email travels only in a POST body, never in a URL or a query string (the calls below take no URL parameters).
import { FIELDS, validateForm } from "../../../shared/legacy-form.mjs";

/**
 * Q2-11(a) has no recorded io answer, and the edge is built with STORE_CURRENT_CITY = false (auth/src/access-request.js): it neither
 * requires nor keeps the current city. The form therefore does not ask for it (or the year the person moved there). When the answer is
 * yes, flip this and the edge constant together.
 */
export const STORE_CURRENT_CITY = false;

export const DRAFT_KEY = "hfy:join-draft";
export const RESEND_AFTER_SECONDS = 60;
export const CODE_LENGTH = 6;
export const JOIN_PATH = "/join/";
export const EDGE = "/auth/access-request";

export const COPY = Object.freeze({
  title: "ask to join the family site",
  closed: "asking to join isn't open yet. if you're family, ask the person who told you about the site to reach out.",
  closedNow: "asking to join is closed for now.",
  lede: "this site is just for family. tell us who you are and we'll add you. it takes about 5 minutes.",
  privacy: "we only use your email so you can sign in. we never show it to anyone.",
  firstCode: "first, we'll email you a 6-digit code.",
  loading: "loading",
  step1: "your email",
  emailLabel: "your email",
  emailHint: "a gmail address lets you sign in with google",
  sendCode: "email me a code",
  sending: "sending…",
  step2: "check your email",
  codeLabel: "6-digit code",
  checkIt: "check it",
  checking: "checking…",
  noCode: "didn't get it? check spam, or",
  sendAnother: "send another",
  sentAnother: "we sent another code.",
  differentEmail: "use a different email",
  step3: "tell us about you",
  aboutYou: "about you",
  timeline: "your timeline",
  send: "send my request",
  sendingRequest: "sending…",
  doneTitle: "got it.",
  done: "we'll look at it and email you, usually within a few days.",
  doneAbout: "while you wait, the family's story is on the about page.",
  doneAboutLink: "the about page",
  alreadyRequested: "we already have your request. we'll email you when we've looked at it.",
  alreadyMember: "good news, you're already on the list.",
  signIn: "sign in",
  expired: "that took a while, so we need to check your email again. your answers are saved.",
  summary: "fix these, then send again:",
  summaryEmail: "fix this, then try again:",
  checkFailed: "we couldn't check that you're a person. try again in a minute.",
  checkWait: "give the check a moment to finish, then try again.",
  retry: "try again",
  tooManyCodes: "that's a lot of codes. wait an hour, then try again.",
  badCode: "that code didn't work. check your email for the newest one.",
  codeExpired: "that code ran out. send another one.",
  tooManyTries: "that's a lot of tries. send another code.",
  busy: "we're getting a lot of requests right now. try again tomorrow.",
  unavailable: "that didn't work. try again in a minute.",
  badEmail: "that email doesn't look right. check it, then try again.",
  codeShape: "the code is the 6 digits from the email.",
  stepOf: (n) => `step ${n} of 3`,
  sentTo: (email) => `we sent a 6-digit code to ${email}. it works for 15 minutes.`,
  waitResend: (s) => `you can ask for another in ${s} seconds.`
});

/** The three steps, in order. */
export const STEPS = Object.freeze({ email: 1, code: 2, form: 3 });

// ------------------------------------------------------------------ the form

const OPTIONAL = "optional";

/**
 * What the island shows for each field of shared/legacy-form.mjs FIELDS (the order, kinds and bounds come from there). `short` is the
 * name in the error summary ("the year you were born: just the year, like 1962."). Radios carry `options` as [value, label].
 */
export const FIELD_UI = Object.freeze({
  givenNames: { label: "your given names", hint: "first and middle, like on your birth certificate", short: "your given names" },
  maidenSurname: { label: "your last name at birth", hint: "", short: "your last name at birth" },
  gender: { label: "gender", hint: "", short: "gender", options: [["male", "male"], ["female", "female"]] },
  nickname: { label: "what does the family call you?", hint: OPTIONAL, short: "what the family calls you" },
  birthPlace: { label: "where were you born?", hint: "city and state", short: "where you were born" },
  birthYear: { label: "what year were you born?", hint: "just the year. we never ask for your full birthday.", short: "the year you were born", numeric: true },
  currentPlace: { label: "where do you live now?", hint: "city and state is plenty", short: "where you live now" },
  movedYear: { label: "what year did you move to your region?", hint: "moving a few counties over doesn't count. optional.", short: "the year you moved", numeric: true },
  everMarried: {
    label: "were you ever married?", hint: OPTIONAL, short: "were you ever married",
    options: [
      ["married_once_still", "married once, and still married"],
      ["married_once_widowed", "married once, and widowed"],
      ["married_once_divorced", "married once, and divorced"],
      ["married_more_than_once", "married more than once"],
      ["never_married", "never married"]
    ]
  },
  university: { label: "if you graduated from a university, which one?", hint: OPTIONAL, short: "your university" },
  graduationYear: { label: "what year did you graduate?", hint: OPTIONAL, short: "the year you graduated", numeric: true },
  otherDegrees: { label: "any other degrees?", hint: OPTIONAL, short: "your other degrees" },
  otherInstitutions: { label: "from which school(s)?", hint: OPTIONAL, short: "your schools" },
  otherDegreeYears: { label: "in what year(s)?", hint: "separate the years with commas. optional.", short: "the years of your other degrees" },
  forSelf: { label: "this is about me, not someone else", hint: "", short: "the box about you" }
});

/** The fields the island asks for in step 3, in order, by section (1 = about you, 2 = your timeline). The email is step 1's. */
export function formFields(section) {
  return FIELDS.filter((f) => f.key !== "email" && f.section === section && f.key !== "forSelf" && (STORE_CURRENT_CITY || (f.key !== "currentPlace" && f.key !== "movedYear")));
}

/** Every key the draft may hold: the answers, not the consent tick and not the email. */
export const DRAFT_KEYS = Object.freeze(FIELDS.filter((f) => f.key !== "email" && f.key !== "forSelf").map((f) => f.key));

export const blankForm = () => ({ ...Object.fromEntries(DRAFT_KEYS.map((k) => [k, ""])), forSelf: false });

/** The error line for a validator code on a field (DS voice: lowercase, no exclamation mark). */
export function errorLine(field, code) {
  const ui = FIELD_UI[field];
  switch (code) {
    case "required":
      if (field === "forSelf") return "tick this box to send your request.";
      return ui && ui.options ? "pick one." : "we need this one.";
    case "must_be_true": return "tick this box to send your request.";
    case "invalid":
      if (ui && ui.options) return "pick one.";
      if (field === "givenNames" || field === "maidenSurname") return "use letters only, like on your birth certificate.";
      if (field === "email") return COPY.badEmail;
      return "that doesn't look right. check it.";
    case "too_long": return "that's a bit long. shorten it.";
    case "year_format": return "just the year, like 1962.";
    case "year_range": return "that year doesn't look right. check it.";
    case "digits_not_allowed":
    case "street_not_allowed": return "just the city and state is plenty.";
    case "contact_info": return "that looks like a phone number. take it out, then send.";
    case "dob_not_allowed": return "we only keep the birth year. take the date out, then send.";
    case "too_many": return "five years at most.";
    case "not_empty": return "leave that one empty.";
    default: return "that doesn't look right. check it.";
  }
}

/** The answers as the edge takes them: trimmed, blanks left out, the consent tick as true. The email is added by the caller. */
export function formBody(values) {
  const out = {};
  for (const k of DRAFT_KEYS) {
    if (!STORE_CURRENT_CITY && (k === "currentPlace" || k === "movedYear")) continue;
    const v = typeof values[k] === "string" ? values[k].trim() : "";
    if (v) out[k] = v;
  }
  if (values.forSelf === true) out.forSelf = true;
  return out;
}

/** The client-side check with the edge's validator. [{field, code}] in form order; [] when the form is good. */
export function checkForm(values, email, opts = {}) {
  const r = validateForm({ ...formBody(values), email }, { storeCurrentCity: STORE_CURRENT_CITY, ...opts });
  return r.ok ? [] : r.fields.filter((f) => f.field !== "email");
}

/** The edge's `fields` array to {field: line}, dropping keys the island has no field for (its `email` goes to step 1). */
export function fieldLines(fields) {
  const out = {};
  for (const f of Array.isArray(fields) ? fields : []) {
    if (!f || typeof f.field !== "string" || typeof f.code !== "string") continue;
    if (f.field === "email") continue;
    if (!Object.hasOwn(FIELD_UI, f.field)) continue;
    out[f.field] ??= errorLine(f.field, f.code);
  }
  return out;
}

/** The summary list [{field, text}] in form order. */
export function summaryItems(lines) {
  const order = new Map(FIELDS.map((f, i) => [f.key, i]));
  return Object.keys(lines).sort((a, b) => (order.get(a) ?? 99) - (order.get(b) ?? 99)).map((field) => ({ field, text: `${FIELD_UI[field].short}: ${lines[field]}` }));
}

// ------------------------------------------------------------------ the draft (sessionStorage; every access in try/catch)

const store = () => {
  try { return typeof window !== "undefined" ? window.sessionStorage : null; } catch { return null; }
};

/** Only the allow-listed answer keys, as strings. Anything else (a code, a ticket, an email) is dropped. */
export function draftOf(values) {
  const out = {};
  const v = values && typeof values === "object" ? values : {};
  for (const k of DRAFT_KEYS) if (typeof v[k] === "string" && v[k] !== "") out[k] = v[k];
  return out;
}

export function loadDraft(storage = store()) {
  try {
    const raw = storage && storage.getItem(DRAFT_KEY);
    if (!raw) return blankForm();
    const parsed = JSON.parse(raw);
    return { ...blankForm(), ...draftOf(parsed) };
  } catch { return blankForm(); }
}

export function saveDraft(values, storage = store()) {
  try {
    if (!storage) return;
    const d = draftOf(values);
    if (Object.keys(d).length === 0) storage.removeItem(DRAFT_KEY);
    else storage.setItem(DRAFT_KEY, JSON.stringify(d));
  } catch { /* storage blocked or full: the form still works */ }
}

export function clearDraft(storage = store()) {
  try { if (storage) storage.removeItem(DRAFT_KEY); } catch { /* nothing to clear */ }
}

// ------------------------------------------------------------------ the three edge calls

const HEADERS = Object.freeze({ "content-type": "application/json", "x-requested-with": "io-kit", accept: "application/json" });

/**
 * { status, body, retryAfter }. A network failure is { status: 0 }. The body is the parsed JSON ({} when there is none). The email
 * is only ever in `payload`, which goes in the POST body: no call here builds a URL from it.
 */
async function call(fetchImpl, method, path, payload) {
  try {
    const res = await fetchImpl(`${EDGE}${path}`, {
      method,
      credentials: "same-origin",
      headers: method === "GET" ? { "x-requested-with": "io-kit", accept: "application/json" } : HEADERS,
      ...(payload === undefined ? {} : { body: JSON.stringify(payload) })
    });
    let body = {};
    try { body = (await res.json()) || {}; } catch { body = {}; }
    return { status: res.status, body, retryAfter: Number(res.headers && res.headers.get && res.headers.get("retry-after")) || 0 };
  } catch {
    return { status: 0, body: {}, retryAfter: 0 };
  }
}

export function createJoinApi(fetchImpl = (...a) => fetch(...a)) {
  return {
    config: () => call(fetchImpl, "GET", "/config"),
    start: ({ email, turnstileToken, company = "" }) => call(fetchImpl, "POST", "/start", { email, turnstileToken, company }),
    verify: ({ email, code }) => call(fetchImpl, "POST", "/verify", { email, code }),
    submit: ({ ticket, form, turnstileToken, company = "" }) => call(fetchImpl, "POST", "", { ticket, form, turnstileToken, company })
  };
}

// ------------------------------------------------------------------ what each answer means

/** The config answer: "open" (with the site key), "closed", or "unavailable". */
export function readConfig(res) {
  if (res.status === 200 && res.body && res.body.open === true && typeof res.body.turnstileSiteKey === "string" && res.body.turnstileSiteKey) return { state: "open", siteKey: res.body.turnstileSiteKey };
  if (res.status === 200 && res.body && res.body.open === false) return { state: "closed" };
  if (res.status === 503 && res.body && res.body.detail === "closed") return { state: "closed" };
  return { state: "unavailable" };
}

const generic = (res) => {
  if (res.status === 503 && res.body.detail === "closed") return { kind: "closed", text: COPY.closedNow };
  if (res.status === 503 && res.body.detail === "queue_full") return { kind: "busy", text: COPY.busy };
  if (res.status === 403 && res.body.detail === "bot_check_failed") return { kind: "bot", text: COPY.checkFailed };
  if (res.status === 429) return { kind: "limited", text: COPY.busy };
  return { kind: "unavailable", text: COPY.unavailable };
};

/** Step 1's answer to POST /start: { ok } or { kind, text, field? }. `field: "email"` puts the line under the input. */
export function startOutcome(res) {
  if (res.status === 202) return { ok: true };
  if (res.status === 400 && res.body.detail === "invalid_email") return { kind: "field", field: "email", text: COPY.badEmail };
  if (res.status === 429) return { kind: "limited", text: COPY.tooManyCodes };
  return generic(res);
}

/** Step 2's answer to POST /verify: { ok, ticket } or { kind, text, field? }. */
export function verifyOutcome(res) {
  if (res.status === 200 && typeof res.body.ticket === "string" && res.body.ticket) return { ok: true, ticket: res.body.ticket };
  if (res.status === 400 && res.body.detail === "invalid_code") return { kind: "field", field: "code", text: COPY.badCode };
  if (res.status === 410) return { kind: "field", field: "code", text: COPY.codeExpired, resend: true };
  if (res.status === 429) return { kind: "field", field: "code", text: COPY.tooManyTries, resend: true };
  return generic(res);
}

/**
 * Step 3's answer to POST /access-request: { ok }, { settled: "requested" | "member" }, { kind: "ticket" } (back to step 1),
 * { kind: "fields", lines } (the edge's per-field errors), or { kind, text }.
 */
export function submitOutcome(res) {
  if (res.status === 201) return { ok: true };
  if (res.status === 409 && res.body.detail === "already_requested") return { settled: "requested" };
  if (res.status === 409 && res.body.detail === "already_member") return { settled: "member" };
  if ((res.status === 401 || res.status === 403) && res.body.detail === "ticket_expired") return { kind: "ticket" };
  if (res.status === 400 && res.body.detail === "validation") return { kind: "fields", lines: fieldLines(res.body.fields) };
  if (res.status === 429) return { kind: "limited", text: COPY.busy };
  return generic(res);
}

/** Every string the island can show, for the copy test (functions are called with sample values). */
export function allCopy() {
  const out = [];
  for (const v of Object.values(COPY)) out.push(typeof v === "function" ? v(2) : v);
  out.push(COPY.sentTo("a@example.test"), COPY.waitResend(42));
  for (const ui of Object.values(FIELD_UI)) {
    out.push(ui.label, ui.hint, ui.short);
    for (const o of ui.options || []) out.push(o[1]);
  }
  for (const f of FIELDS) for (const code of ["required", "invalid", "too_long", "year_format", "year_range", "digits_not_allowed", "street_not_allowed", "contact_info", "dob_not_allowed", "too_many", "not_empty", "must_be_true", "something_new"]) out.push(errorLine(f.key, code));
  return out.filter((s) => typeof s === "string" && s !== "");
}
