// hfy-graph-render (HFY-TSK-274): the Lambda entry point (handler src/index.handler; the package's src/index.mjs re-exports this).
//
// Invoked asynchronously by hfy-sync-render after each successful live pass ({"source": "render", "seq": N}); an operator may invoke it
// with {"force": true} to rebuild at once, or {"smoke": true} to crop a synthetic face (no AWS call, no family data).
// Reserved concurrency 1 serialises passes; the debounce lives in renderGraph. Settings: TABLE_NAME, SITE_BUCKET, METRICS_NAMESPACE,
// GRAPH_DEBOUNCE_SECONDS.
import { renderGraph, smoke } from './render.mjs';

let deps = null;

export async function handler(event) {
  if (event && typeof event === 'object' && event.smoke === true) return smoke();
  if (deps === null) {
    const { createDeps } = await import('./aws.mjs');
    deps = await createDeps();
  }
  return renderGraph(deps, event && typeof event === 'object' ? { force: event.force === true, seq: Number.isInteger(event.seq) ? event.seq : undefined } : {});
}
