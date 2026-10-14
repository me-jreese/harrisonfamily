// HFY-TSK-193 (surf-links-api; surfaces.md 6.3, R-16, R-17): the profile links store behind GET and PUT /api/people/:id/links.
//
// One item per person, PK=PLINKS#<gramps_id>, SK=META: {links: {<platform>: {url, handle|host}}, version, updatedAt, updatedBy}. Every write is
// one TransactWriteItems of that item plus an AUDIT#plinks:<gramps_id> item (op links.update or links.clear, with before and after; D-15).
// The owner (actor.id === :id) may set or clear any platform. An admin may only clear (null). Anyone else is 403. The version is optimistic
// concurrency: a stale one is 409 with the current item. A no-op body (nothing would change) is 200 with the current view and no write.
// An invalid :id is 400 (the spec leaves the status open); a well-formed id with no item reads as empty (no person-existence check).
// The validator is the shared module the editor runs too (src/shared/profile-links.mjs).
import { isDeepStrictEqual } from "node:util";
import { HttpError } from "./http.js";
import { TxnCancelled, auditItem, transact } from "./txn.js";
import { validateLinks, PLATFORMS } from "./shared/profile-links.mjs";

export const LINKS_ID_RE = /^[A-Za-z0-9_-]{1,64}$/;
export const linksKeys = (id) => ({ PK: `PLINKS#${id}`, SK: "META" });
export const linksAuditId = (id) => `plinks:${id}`;

const isBlank = (v) => v === null || v === undefined || (typeof v === "string" && v.trim() === "");
const isPlain = (v) => v !== null && typeof v === "object" && !Array.isArray(v);
const view = (item) => ({ links: item?.links ?? {}, version: item?.version ?? 0 });
const currentOf = (item) => ({ ...view(item), ...(item?.updatedAt ? { updatedAt: item.updatedAt } : {}) });

export function createLinks({ ddb, cmds, table, actor, now, uid }) {
  const idOf = (id) => {
    if (typeof id !== "string" || !LINKS_ID_RE.test(id)) throw new HttpError(400, "validation", "invalid person id");
    return id;
  };
  const read = async (id) => (await ddb.send(new cmds.GetCommand({ TableName: table, Key: linksKeys(id), ConsistentRead: true }))).Item;
  const conflict = (item) => new HttpError(409, "conflict", "links changed since you loaded them", { current: currentOf(item) });

  return {
    async get(rawId) {
      const id = idOf(rawId);
      return { ...view(await read(id)), can: { edit: actor.id === id } };
    },

    async put(rawId, body) {
      const id = idOf(rawId);
      const owner = actor.id === id;
      const admin = actor.admin === true;
      if (!owner && !admin) throw new HttpError(403, "forbidden", "you can only change your own links");
      const { links: input, version } = body ?? {};
      if (!isPlain(input)) throw new HttpError(400, "validation", "links must be an object of platform to link or null");
      if (!Number.isInteger(version) || version < 0) throw new HttpError(400, "validation", "version must be a non-negative integer");
      const touched = Object.keys(input);
      if (!owner && touched.some((k) => !isBlank(input[k]))) throw new HttpError(403, "forbidden", "an admin can only clear links");
      for (const k of touched) {
        if (!PLATFORMS.includes(k)) continue; // reported by validateLinks as unknown_platform
        if (!isBlank(input[k]) && typeof input[k] !== "string") throw new HttpError(422, "validation", "invalid links", { fields: [{ field: k, code: "invalid_url" }] });
      }
      const checked = validateLinks(input);
      if (!checked.ok) throw new HttpError(422, "validation", "some links are not valid", { fields: checked.fields });

      const before = await read(id);
      if ((before?.version ?? 0) !== version) throw conflict(before);
      const links = { ...(before?.links ?? {}) };
      for (const [k, v] of Object.entries(checked.links)) {
        if (v === null) delete links[k];
        else links[k] = v;
      }
      // A body that changes nothing (empty, or clears of platforms that are not set) writes nothing: no version bump, no audit item.
      if (isDeepStrictEqual(links, before?.links ?? {})) return view(before);
      const at = new Date(now()).toISOString();
      const next = { ...linksKeys(id), entity: "plinks", links, version: version + 1, updatedAt: at, updatedBy: actor.id };
      const clearing = touched.length > 0 && touched.every((k) => isBlank(input[k]));
      const audit = auditItem(
        { op: clearing ? "links.clear" : "links.update", id: linksAuditId(id), principalId: actor.id, at, before: view(before), after: view(next) },
        uid(), table,
      );
      const guard = before
        ? { condition: "#v = :v", names: { "#v": "version" }, values: { ":v": version } }
        : { condition: "attribute_not_exists(PK)" };
      try {
        await transact(ddb, cmds, table, { puts: [{ item: next, ...guard }, { item: audit }] });
      } catch (e) {
        if (e instanceof TxnCancelled && e.busy) throw new HttpError(503, "busy", "busy, try again");
        if (e instanceof TxnCancelled && e.conditionFailed) throw conflict(await read(id));
        if (e instanceof TxnCancelled) throw new HttpError(503, "unavailable", "links are unavailable, try again");
        throw e;
      }
      return view(next);
    },
  };
}
