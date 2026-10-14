// HFY-TSK-065: CorpusSource for the family index (local-only tier of @io-kit/search 1.0). No server search, no hybrid.
// Seeded from the signed-session assets /person/index.json (manifest) + /person/search-index.json. The old Lunr page is gone (HFY-TSK-317).
import { createLocalEngine } from "@io-kit/search";
import { cleanText } from "../../../shared/validate.mjs"; // repo-root shared/ (pure ESM, also staged into the api and auth zips)

const MANIFEST_URL = "/person/index.json";
const INDEX_URL = "/person/search-index.json";

// DS Voice: errors say what happened and who to text. The search island shows the corpus error in its banner as-is, so the message
// is the family-facing line; the technical detail rides on `cause` for the console.
export const SEARCH_COPY = {
  failed: "that didn't work. try again, or text J.",
  signedOut: "this page is family-only. sign in to see it.",
};
const fail = (message, cause) => Object.assign(new Error(message), { cause });

/** The io_id cookie is the credential at the edge data gate (HFY-TSK-080); a gate 401 is refreshed and retried by getJson. */
const authInit = async () => ({ credentials: "same-origin" });

/** HFY-R66: a lapsed edge session is refreshed and a gate 401 retried once before the visitor is sent to sign in. */
async function getJson(url, init) {
  const flags = window.HFYFeatureFlags;
  let res;
  try {
    res = await (flags && flags.dataFetch ? flags.dataFetch(url, init) : fetch(url, init));
  } catch (e) {
    if (e && e.name === "AbortError") throw e;
    throw fail(SEARCH_COPY.failed, e);
  }
  const why = new Error("Could not load " + url + " (" + res.status + ")");
  if (res.status === 401 || res.status === 403) throw fail(SEARCH_COPY.signedOut, why);
  if (!res.ok) throw fail(SEARCH_COPY.failed, why);
  try { return await res.json(); } catch (e) { throw fail(SEARCH_COPY.failed, e); }
}

const year = (s) => { const m = /(\d{4})/g; const out = []; let x; while ((x = m.exec(s || ""))) out.push(Number(x[1])); return out; };

// A summary that starts with "d." or a dash is death-only ("d. 1980", "– 1980"): its first year is the death year, not a birth year.
const deathOnly = (s) => /^\s*(d\.|died\b|[-\u2013\u2014])/i.test(s || "");
const birthYearOf = (s) => (deathOnly(s) ? null : (year(s)[0] ?? null));

function splitName(displayName) {
  const name = cleanText(displayName);
  if (name.includes(",")) { const [surname, given] = name.split(",").map((p) => p.trim()); return { surname, given: given || "" }; }
  const parts = name.split(/\s+/);
  return { surname: parts.length > 1 ? parts[parts.length - 1] : name, given: parts.slice(0, -1).join(" ") };
}

export function mapPerson(raw) {
  if (!raw || !raw.grampsId) return null;
  const { surname, given } = splitName(raw.displayName);
  const years = year(raw.lifespanSummary);
  const living = Boolean(raw.isLiving);
  return {
    id: raw.grampsId,
    type: "person",
    title: raw.displayName || raw.grampsId,
    text: raw.searchText || "",
    fields: {
      surname, given,
      birth_year: birthYearOf(raw.lifespanSummary),
      death_year: !living && years.length > 1 ? years[years.length - 1] : null,
      living,
      has_photo: Boolean(raw.primaryPhoto),
      has_birth_year: typeof raw.birthYear === "number" || birthYearOf(raw.lifespanSummary) !== null,
      lifespan: raw.lifespanSummary || "",
      photo: raw.primaryPhoto || ""
    }
  };
}

export const peopleSource = {
  id: "hfy-people",
  seqSpaces: [],
  async *seed({ signal } = {}) {
    const init = { ...(await authInit()), signal };
    const [manifest, index] = await Promise.all([getJson(MANIFEST_URL, init), getJson(INDEX_URL, init)]);
    const people = Array.isArray(manifest && manifest.people) ? manifest.people : Array.isArray(manifest) ? manifest : [];
    const text = new Map((Array.isArray(index && index.documents) ? index.documents : []).map((d) => [d.grampsId || d.id, d.searchText || ""]));
    yield { rows: people.map((p) => ({ ...p, searchText: text.get(p.grampsId) || "" })) };
  },
  // Local-only: the corpus is a static snapshot, nothing to heal.
  async since(cursors) { return { upserts: [], deletes: [], cursors: cursors || {} }; },
  mapRow: mapPerson
};

// Filter labels in the house style (lowercase; the filter pills and the filter sheet show them).
export const peopleProperties = [
  { key: "surname", label: "last name", type: "string" },
  { key: "given", label: "first name", type: "string" },
  { key: "birth_year", label: "born", type: "number" },
  { key: "death_year", label: "died", type: "number" },
  { key: "living", label: "living", type: "bool" },
  { key: "has_photo", label: "has a photo", type: "bool" },
  { key: "has_birth_year", label: "has a birth year", type: "bool" }
];

/**
 * The search URL contract (HFY-TSK-136): `has_photo`, `has_birth_year` and `living` accept true|false and seed one filter token each,
 * which the filter pills show and the visitor can remove. Any other value, and any other param, is ignored.
 */
export const FILTER_PARAMS = ["has_photo", "has_birth_year", "living"];
export function filterTokensFromParams(params) {
  const tokens = [];
  for (const key of FILTER_PARAMS) {
    const v = (params.get(key) || "").trim().toLowerCase();
    if (v === "true" || v === "false") tokens.push({ propertyKey: key, operator: "=", value: v });
  }
  return tokens;
}

let enginePromise = null;
function engine() {
  if (!enginePromise) {
    enginePromise = (async () => {
      const rows = [];
      for await (const page of peopleSource.seed({})) for (const raw of page.rows) { const r = mapPerson(raw); if (r) rows.push(r); }
      return createLocalEngine(rows, peopleProperties);
    })().catch((e) => { enginePromise = null; throw e; });
  }
  return enginePromise;
}

/** SearchLauncher `suggest`: instant local suggestions linking straight to /person/?id=. */
export async function suggestPeople(text) {
  const eng = await engine();
  return eng.suggest(text, 6).map((r) => ({ id: r.id, title: r.title, subtitle: r.fields.lifespan || undefined, href: "/person/?id=" + encodeURIComponent(r.id) }));
}
