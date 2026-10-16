// In-memory DynamoDB, site bucket and metrics for the hfy-graph-render tests. Synthetic data only.
import sharp from 'sharp';
import { seqKey } from '../../api/src/sync/store.js';

class Cmd {
  constructor(input) {
    this.input = input;
  }
}
export const cmds = { GetCommand: class GetCommand extends Cmd {}, PutCommand: class PutCommand extends Cmd {}, UpdateCommand: class UpdateCommand extends Cmd {}, QueryCommand: class QueryCommand extends Cmd {} };

/** A table with the few commands the renderer uses. `rows` is Map "PK\0SK" -> item. */
export function fakeTable() {
  const rows = new Map();
  const log = [];
  const k = (PK, SK) => `${PK}\u0000${SK}`;
  const ddb = {
    async send(cmd) {
      const i = cmd.input;
      log.push([cmd.constructor.name, i]);
      if (cmd instanceof cmds.GetCommand) return { Item: rows.get(k(i.Key.PK, i.Key.SK)) };
      if (cmd instanceof cmds.PutCommand) {
        rows.set(k(i.Item.PK, i.Item.SK), i.Item);
        return {};
      }
      if (cmd instanceof cmds.UpdateCommand) {
        const old = rows.get(k(i.Key.PK, i.Key.SK)) ?? { ...i.Key };
        rows.set(k(i.Key.PK, i.Key.SK), { ...old, last_error: i.ExpressionAttributeValues[':e'], last_error_at: i.ExpressionAttributeValues[':t'] });
        return {};
      }
      if (cmd instanceof cmds.QueryCommand) {
        const all = [...rows.values()];
        if (i.IndexName === 'GSI1') {
          const hits = all.filter((r) => r.GSI1PK === i.ExpressionAttributeValues[':pk']).sort((a, b) => (a.GSI1SK < b.GSI1SK ? -1 : 1));
          const from = i.ExclusiveStartKey ? hits.findIndex((r) => r.GSI1SK === i.ExclusiveStartKey.GSI1SK) + 1 : 0;
          const page = hits.slice(from, from + 2); // a small page, so paging is exercised
          const more = from + 2 < hits.length;
          return { Items: page, ...(more ? { LastEvaluatedKey: { GSI1SK: page.at(-1).GSI1SK } } : {}) };
        }
        const hits = all.filter((r) => r.PK === i.ExpressionAttributeValues[':pk'] && r.SK > i.ExpressionAttributeValues[':sk']).sort((a, b) => (a.SK < b.SK ? -1 : 1));
        const from = i.ExclusiveStartKey ? hits.findIndex((r) => r.SK === i.ExclusiveStartKey.SK) + 1 : 0;
        const page = hits.slice(from, from + (i.Limit ?? 100));
        const more = from + page.length < hits.length;
        return { Items: page, ...(more ? { LastEvaluatedKey: { SK: page.at(-1).SK } } : {}) };
      }
      throw new Error(`unexpected command ${cmd.constructor.name}`);
    },
  };
  let seq = 0;
  const store = {
    rows,
    log,
    ctx: { ddb, cmds, table: 'T' },
    get seq() {
      return seq;
    },
    /** One create/update op in SYNC#LOG, and the head's seq. */
    put(obj) {
      seq += 1;
      rows.set(k('SYNC#LOG', seqKey(seq)), { PK: 'SYNC#LOG', SK: seqKey(seq), seq, op: 'update', class: obj._class, handle: obj.handle, gramps_id: obj.gramps_id, version: 1, obj_json: JSON.stringify(obj) });
      rows.set(k('SYNC#HEAD', 'META'), { PK: 'SYNC#HEAD', SK: 'META', seq });
    },
    putAll(objects) {
      for (const o of objects) store.put(o);
    },
    /** An open MOD# item (hidden by default). */
    hide(target, extra = {}) {
      rows.set(k(`MOD#${target}`, 'META'), { PK: `MOD#${target}`, SK: 'META', GSI1PK: 'MODQ#open', GSI1SK: `2026-01-01T00:00:00Z#${target}`, hidden: true, open: true, ...extra });
    },
    unhide(target) {
      rows.delete(k(`MOD#${target}`, 'META'));
    },
    state: () => rows.get(k('SYNC#GRAPH', 'META')),
  };
  return store;
}

export function fakeSite(initial = {}) {
  const files = new Map(Object.entries(initial));
  const calls = [];
  return {
    files,
    calls,
    async get(key) {
      calls.push(['get', key]);
      return files.has(key) ? Buffer.from(files.get(key)) : null;
    },
    async put(key, body, contentType) {
      calls.push(['put', key, contentType]);
      files.set(key, Buffer.from(body));
    },
    async delete(key) {
      calls.push(['delete', key]);
      files.delete(key);
    },
    async list(prefix) {
      return [...files.keys()].filter((key) => key.startsWith(prefix)).sort();
    },
    puts: () => calls.filter((c) => c[0] === 'put').map((c) => c[1]),
    deletes: () => calls.filter((c) => c[0] === 'delete').map((c) => c[1]),
  };
}

export function fakeMetrics() {
  const events = [];
  return { events, emit: async (name, value = 1) => void events.push([name, value]) };
}

/** A W x H JPEG of flat colour blocks: never a photo of anyone. */
export async function syntheticJpeg(width = 200, height = 150, colour = { r: 200, g: 30, b: 30 }) {
  return sharp({ create: { width, height, channels: 3, background: colour } }).jpeg().toBuffer();
}
