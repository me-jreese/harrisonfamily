// HFY-TSK-388-0G: small persistence for the tag adapter: the offline queue of pending TagOps, the self-untag audit records and the re-add locks.
// IndexedDB when the browser has it, an in-memory map when it does not (private windows, node tests); a failing IndexedDB call falls back to the map and never
// throws, so tagging works without storage. The kit exposes only `onQueueChange(pending)`; `createTagQueue().onQueueChange` is the handler a host hands it.
const copy = (v) => (v === undefined ? undefined : JSON.parse(JSON.stringify(v)));

export function memoryStore() {
  const m = new Map();
  return { kind: "memory", get: async (k) => copy(m.get(k)), set: async (k, v) => { m.set(k, copy(v)); } };
}

/** `createTagStore({ indexedDB?, name?, fallback? })` -> { kind, get(key), set(key, value) }. The database opens on first use. */
export function createTagStore({ indexedDB: idb = globalThis.indexedDB, name = "hfy-tags", fallback = memoryStore() } = {}) {
  let opening = null;
  const open = () => (opening ??= new Promise((resolve, reject) => {
    if (!idb) { reject(new Error("no indexedDB")); return; }
    let req;
    try { req = idb.open(name, 1); } catch (e) { reject(e); return; }
    req.onupgradeneeded = () => { try { req.result.createObjectStore("kv"); } catch { /* exists */ } };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error || new Error("indexedDB open failed"));
  }));
  const run = async (mode, fn) => {
    const db = await open();
    return new Promise((resolve, reject) => {
      const tx = db.transaction("kv", mode);
      const req = fn(tx.objectStore("kv"));
      tx.oncomplete = () => resolve(req ? req.result : undefined);
      tx.onerror = () => reject(tx.error || new Error("indexedDB transaction failed"));
      tx.onabort = tx.onerror;
    });
  };
  return {
    kind: idb ? "indexeddb" : "memory",
    async get(key) {
      try {
        const v = await run("readonly", (s) => s.get(key));
        return v === undefined ? await fallback.get(key) : v;
      } catch { return fallback.get(key); }
    },
    async set(key, value) {
      await fallback.set(key, value);
      try { await run("readwrite", (s) => s.put(copy(value), key)); } catch { /* the in-memory copy stands */ }
    },
  };
}

const isNetwork = (e) => Boolean(e) && (e.status === 0 || e.status >= 500);

/**
 * The persistent offline queue of pending TagOps (each carries its baseVersion, D-04). `load()` reads it back after a reload; `onQueueChange(pending)` is the
 * kit editor's callback and stores the list; `flush(source)` replays it through `source.putTags`, one batch per media in queue order. A network failure keeps
 * the rest queued; any other failure drops that op and reports it in `failed`; a stale op comes back in `conflicts` and is dropped (never overwritten).
 */
export function createTagQueue({ store = createTagStore(), key = "queue" } = {}) {
  let ops = [];
  const listeners = new Set();
  const set = async (next) => { ops = next.map(copy); await store.set(key, ops); for (const l of listeners) l(ops.map(copy)); };
  return {
    async load() { const v = await store.get(key); ops = Array.isArray(v) ? v : []; for (const l of listeners) l(ops.map(copy)); return ops.map(copy); },
    onQueueChange: (pending) => set(Array.isArray(pending) ? pending : []),
    pending: () => ops.map(copy),
    subscribe(fn) { listeners.add(fn); return () => listeners.delete(fn); },
    async flush(source) {
      const out = { applied: [], proposed: [], conflicts: [], failed: [], kept: 0 };
      const groups = [];
      for (const op of ops) {
        const last = groups[groups.length - 1];
        if (last && last[0].mediaId === op.mediaId) last.push(op); else groups.push([op]);
      }
      const rest = [];
      for (let g = 0; g < groups.length; g += 1) {
        try {
          const r = await source.putTags(groups[g]);
          out.applied.push(...r.applied); out.proposed.push(...r.proposed); out.conflicts.push(...r.conflicts);
        } catch (e) {
          if (isNetwork(e)) { for (const rem of groups.slice(g)) rest.push(...rem); break; }
          for (const op of groups[g]) out.failed.push({ op, code: e && e.code ? e.code : "REQUEST_FAILED" });
        }
      }
      out.kept = rest.length;
      await set(rest);
      return out;
    },
  };
}
