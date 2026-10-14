// The /tree/ page's data seam (HFY-TSK-201; viz.md sections 7, 9.4 and 17). Pure apart from the injected fetcher, so tests/tree-data.test.mjs
// runs every state in node. The island passes HFYFeatureFlags.dataFetch, which already refreshes the session once on a gate 401 and then
// retries once (HFY-R66); a 401 that reaches loadGraph is therefore final.
import { GraphError, parseGraph } from "./family-graph.js";

export const GRAPH_URL = "/person/graph.json";

/**
 * Fetch and parse the graph. Resolves one of:
 *   {state: "ready", graph}     200 and a valid v1 body
 *   {state: "signin"}           401 after the refresh retry (GRAPH_UNAUTHENTICATED): sign in, with returnTo
 *   {state: "prepared"}         403 or 404 (GRAPH_NOT_PUBLISHED): "the family tree is being prepared"
 *   {state: "error", code}      a network failure, another status, a bad body (GRAPH_PARSE) or a bad version (GRAPH_SCHEMA_UNSUPPORTED)
 * Never rejects.
 */
export async function loadGraph(fetcher, { signal } = {}) {
  let res;
  try {
    res = await fetcher(GRAPH_URL, { credentials: "same-origin", headers: { Accept: "application/json" }, ...(signal ? { signal } : {}) });
  } catch {
    return { state: "error", code: "GRAPH_NETWORK" };
  }
  if (res.status === 401) return { state: "signin" };
  if (res.status === 403 || res.status === 404) return { state: "prepared" };
  if (!res.ok) return { state: "error", code: "GRAPH_HTTP" };
  try {
    return { state: "ready", graph: parseGraph(await res.text()) };
  } catch (e) {
    const code = e instanceof GraphError ? e.code : "GRAPH_PARSE";
    return { state: "error", code };
  }
}

/** The sign-in link for a visitor the gate refused: the edge sign-in, back to this very page afterwards. */
export const signInHref = (loc) => `/auth/login?returnTo=${encodeURIComponent(loc.pathname + loc.search)}`;

/**
 * Which person the page centres on (viz.md section 7 and 9.4): `?focus`, else the viewer's own id, else the default person.
 * {id, fellBack}: fellBack is true when a `?focus` was given but is not in the graph (the page then says so, politely). A viewer who is
 * not in the graph falls through to the default person without a notice, as there was nothing the visitor asked for.
 */
export function resolveFocus(graph, { focus = null, sub = null } = {}) {
  if (focus && graph.has(focus)) return { id: focus, fellBack: false };
  const fellBack = Boolean(focus);
  if (sub && graph.has(sub)) return { id: sub, fellBack };
  return { id: graph.defaultFocus(), fellBack };
}

/** The `?focus=` value of a location search string, or null. */
export const focusParam = (search) => new URLSearchParams(search).get("focus") || null;

/** The URL for centring on `id`, keeping any other parameter (`view`). */
export function focusUrl(loc, id) {
  const q = new URLSearchParams(loc.search);
  q.set("focus", id);
  return `${loc.pathname}?${q.toString()}${loc.hash || ""}`;
}

const yearsOf = (p) => {
  const b = p.birthYear == null ? null : `${p.yearApprox ? "about " : ""}${p.birthYear}`;
  const d = p.deathYear == null ? null : String(p.deathYear);
  if (b && d) return `${b} to ${d}`;
  if (b) return p.living ? `born ${b}` : `${b} to unknown`;
  if (d) return `died ${d}`;
  return "years unknown";
};
export const yearsLabel = yearsOf;

/** The polite live-region line for a new focus (viz.md section 12.1): "centred on Ada Example: 2 parents, 1 partner, 3 children". */
export function announce(graph, id) {
  const p = graph.person(id);
  if (!p) return "";
  const n = (count, one, many) => `${count} ${count === 1 ? one : many}`;
  const bits = [n(graph.parents(id).length, "parent", "parents"), n(graph.partners(id).length, "partner", "partners"), n(graph.children(id).length, "child", "children")];
  return `centred on ${p.name}: ${bits.join(", ")}`;
}
