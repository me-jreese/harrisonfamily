// HFY-TSK-254 (hfy-record-subs-api; social.md section 6, R-12): record follows behind GET and PUT/DELETE /api/subscriptions.
//
// One item per follow: PK=RSUB#<principal>, SK=REC#person:<gramps_id>, GSI1PK=RECSUB#person:<gramps_id>, GSI1SK=<principal>. The same item
// answers "my follows" (Query on the PK) and fan-out (one GSI1 Query per changed subject, notify.js queryFollowers). Code must never
// query begins_with(PK, "REC#") across both this and the record store (BRD2 section 4). Follows are explicit, are not audited and never
// tell the followed person. The remove route is named subscriptions.remove: a name ending in ".delete" would match the "*.delete" policy glob.
import { HttpError } from "./http.js";

export const SUB_ID_RE = /^[A-Za-z0-9_-]{1,32}$/;
export const DEFAULT_LIMIT = 25;
export const MAX_LIMIT = 100;
/** Reading the whole follow list is bounded: 231 records at family scale, this many Query pages at most. */
const MAX_PAGES = 20;
export const subSubject = (id) => `person:${id}`;
export const rsubKeys = (principal, subject) => ({ PK: `RSUB#${principal}`, SK: `REC#${subject}` });
export const recsubGsi = (subject) => `RECSUB#${subject}`;

const encodeCursor = (o) => Buffer.from(JSON.stringify(o), "utf8").toString("base64url");
function decodeCursor(cursor) {
  const bad = () => new HttpError(400, "cursor_invalid", "that cursor is not valid. start again.");
  if (typeof cursor !== "string" || !/^[A-Za-z0-9_-]{1,200}$/.test(cursor)) throw bad();
  try {
    const o = JSON.parse(Buffer.from(cursor, "base64url").toString("utf8"));
    if (typeof o?.at !== "string" || typeof o?.subject !== "string" || !/^person:[A-Za-z0-9_-]{1,32}$/.test(o.subject)) throw bad();
    return o;
  } catch (e) {
    throw e instanceof HttpError ? e : bad();
  }
}
function parseLimit(v) {
  if (v === undefined || v === "") return DEFAULT_LIMIT;
  const n = Number(v);
  if (!Number.isInteger(n) || n < 1 || n > MAX_LIMIT) throw new HttpError(400, "validation", `limit must be a whole number from 1 to ${MAX_LIMIT}`);
  return n;
}
/** `person:<gramps_id>` -> the gramps_id, else a 400 validation. */
export function parseSubject(subject) {
  const m = /^person:(.+)$/.exec(typeof subject === "string" ? subject : "");
  if (!m || !SUB_ID_RE.test(m[1])) throw new HttpError(400, "validation", "subject must be person:<gramps_id>");
  return m[1];
}

/** `personExists(id)` -> boolean (the site's person/<id>.json, via the labels loader); it may throw, which is a 503. */
export function createSubscriptions({ ddb, cmds, table, actor, now, personExists }) {
  const idOf = (id) => {
    if (typeof id !== "string" || !SUB_ID_RE.test(id)) throw new HttpError(400, "validation", "invalid person id");
    return id;
  };
  const read = async (subject) => (await ddb.send(new cmds.GetCommand({ TableName: table, Key: rsubKeys(actor.id, subject), ConsistentRead: true }))).Item;

  return {
    /** subscriptions.get: { subject, subscribed }. */
    async get(subject) {
      const id = parseSubject(subject);
      return { subject: subSubject(id), subscribed: Boolean(await read(subSubject(id))) };
    },

    /** subscriptions.list: mine, newest first, { items: [{subject, created_at}], cursor }. */
    async list({ cursor, limit } = {}) {
      const size = parseLimit(limit);
      const after = cursor !== undefined && cursor !== "" ? decodeCursor(cursor) : undefined;
      const all = [];
      let key;
      for (let i = 0; i < MAX_PAGES; i += 1) {
        const r = await ddb.send(new cmds.QueryCommand({
          TableName: table, KeyConditionExpression: "PK = :pk AND begins_with(SK, :sk)",
          ExpressionAttributeValues: { ":pk": `RSUB#${actor.id}`, ":sk": "REC#person:" }, ...(key ? { ExclusiveStartKey: key } : {}),
        }));
        for (const it of r.Items ?? []) if (typeof it.subject === "string") all.push({ subject: it.subject, created_at: String(it.created_at ?? "") });
        key = r.LastEvaluatedKey;
        if (!key) break;
      }
      // Newest first; the subject breaks ties so the order (and so the cursor) is total.
      all.sort((a, b) => (a.created_at < b.created_at ? 1 : a.created_at > b.created_at ? -1 : a.subject < b.subject ? 1 : -1));
      const rest = after ? all.filter((x) => x.created_at < after.at || (x.created_at === after.at && x.subject < after.subject)) : all;
      const items = rest.slice(0, size);
      return { items, cursor: rest.length > size ? encodeCursor({ at: items.at(-1).created_at, subject: items.at(-1).subject }) : null };
    },

    /** subscriptions.put: idempotent; the first call writes, later calls keep created_at. */
    async put(rawId) {
      const id = idOf(rawId);
      if (id === actor.id) throw new HttpError(400, "self_subscribe", "your own page already tells you when it changes");
      let exists;
      try {
        exists = await personExists(id);
      } catch {
        throw new HttpError(503, "unavailable", "follows are unavailable, try again");
      }
      if (!exists) throw new HttpError(404, "not_found", "no such person");
      const subject = subSubject(id);
      try {
        await ddb.send(new cmds.PutCommand({
          TableName: table, ConditionExpression: "attribute_not_exists(PK)",
          Item: { ...rsubKeys(actor.id, subject), entity: "rsub", subject, created_at: new Date(now()).toISOString(), GSI1PK: recsubGsi(subject), GSI1SK: actor.id },
        }));
      } catch (e) {
        if (e?.name !== "ConditionalCheckFailedException") throw e; // already following: success
      }
      return { subject, subscribed: true };
    },

    /** subscriptions.remove: 204 whether or not the follow existed. */
    async remove(rawId) {
      const id = idOf(rawId);
      await ddb.send(new cmds.DeleteCommand({ TableName: table, Key: rsubKeys(actor.id, subSubject(id)) }));
    },
  };
}
