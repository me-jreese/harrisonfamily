// One graph pass of hfy-graph-render (HFY-TSK-274, viz.md section 5.7, BRD2 sections 8 and 11.6).
//
//   read SYNC#HEAD  ->  skip when SYNC#GRAPH.built_seq is already there (the debounce), or a push session is open
//   store view + MOD# overlay  ->  buildFamilyGraph()  ->  face crops (S3 photos, new files held in memory)
//   verify()  ->  upload the NEW faces  ->  person/graph.json (only when its content digest changed)  ->  prune unreferenced faces
//   SYNC#GRAPH.built_seq
//
// Nothing is written before verify() passes, so a failure leaves the previous graph.json and faces in place and raises the
// renderer's RenderError alarm (the metric the sync renderer's own alarm watches). Only an error code is ever logged or stored:
// never a message, a name or an id. No gazetteer runs here: only the Gramps coordinates in the store are used (GAZETTEER_MISSING is
// the normal case and is not a finding).
import { createHash } from 'node:crypto';
import { applyFaces, buildFamilyGraph } from '../src/build.mjs';
import { FACE_FILE, buildFaces } from '../src/faces.mjs';
import { stringify } from '../src/canonical.mjs';
import { assertSizeBudget, assertVerified, loadSharedGuard } from '../src/verify.mjs';
import { GraphError } from '../src/errors.mjs';
import { getSession, getSyncHead } from '../../api/src/sync/store.js';
import { applyModeration, loadHiddenMods, loadStoreObjects } from './cloud-source.mjs';

export const GRAPH_KEY = 'person/graph.json';
export const FACES_PREFIX = 'media/faces/';
export const STATE_KEY = Object.freeze({ PK: 'SYNC#GRAPH', SK: 'META' });
/** A push session younger than this holds the pass (the sync renderer's SESSION_QUIET_SECONDS). */
export const SESSION_QUIET_SECONDS = 600;
export const DEFAULT_DEBOUNCE_MS = 15_000;

/** Media content types to the extension of media/<handle><ext> (api/src/sync/media.js MEDIA_TYPES). */
const EXT_OF_MIME = Object.freeze({ 'image/jpeg': '.jpg', 'image/png': '.png', 'image/gif': '.gif', 'image/tiff': '.tif', 'application/pdf': '.pdf' });
const HANDLE = /^[A-Za-z0-9_-]{1,64}$/;

/** The failure class that may be logged and stored: a GraphError code, or an error name. Never a message. */
export function errorCode(e) {
  const code = e instanceof GraphError ? e.code : e && typeof e.code === 'string' && /^[\w.-]{1,64}$/.test(e.code) ? e.code : e && typeof e.name === 'string' && /^[\w.-]{1,64}$/.test(e.name) ? e.name : 'Error';
  return code;
}

/**
 * The MediaReader over the site bucket (viz.md 5.5): media/<handle><ext>, the extension from the Media's content type, else the one
 * on its stored path. A missing object, a handle that is not a plain handle, or a Media that is not in `mediaObjects` reads as null
 * (MEDIA_MISSING, the person keeps initials).
 * @param {{ get(key: string): Promise<Buffer | null> }} site
 * @param {object[]} mediaObjects  the Media objects left after the overlay
 */
export function s3MediaReader(site, mediaObjects) {
  const byHandle = new Map(mediaObjects.filter((m) => m._class === 'Media').map((m) => [m.handle, m]));
  return {
    async read(handle) {
      const media = byHandle.get(handle);
      if (!media || !HANDLE.test(handle)) return null;
      const exts = [];
      const fromMime = typeof media.mime === 'string' ? EXT_OF_MIME[media.mime.toLowerCase()] : undefined;
      if (fromMime) exts.push(fromMime);
      const m = typeof media.path === 'string' ? /\.([A-Za-z0-9]{2,4})$/.exec(media.path) : null;
      if (m) exts.push(`.${m[1].toLowerCase()}`);
      for (const ext of [...new Set(exts)]) {
        const bytes = await site.get(`media/${handle}${ext}`);
        if (bytes) return bytes;
      }
      return null;
    },
  };
}

