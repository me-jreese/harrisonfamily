// HFY-TSK-388-0G: a stateful fake of the HFY endpoints the tag adapter uses (GET /api/media/:id, GET /api/edit/{Person,Media}/:ref, POST /api/changes), running the REAL ops
// engine (api/src/records/ops.js applyOps) so a wrong key segment, base or index conflicts exactly as the server does. Own record or admin: saved now with the inverse;
// another person's record: a proposal and no change. Synthetic ids and names only.
import { applyOps } from "../../../api/src/records/ops.js";
import { normalizeRect } from "../../../api/src/rect.js";

const LIVING = "a living family member";
const clone = (v) => JSON.parse(JSON.stringify(v));
const json = (status, data) => ({ ok: status >= 200 && status < 300, status, json: async () => data });

/** `seed` is the kit's MemorySeed shape: people [{id, name, living?, photo?}], media [{id}], tags [[personId, mediaId, rect]], viewerPersonId. */
export function createFakeApi(seed = {}, { admin = false } = {}) {
  const persons = new Map();
  const medias = new Map();
  const state = { viewer: seed.viewerPersonId || "", admin };
  const calls = [];
  const proposals = [];
  const hooks = {};
  for (const p of seed.people || []) {
    persons.set(p.id, { gid: p.id, name: p.name, living: p.living === true, photo: p.photo || "", version: 1, obj: { _class: "Person", handle: `P-${p.id}`, gramps_id: p.id, private: false, media_list: [] } });
  }
  for (const m of seed.media || []) medias.set(m.id, { gid: m.id, handle: `M-${m.id}` });
  for (const [pid, mid, rect] of seed.tags || []) persons.get(pid).obj.media_list.push({ _class: "MediaRef", private: false, citation_list: [], note_list: [], attribute_list: [], ref: medias.get(mid).handle, rect });
  const byHandle = (h) => [...persons.values()].find((p) => p.obj.handle === h);
  const safe = (r) => { try { return normalizeRect(r === undefined ? null : r); } catch { return null; } };

  function detailOf(gid) {
    const m = medias.get(gid);
    if (!m) return null;
    const tags = [];
    for (const p of persons.values()) {
      p.obj.media_list.forEach((el, index) => {
        if (el.ref === m.handle) tags.push({ personId: p.gid, mediaId: gid, rect: safe(el.rect), index, state: "applied", person: { displayName: p.living ? LIVING : p.name, living: p.living } });
      });
    }
    return { card: { mediaId: gid, tagCount: tags.length }, tags, version: `${m.handle}|${tags.map((t) => `${t.personId}:${t.index}:${persons.get(t.personId).version}`).join("|")}` };
  }

  async function fetch(url, init = {}) {
    const method = init.method || "GET";
    const path = String(url).replace(/^\/api/, "").split("?")[0];
    const body = init.body ? JSON.parse(init.body) : undefined;
    calls.push({ method, path, body, headers: init.headers || {} });
    let m;
    if (method === "GET" && (m = path.match(/^\/media\/([^/]+)$/))) { const d = detailOf(decodeURIComponent(m[1])); return d ? json(200, d) : json(404, { error: "not_found" }); }
    if (method === "GET" && (m = path.match(/^\/edit\/Media\/([^/]+)$/))) {
      const md = medias.get(decodeURIComponent(m[1]));
      return md ? json(200, { key: `Media:${md.handle}`, version: 1, obj: { _class: "Media", handle: md.handle, gramps_id: md.gid } }) : json(404, { error: "not_found" });
    }
    if (method === "GET" && (m = path.match(/^\/edit\/Person\/([^/]+)$/))) {
      const p = persons.get(decodeURIComponent(m[1]));
      return p ? json(200, { key: `Person:${p.obj.handle}`, version: p.version, obj: clone(p.obj) }) : json(404, { error: "not_found" });
    }
    if (method === "POST" && path === "/changes") {
      const [, handle] = String(body.target).split(":");
      const p = byHandle(handle);
      if (!p) return json(404, { error: "not_found" });
      if (hooks.beforeChanges) hooks.beforeChanges(p);
      if (!body.base_versions || body.base_versions[body.target] !== p.version) return json(409, { error: "version_conflict" });
      const r = applyOps({ [body.target]: p.obj }, body.ops);
      if (!r.ok) return json(409, { error: "conflict", message: r.conflicts.map((c) => c.reason).join(",") });
      if (state.admin || state.viewer === p.gid) {
        p.obj = r.objects[body.target];
        p.version += 1;
        return json(201, { applied: { undo: { base_versions: { [body.target]: p.version }, ops: r.inverse } } });
      }
      proposals.push({ target: body.target, ops: body.ops });
      return json(201, { proposal: { id: `PROP${proposals.length}`, state: "pending" } });
    }
    return json(404, { error: "not_found" });
  }

  const people = {
    async search(q, limit) {
      const needle = String(q || "").trim().toLowerCase();
      return [...persons.values()].filter((p) => p.name.toLowerCase().includes(needle)).slice(0, limit).map((p) => ({ id: p.gid, title: p.name, photo: p.photo, living: p.living }));
    },
    async byId(id) { const p = persons.get(id); return p ? { id, title: p.name, photo: p.photo, living: p.living } : null; },
  };
  return {
    fetch, calls, proposals, hooks, people,
    get viewer() { return state.viewer; }, set viewer(v) { state.viewer = v; },
    handleOf: (gid) => medias.get(gid).handle,
    person: (gid) => persons.get(gid),
    refs: (gid) => clone(persons.get(gid).obj.media_list),
    /** Change a record behind the API's back (a Gramps sync): a new version. */
    bump(gid, mutate) { const p = persons.get(gid); mutate(p.obj); p.version += 1; },
  };
}

/** A minimal IndexedDB: open(name) -> request; one object store "kv"; get/put in a readonly/readwrite transaction that completes on the next tick. */
export function fakeIndexedDB() {
  const dbs = new Map();
  return {
    open(name) {
      const req = {};
      setTimeout(() => {
        const fresh = !dbs.has(name);
        if (fresh) dbs.set(name, new Map());
        const data = dbs.get(name);
        req.result = {
          createObjectStore() {},
          transaction() {
            const tx = {};
            const store = {
              get(k) { return { result: data.get(k) }; },
              put(v, k) { data.set(k, JSON.parse(JSON.stringify(v))); return { result: k }; },
            };
            tx.objectStore = () => store;
            setTimeout(() => tx.oncomplete && tx.oncomplete(), 0);
            return tx;
          },
        };
        if (fresh && req.onupgradeneeded) req.onupgradeneeded();
        if (req.onsuccess) req.onsuccess();
      }, 0);
      return req;
    },
  };
}
