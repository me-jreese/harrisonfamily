// lifeStateV1 on the graph (HFY-TSK-427, display only). Callers of tree-data's loadGraph and cachedGraph pass `markLifeState` as their `mark`, so the
// <family-navigator> bundle, which reaches tree-data.js for yearsLabel, never pulls in the rule or the evidence read.
import { isStatusUnknown } from "./life-state-copy.js";
import { loadLifeState } from "./life-state-client.js";

/**
 * Sets `lifeUnknown: true` on each person whose state is "status unknown" (the published `living` flag says no death, and the shared rule finds no
 * evidence and an age past the threshold or no birth year). `living`, the places and every other field stay exactly as published. With the flag off
 * `lifeState()` answers `{enabled: false}` and nothing is set. A failed read is "no evidence", the rule's fail-closed answer. Never rejects.
 */
export async function markLifeState(graph, lifeState = loadLifeState) {
  let ls = null;
  try { ls = await lifeState(); } catch { ls = null; }
  if (!ls || ls.enabled !== true) return graph;
  for (const p of graph.people()) {
    if (isStatusUnknown(ls, { id: p.id, living: p.living === true, birthYear: p.birthYear, deathYear: p.deathYear })) p.lifeUnknown = true;
  }
  return graph;
}
