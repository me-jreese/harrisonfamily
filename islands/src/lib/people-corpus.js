// HFY-TSK-065: CorpusSource for the family index (local-only tier of @io-kit/search 1.0). No server search, no hybrid.
// Seeded from the same signed-session assets the Lunr search used: /person/index.json (manifest) + /person/search-index.json.
import { createLocalEngine } from "@io-kit/search";
import { cleanText } from "../../../shared/validate.mjs"; // repo-root shared/ (pure ESM, also staged into the api and auth zips)

const MANIFEST_URL = "/person/index.json";
const INDEX_URL = "/person/search-index.json";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// DS Voice: errors say what happened and who to text. The search island shows the corpus error in its banner as-is, so the message
// is the family-facing line; the technical detail rides on `cause` for the console.
export const SEARCH_COPY = {
  failed: "that didn't work. try again, or text J.",
  signedOut: "this page is family-only. sign in to see it.",
};
const fail = (message, cause) => Object.assign(new Error(message), { cause });

/** Same credentials path as search-results.js: X-HFY-Session header + credentials:include once the session token exists. */
async function authInit() {
  const flags = window.HFYFeatureFlags;
  const edge = flags && flags.dataFetchInit ? await flags.dataFetchInit() : null;
  if (edge) return edge; // authV2: the io_id cookie is the credential at the edge data gate (HFY-TSK-080)
  const enforce = Boolean(flags && flags.config && flags.config.gateway && flags.config.gateway.enforceAssets);
  let token = null;
  const end = Date.now() + 8000;
  while (flags && flags.requireSessionToken && !(token = flags.requireSessionToken()) && Date.now() < end) await sleep(100);
  if (token) return { headers: { "X-HFY-Session": token }, credentials: "include" };
  if (enforce) {
    // path + query + hash, like the legacy pages: under authV2 /family-login/ hands `next` to /auth/login as returnTo (HFY-TSK-069).
    const next = window.location.pathname + window.location.search + window.location.hash;
    window.location.replace("/family-login/?next=" + encodeURIComponent(next));
    throw fail(SEARCH_COPY.signedOut, new Error("no session token after 8 s; sent to /family-login/"));
  }
  return {};
}

/** HFY-R66: authV2 refreshes a lapsed edge session and retries a gate 401 once before sending the visitor to sign in. */
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
      birth_year: years.length ? years[0] : null,
      death_year: !living && years.length > 1 ? years[years.length - 1] : null,
      living,
      has_photo: Boolean(raw.primaryPhoto),
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
  { key: "has_photo", label: "has a photo", type: "bool" }
];

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
