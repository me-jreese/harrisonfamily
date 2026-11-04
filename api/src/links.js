// HFY-TSK-193 (surf-links-api; surfaces.md 6.3, R-16, R-17): the profile links store behind GET and PUT /api/people/:id/links.
//
// One item per person, PK=PLINKS#<gramps_id>, SK=META: {links: {<platform>: {url, handle|host}}, version, updatedAt, updatedBy}. Every write is
// one TransactWriteItems of that item plus an AUDIT#plinks:<gramps_id> item (op links.update or links.clear, with before and after; D-15).
// The owner (actor.id === :id) may set or clear any platform. An admin may only clear (null). Anyone else is 403. The version is optimistic
// concurrency: a stale one is 409 with the current item. A no-op body (nothing would change) is 200 with the current view and no write.
// An invalid :id is 400 (the spec leaves the status open); a well-formed id with no item reads as empty (no person-existence check).
// HFY-TSK-363: the field policy (owner sets or clears, admin clear-only), the merge and the validation are @io-kit/profile's "links" field; this
// module keeps the DynamoDB item, the version check and the audit transaction, behind a ProfileStore adapter over the PLINKS# item.
import { isDeepStrictEqual } from "node:util";
import { HttpError } from "./http.js";
import { TxnCancelled, auditItem, transact } from "./txn.js";
import { ProfileError, createProfileKit, uploadedMediaAvatar } from "@io-kit/profile";

export const LINKS_ID_RE = /^[A-Za-z0-9_-]{1,64}$/;
export const linksKeys = (id) => ({ PK: `PLINKS#${id}`, SK: "META" });
export const linksAuditId = (id) => `plinks:${id}`;

const isBlank = (v) => v === null || v === undefined || (typeof v === "string" && v.trim() === "");
// The one registered field: the member's own links, saved directly; an admin may only clear (R-16). No display toggle: links show whenever set.
export const LINKS_FIELD = Object.freeze({ id: "links", type: "links", edit_policy: "direct", visibility_tier: "member", display_toggle: false, admin_mode: "clear_only" });
// HFY has no profile-picture route yet: the uploaded_media adapter is registered over gramps media, whose lookup and save arrive with the picture task.
const avatar = uploadedMediaAvatar({ lookup: async () => null, save: async () => { throw new HttpError(405, "unsupported", "profile pictures are not available yet"); } });
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
      const before = await read(id);
      let links = before?.links ?? {};
      const store = {
        get: async () => ({ principal: id, fields: { links: { displayed: false, ...(before?.links ? { value: before.links } : {}) } } }),
        put: async (row) => { links = row.fields.links?.value ?? {}; },
      };
      const kit = createProfileKit({ fields: [LINKS_FIELD], tiers: ["member"], store, avatar, now: () => new Date(now()) });
      try {
        await kit.putValue(id, "links", input, actor);
      } catch (e) {
        if (e instanceof ProfileError) throw new HttpError(e.status, e.code, e.message, e.details);
        throw e;
      }
      if ((before?.version ?? 0) !== version) throw conflict(before);
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