function sessionYoung(session, now) {
  if (!session || session.state !== 'open') return false;
  const opened = Date.parse(session.opened_at);
  if (!Number.isFinite(opened)) return true; // no usable clock on an open session: fail closed, as the sync renderer does
  return now.getTime() - opened < SESSION_QUIET_SECONDS * 1000;
}

/** A digest of the hidden targets (not the targets: the marker is not a place to list what was hidden). */
export function modsDigest(mods) {
  return createHash('sha256').update(JSON.stringify([...mods.keys()].sort())).digest('hex').slice(0, 16);
}

async function readState(ctx) {
  return (await ctx.ddb.send(new ctx.cmds.GetCommand({ TableName: ctx.table, Key: STATE_KEY, ConsistentRead: true }))).Item ?? null;
}

async function recordFailure(ctx, code, now) {
  await ctx.ddb.send(new ctx.cmds.UpdateCommand({
    TableName: ctx.table,
    Key: STATE_KEY,
    UpdateExpression: 'SET last_error = :e, last_error_at = :t',
    ExpressionAttributeValues: { ':e': `GraphRenderError:${code}`, ':t': now.toISOString() },
  }));
}

/**
 * @param {{ ctx: {ddb: any, cmds: any, table: string}, site: {get(key: string): Promise<Buffer|null>, put(key: string, body: Buffer|string, contentType: string): Promise<void>, delete(key: string): Promise<void>, list(prefix: string): Promise<string[]>},
 *   metrics: {emit(name: string, value?: number): Promise<void>|void}, now?: () => Date, sleep?: (ms: number) => Promise<void>, debounceMs?: number,
 *   log?: {info: Function, error: Function}, guard?: Function|null }} deps
 * @param {{ force?: boolean, seq?: number }} [event]
 */
