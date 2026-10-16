// The cloud RecordSource of hfy-graph-render (HFY-TSK-274, viz.md section 5.7): the objects of the cloud store view, with the MOD#
// moderation overlay applied, in the _class-tagged shape buildFamilyGraph() reads.
//
// The store view is the api's (api/src/records/index.js): the heads folded from SYNC#LOG, already redacted by the sync server. The
// overlay is the api's too (records/mod-overlay.js), applied as a signed-out viewer would see it: an open, hidden MOD# item removes the
// note, the MediaRef or the Media for every reader, so the graph, the photo edges and the face crops never name it (BRD2 D2-19, PS-07).
// A person whose primary photo (media_list[0]) is hidden gets no face: the next photo must not stand in for it.
import { storeView } from '../../api/src/records/index.js';
import { applyModOverlay, collectModTargets } from '../../api/src/records/mod-overlay.js';

const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const PAGE_CAP = 200;

/** Every live object of the store view as { objects, seq }, ordered by class then handle, each with `_class` and `handle`. */
export async function loadStoreObjects(ctx) {
  const view = await storeView(ctx);
  const objects = [];
  for (const h of view.live()) {
    if (!isObj(h.obj)) continue;
    objects.push({ ...h.obj, _class: h.obj._class ?? h.class, handle: h.obj.handle ?? h.handle });
  }
  objects.sort((a, b) => (a._class < b._class ? -1 : a._class > b._class ? 1 : a.handle < b.handle ? -1 : a.handle > b.handle ? 1 : 0));
  return { objects, seq: view.seq };
}

/**
 * The open MOD# items that hide something: Map target ("note:<h>", "media:<h>", "mediaref:<holder>:<h>") -> { author_id }.
 * Read from the MODQ#open queue (GSI1). A row the index returns without its `hidden` flag is read again from the table, and a read
 * failure propagates: the pass fails, and the previous graph stays (fail closed).
 */
export async function loadHiddenMods(ctx) {
  const mods = new Map();
  let start;
  for (let page = 0; page < PAGE_CAP; page += 1) {
    const res = await ctx.ddb.send(new ctx.cmds.QueryCommand({
      TableName: ctx.table,
      IndexName: 'GSI1',
      KeyConditionExpression: 'GSI1PK = :pk',
      ExpressionAttributeValues: { ':pk': 'MODQ#open' },
      ...(start ? { ExclusiveStartKey: start } : {}),
    }));
    for (const row of res.Items ?? []) {
      let item = row;
      if (typeof item.PK !== 'string' || !item.PK.startsWith('MOD#')) continue;
      if (item.hidden === undefined) {
        item = (await ctx.ddb.send(new ctx.cmds.GetCommand({ TableName: ctx.table, Key: { PK: item.PK, SK: 'META' }, ConsistentRead: true }))).Item;
        if (!item) continue;
      }
      if (item.hidden === true && item.open !== false) {
        mods.set(item.PK.slice('MOD#'.length), { author_id: typeof item.author_id === 'string' ? item.author_id : undefined });
      }
    }
    start = res.LastEvaluatedKey;
    if (!start) return mods;
  }
  throw new Error('the moderation queue is larger than the renderer reads');
}

/** True when a MediaRef of `holder` (a Person object) is hidden: the Media itself or this reference. */
function refHidden(mods, holder, ref) {
  return mods.has(`media:${ref}`) || mods.has(`mediaref:${holder.handle}:${ref}`);
}

/**
 * The objects as an anonymous reader sees them. Returns { objects, hiddenFaces, counts }: hiddenFaces is the set of person gramps ids whose
 * primary photo is hidden (the caller drops their face jobs), counts { notes, media } the Note and Media objects left out.
 */
export function applyModeration(objects, mods) {
  if (!(mods instanceof Map) || mods.size === 0) return { objects, hiddenFaces: new Set(), counts: { notes: 0, media: 0 } };
  const hiddenFaces = new Set();
  const counts = { notes: 0, media: 0 };
  const out = [];
  for (const obj of objects) {
    if (obj._class === 'Note' && mods.has(`note:${obj.handle}`)) {
      counts.notes += 1;
      continue;
    }
    if (obj._class === 'Media' && mods.has(`media:${obj.handle}`)) {
      counts.media += 1;
      continue;
    }
    if (obj._class === 'Person' && Array.isArray(obj.media_list) && obj.media_list.length > 0) {
      const primary = obj.media_list[0];
      if (isObj(primary) && typeof primary.ref === 'string' && refHidden(mods, obj, primary.ref) && typeof obj.gramps_id === 'string') hiddenFaces.add(obj.gramps_id);
    }
    out.push(collectModTargets(obj).some((t) => mods.has(t)) ? applyModOverlay(obj, {}, mods) : obj);
  }
  return { objects: out, hiddenFaces, counts };
}
