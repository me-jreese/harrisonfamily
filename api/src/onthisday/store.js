// On this day, the OTD#INDEX/V1 item and its build lease (HFY-TSK-194; surfaces.md section 4.3, error catalog E4 to E6).
//
// One item, PK=OTD#INDEX SK=V1: { schema, sourceVersion, policyVersion, generatedAt, body (B, gzip JSON of the index), size, buildingUntil? }.
// The lease is the same item: `SET buildingUntil = now + 60 s` under `attribute_not_exists(buildingUntil) OR buildingUntil < :now`, so exactly one of any
// number of concurrent callers (in this Lambda container or another) wins the right to build. The winner stores the body with `buildingUntil = :mine`, which
// replaces the item and so also ends the lease. A build that fails leaves the lease to run out: that is the back-off, and the stale body keeps serving.
import { gunzipSync, gzipSync } from "node:zlib";
import { SCHEMA } from "./build.js";

export const OTD_INDEX_KEYS = Object.freeze({ PK: "OTD#INDEX", SK: "V1" });
export const LEASE_MS = 60_000;
/** The item limit is 400 KB; surfaces.md 4.3 shards by month above 300 KB compressed (not built: the interim year tier is about 10 KB). Above this the build fails. */
export const MAX_COMPRESSED_BYTES = 300 * 1024;
/** Bumped whenever a privacy rule of the builder or the selector changes: a stored index built under another policy is never served, stale or not. */
export const POLICY_VERSION = "r19-1";

const isCondition = (e) => e?.name === "ConditionalCheckFailedException";

export const encodeBody = (index) => gzipSync(Buffer.from(JSON.stringify(index), "utf8"), { level: 9 });
export const decodeBody = (body) => JSON.parse(gunzipSync(Buffer.from(body)).toString("utf8"));

/** The index inside a stored item, or null when the item holds no usable body (no body yet, another schema or policy, a damaged body). Never throws. */
export function indexOf(item) {
  if (!item || item.schema !== SCHEMA || item.policyVersion !== POLICY_VERSION || !item.body) return null;
  try {
    const index = decodeBody(item.body);
    return index && index.schema === SCHEMA ? index : null;
  } catch {
    return null;
  }
}

export function createIndexStore({ ddb, cmds, table, now }) {
  return {
    /** The item (strongly consistent), or undefined. */
    async read() {
      return (await ddb.send(new cmds.GetCommand({ TableName: table, Key: OTD_INDEX_KEYS, ConsistentRead: true }))).Item;
    },

    /** Takes the build lease. Returns the lease token (its expiry, ms) or null when somebody else holds a live one. Creates a body-less item when none exists. */
    async lease() {
      const at = now();
      const until = at + LEASE_MS;
      try {
        await ddb.send(new cmds.UpdateCommand({
          TableName: table, Key: OTD_INDEX_KEYS, UpdateExpression: "SET buildingUntil = :until",
          ConditionExpression: "attribute_not_exists(buildingUntil) OR buildingUntil < :now",
          ExpressionAttributeValues: { ":until": until, ":now": at },
        }));
        return until;
      } catch (e) {
        if (isCondition(e)) return null;
        throw e;
      }
    },

    /** Stores a built index under the lease `mine`. Returns false when the lease was lost (the item is then left to the new holder). Throws index_too_large past the item budget. */
    async put(index, mine) {
      const body = encodeBody(index);
      if (body.length > MAX_COMPRESSED_BYTES) throw Object.assign(new Error("index too large"), { code: "index_too_large" });
      try {
        await ddb.send(new cmds.PutCommand({
          TableName: table,
          Item: { ...OTD_INDEX_KEYS, entity: "otd-index", schema: index.schema, sourceVersion: index.sourceVersion, policyVersion: index.policyVersion, generatedAt: index.generatedAt, body, size: body.length },
          ConditionExpression: "buildingUntil = :mine", ExpressionAttributeValues: { ":mine": mine },
        }));
        return true;
      } catch (e) {
        if (isCondition(e)) return false;
        throw e;
      }
    },
  };
}
