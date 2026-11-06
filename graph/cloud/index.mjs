// hfy-graph-render (HFY-TSK-274): the Lambda entry point (handler src/index.handler; the package's src/index.mjs re-exports this).
//
// Invoked asynchronously by hfy-sync-render after each successful live pass ({"source": "render", "seq": N}) and on its schedule tick; an
// operator may invoke it with {"force": true} to rebuild at once (the graph, and every media thumbnail), or {"smoke": true} to crop a
// synthetic face (no AWS call, no family data). Each invocation runs two independent steps, the graph pass and the thumbnail pass
// (HFY-TSK-393, thumbs.mjs): a failure of one never starves the other, and the invocation fails if either failed.
// Reserved concurrency 1 serialises passes; the debounce lives in renderGraph. Settings: TABLE_NAME, SITE_BUCKET, METRICS_NAMESPACE,
// GRAPH_DEBOUNCE_SECONDS.
import { renderGraph, smoke } from './render.mjs';
import { renderThumbnails } from './thumbs.mjs';

let deps = null;

export async function handler(event, context) {
  if (event && typeof event === 'object' && event.smoke === true) return smoke();
  if (deps === null) {
    const { createDeps } = await import('./aws.mjs');
    deps = await createDeps();
  }
  const opts = event && typeof event === 'object' ? { force: event.force === true, seq: Number.isInteger(event.seq) ? event.seq : undefined } : {};
  let graph = null;
  let graphError = null;
  try {
    graph = await renderGraph(deps, opts);
  } catch (e) {
    graphError = e;
  }
  let thumbs = null;
  let thumbsError = null;
  try {
    const remainingMs = typeof context?.getRemainingTimeInMillis === 'function' ? () => context.getRemainingTimeInMillis() : undefined;
    thumbs = await renderThumbnails(deps, { force: opts.force === true, remainingMs });
  } catch (e) {
    thumbsError = e;
  }
  if (graphError) throw graphError;
  if (thumbsError) throw thumbsError;
  return { ...graph, thumbs };
}
