// HFY-TSK-065: CorpusSource for the family index (local-only tier of @io-kit/search 1.0). No server search, no hybrid.
// Seeded from the same signed-session assets the Lunr search used: /person/index.json (manifest) + /person/search-index.json.
import { createLocalEngine } from "@io-kit/search";

const MANIFEST_URL = "/person/index.json";
const INDEX_URL = "/person/search-index.json";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

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
    const next = window.location.pathname + window.location.search;
    window.location.replace("/family-login/?next=" + encodeURIComponent(next));
    throw new Error("Sign in to search the family records.");
  }
  return {};
}

async function getJson(url, init) {
  const res = await fetch(url, init);
  window.HFYFeatureFlags?.dataResponse?.(res);
  if (!res.ok) throw new Error("Could not load " + url + " (" + res.status + ")");
  return res.json();
}

const year = (s) => { const m = /(\d{4})/g; const out = []; let x; while ((x = m.exec(s || ""))) out.push(Number(x[1])); return out; };

function splitName(displayName) {
  const name = String(displayName || "").trim();
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

export const peopleProperties = [
  { key: "surname", label: "Surname", type: "string" },
  { key: "given", label: "Given name", type: "string" },
  { key: "birth_year", label: "Birth year", type: "number" },
  { key: "death_year", label: "Death year", type: "number" },
  { key: "living", label: "Living", type: "bool" },
  { key: "has_photo", label: "Has photo", type: "bool" }
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
