// HFY-TSK-282 (edit-e2e-d11-audit): the fake store for the editing end-to-end scenarios. The REAL API handler (routes, gates, the privacy guard, the
// rebase, the transactions) over the in-memory DynamoDB fake, seeded with a synthetic tree. api/test/edit-e2e.test.js drives it with requests;
// islands/tests/edit-e2e.spec.mjs puts the real pages in front of it (the browser's /api calls are answered by `call`). No vitest import, so both can load it.
// Synthetic ids, placeholder names and years only.
import { InMemoryNotificationStore } from "@io-kit/notify/server";
import { cmds, makeApi, signToken, TABLE } from "./world.js";
import { applyBatch } from "../src/sync/apply.js";
import { createHookRegistry } from "../src/sync/hooks.js";
import { registerRecordContributor } from "../src/record-contributor.js";
import { headKey } from "../src/sync/store.js";

export const ME = "I0001"; // a member who owns person 1
export const OTHER = "I0002"; // another member, with no page of their own in the tree
export const ADMIN = "I0099";
export const ADMIN2 = "I0098";

export const h = (n) => n.toString(16).padStart(28, "0");
const typ = (cls, value, string = "") => ({ _class: cls, value, string });
const date = (dateval = [0, 0, 0, false]) => ({ _class: "Date", calendar: 0, dateval, format: null, modifier: 0, newyear: 0, quality: 0, sortval: 0, text: "" });
const person = (n, { first, last, gender = 1, rest = {} }) => ({
  _class: "Person", handle: h(n), gramps_id: `I${String(n).padStart(4, "0")}`, private: false, gender,
  primary_name: { _class: "Name", first_name: first, nick: "", surname_list: [{ _class: "Surname", primary: true, surname: last }], type: typ("NameType", 2), date: date() },
  event_ref_list: [], birth_ref_index: -1, death_ref_index: -1, family_list: [], parent_family_list: [], note_list: [], media_list: [], urls: [], ...rest,
});
const family = (n, extra = {}) => ({ _class: "Family", handle: h(1000 + n), gramps_id: `F${String(n).padStart(4, "0")}`, private: false, father_handle: null, mother_handle: null, child_ref_list: [], event_ref_list: [], type: typ("FamilyRelType", 3), note_list: [], media_list: [], attribute_list: [], citation_list: [], tag_list: [], lds_ord_list: [], ...extra });
const note = (n, string) => ({ _class: "Note", handle: h(2000 + n), gramps_id: `N${String(n).padStart(4, "0")}`, private: false, text: { _class: "StyledText", string, tags: [] }, format: 0, type: typ("NoteType", 1) });
const create = (obj) => ({ op: "create", class: obj._class, handle: obj.handle, base_version: null, obj });

export const key = (obj) => `${obj._class}:${obj.handle}`;
export const P = (n) => `Person:${h(n)}`;
const quiet = { warn() {}, error() {}, info() {} };

/**
 * The synthetic tree: me (1), a woman (3) who is not yet recorded as anyone's parent, my child (6) in a family F1 of me alone, and a note on my page (N1).
 * `HFY_EDITING` is switched on for the life of the process by `createEditWorld` (call `world.dispose()` to restore it).
 */
export async function createEditWorld({ admins = [ADMIN, ADMIN2] } = {}) {
  const before = process.env.HFY_EDITING;
  process.env.HFY_EDITING = "on";
  const hooks = createHookRegistry();
  const inbox = new InMemoryNotificationStore();
  // The fake clock is the real one: step-up (a fresh sign-in) is judged against it, and `authTime` below is now.
  const w = makeApi({
    admins, log: quiet, inbox, flags: { inboxV1: true },
    extraDeps: { syncHooks: hooks, idPolicy: { mode: "mint" }, getAdmins: async () => new Set(admins), txnOpts: { sleep: async () => {} } },
  });
  registerRecordContributor({ ddb: w.ddb, cmds, table: TABLE, log: quiet }, hooks);
  w.ddb.rows.set("SYNC#HEAD\u0000META", { ...headKey(), seq: 0, seeded: true, writes_enabled: true });
  let t = Date.parse("2026-10-14T00:00:00Z");
  let u = 0;
  const sctx = { ddb: w.ddb, cmds, table: TABLE, now: () => (t += 1000), uid: () => `s${++u}`, unsafeNoValidate: true, log: quiet, txnOpts: { sleep: async () => {} } };
  let k = 0;
  const seed = async (objs) => {
    for (let i = 0; i < objs.length; i += 20) await applyBatch(sctx, { principal: "svc-seed", origin: "desktop", idempotencyKey: `seed${++k}`, ops: objs.slice(i, i + 20).map(create) });
  };
  const n1 = note(1, "A synthetic note about the family.");
  const fam = family(1, { father_handle: h(1), child_ref_list: [{ _class: "ChildRef", ref: h(6), frel: typ("ChildRefType", 1), mrel: typ("ChildRefType", 1), private: false, citation_list: [], note_list: [] }] });
  const me = person(1, { first: "Alder", last: "Testwood", rest: { family_list: [fam.handle], note_list: [n1.handle] } });
  const kid = person(6, { first: "Briar", last: "Testwood", rest: { parent_family_list: [fam.handle] } });
  const mother = person(3, { first: "Hazel", last: "Birchwell", gender: 0 });
  await seed([me, mother, kid, n1, fam]);

  /** An API request as `who` (a gramps id; a session minted a few seconds ago, so a step-up is satisfied). */
  const call = async (method, path, who, { body, query, headers = {} } = {}) =>
    w.call(method, path, { token: await signToken(who, { authTime: Math.floor(Date.now() / 1000) - 10 }), ...(body !== undefined ? { body } : {}), ...(query ? { query } : {}), headers });
  /** The stored head object of a record, read from the table itself (not through the API). */
  const stored = (cls, handle) => JSON.parse(w.ddb.rows.get(`REC#${cls}#${handle}\u0000HEAD`).obj_json);
  const version = (cls, handle) => w.ddb.rows.get(`REC#${cls}#${handle}\u0000HEAD`).version;
  const rows = (prefix) => w.ddb.all().filter((r) => r.PK.startsWith(prefix));
  /** Change a record behind the API's back, as a Gramps sync would (a new version). */
  const bump = (obj, base) => applyBatch(sctx, { principal: "svc-seed", origin: "desktop", idempotencyKey: `bump${++k}`, ops: [{ op: "update", class: obj._class, handle: obj.handle, base_version: base, obj }] });
  return { ...w, call, stored, version, rows, bump, inbox, me, mother, kid, n1, fam, dispose: () => { if (before === undefined) delete process.env.HFY_EDITING; else process.env.HFY_EDITING = before; } };
}