export async function renderGraph(deps, event = {}) {
  const { ctx, site, metrics } = deps;
  const clock = deps.now ?? (() => new Date());
  const log = deps.log ?? console;
  const force = event.force === true;
  const started = clock();
  try {
    let head = await getSyncHead(ctx);
    let seq = Number(head?.seq ?? 0);
    if (!(seq > 0)) return { status: 'skipped', reason: 'empty_store' };
    // A MOD# hide or unhide may not move the store seq, so the marker also records which items were hidden when the graph was built.
    let mods = await loadHiddenMods(ctx);
    const current = (state) => !force && state && Number(state.built_seq) >= seq && state.mods === modsDigest(mods);
    let state = await readState(ctx);
    if (current(state)) return { status: 'skipped', reason: 'current', seq };
    // Debounce: wait once for a burst of passes to settle, then read the head again. Every invocation queued behind this one finds the
    // marker current and returns at once, so a burst of live passes costs one build.
    const wait = deps.debounceMs ?? DEFAULT_DEBOUNCE_MS;
    if (wait > 0 && !force) {
      await (deps.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms))))(wait);
      head = await getSyncHead(ctx);
      seq = Number(head?.seq ?? 0);
      mods = await loadHiddenMods(ctx);
      state = await readState(ctx);
      if (current(state)) return { status: 'skipped', reason: 'current', seq };
    }
    if (head?.open_session && sessionYoung(await getSession(ctx, head.open_session), clock())) return { status: 'skipped', reason: 'push_session_open', seq };

    const { objects: stored, seq: builtSeq } = await loadStoreObjects(ctx);
    const { objects, hiddenFaces, counts: hidden } = applyModeration(stored, mods);
    if (!objects.some((o) => o._class === 'Person')) throw new GraphError('INPUT_MISSING', 'the store view holds no Person objects');

    const now = clock();
    const { graph, faceJobs } = buildFamilyGraph(objects, { now, sourceKind: 'cloud', gazetteer: null });
    const jobs = faceJobs.filter((j) => !hiddenFaces.has(j.id));

    // Faces: the photos come from the site bucket; a file that is already there (the name holds the content hash) is not cropped or
    // uploaded again. New crops wait in memory until verify() has passed.
    const existing = new Set((await site.list(FACES_PREFIX)).map((k) => k.slice(FACES_PREFIX.length)).filter((n) => FACE_FILE.test(n)));
    const fresh = new Map();
    const sink = { exists: (name) => existing.has(name) || fresh.has(name), write: (name, bytes) => void fresh.set(name, bytes) };
    const r = await buildFaces(jobs, s3MediaReader(site, objects), sink);
    applyFaces(graph, r.faces);

    const guard = deps.guard !== undefined ? deps.guard : await loadSharedGuard();
    assertVerified(graph, { now, guard });
    const text = stringify(graph);
    assertSizeBudget(text);

    // ---- writes: only after verify() ----
    for (const [name, bytes] of fresh) await site.put(`${FACES_PREFIX}${name}`, bytes, 'image/webp');
    let prevSnapshot = null;
    try {
      prevSnapshot = JSON.parse((await site.get(GRAPH_KEY))?.toString('utf8') ?? 'null')?.source?.snapshot ?? null;
    } catch {
      prevSnapshot = null; // an unreadable previous graph is simply replaced
    }
    const graphWritten = prevSnapshot !== graph.source.snapshot;
    if (graphWritten) await site.put(GRAPH_KEY, text, 'application/json');
    let pruned = 0;
    for (const name of existing) {
      if (!r.keep.has(name)) {
        await site.delete(`${FACES_PREFIX}${name}`);
        pruned += 1;
      }
    }
    const result = {
      status: 'rendered', seq: builtSeq, people: graph.counts.people, unions: graph.counts.unions, faces: graph.counts.faces,
      faces_written: fresh.size, faces_pruned: pruned, graph_written: graphWritten,
      hidden_notes: hidden.notes, hidden_media: hidden.media, hidden_primary_photos: hiddenFaces.size,
      warnings: r.warnings.length,
    };
    await ctx.ddb.send(new ctx.cmds.PutCommand({
      TableName: ctx.table,
      Item: { ...STATE_KEY, built_seq: builtSeq, built_at: clock().toISOString(), snapshot: graph.source.snapshot, mods: modsDigest(mods), people: graph.counts.people, faces: graph.counts.faces },
    }));
    log.info?.(`graph render ${JSON.stringify({ ...result, elapsed_ms: clock().getTime() - started.getTime() })}`);
    return result;
  } catch (e) {
    const code = errorCode(e);
    log.error?.(`graph render failed code=${code}`);
    try {
      await metrics.emit('RenderError', 1);
    } catch {
      /* best effort: the thrown error below still fails the invocation */
    }
    try {
      await recordFailure(ctx, code, clock());
    } catch {
      log.error?.('graph render failed to record last_error');
    }
    throw new Error(`hfy-graph-render failed: ${code}`);
  }
}

/**
 * The smoke invoke (DL-34): crops a synthetic face from a generated image with the packaged sharp and returns the facts of the file.
 * It touches no AWS service and reads no family data.
 */
export async function smoke() {
  const { default: sharp } = await import('sharp');
  const raw = Buffer.alloc(64 * 48 * 3, 90);
  const photo = await sharp(raw, { raw: { width: 64, height: 48, channels: 3 } }).jpeg().toBuffer();
  const out = new Map();
  const r = await buildFaces(
    [{ id: 'I0000', media: 'smoke', rect: [10, 10, 60, 90] }],
    { read: async () => photo },
    { exists: () => false, write: (n, b) => void out.set(n, b) },
  );
  if (out.size !== 1 || r.warnings.length) throw new Error('the smoke face was not cropped');
  const [[name, bytes]] = [...out];
  const meta = await sharp(bytes).metadata();
  return { status: 'smoke', ok: meta.format === 'webp' && meta.width === 160 && meta.height === 160, name, format: meta.format, width: meta.width, height: meta.height, bytes: bytes.length };
}
