// Link store for hfy-app (HFY-R58 ruling 6). The kit's ddbLinkStore writes LINK#<email> items with GSI1PK only, but GSI1 in
// infrastructure/cloudformation/app-stack.yaml is keyed GSI1PK (HASH) + GSI1SK (RANGE): DynamoDB leaves an item out of a GSI
// unless it carries every key attribute, so getBySub never found a link. This wraps the kit store's client so every LINK# item
// is written with GSI1SK = its PK, and heals items written before this fix the next time they are read (each sign-in reads one).
import { ddbLinkStore } from "@io-kit/auth/server";

export const LINK_PREFIX = "LINK#";
const isLink = (item) => !!item && typeof item.PK === "string" && item.PK.startsWith(LINK_PREFIX);
/** The GSI1 sort key of a link item: its own PK, unique within the SUB#<sub> partition. */
export const withLinkSortKey = (item) => (isLink(item) && typeof item.GSI1PK === "string" ? { ...item, GSI1SK: item.PK } : item);

/** `client` is the kit's `{get, put, query}` (ddbFromDocumentClient). */
export function hfyLinkStore({ client, tableName, gsiName = "GSI1", log = console }) {
  const indexed = {
    async get(input) {
      const r = await client.get(input);
      const it = r?.Item;
      if (isLink(it) && typeof it.GSI1PK === "string" && it.GSI1SK === undefined) {
        try {
          // conditional: never overwrite a newer write (which already carries GSI1SK)
          await client.put({ TableName: input.TableName, Item: withLinkSortKey(it), ConditionExpression: "attribute_exists(PK) AND attribute_not_exists(GSI1SK)" });
        } catch (e) {
          if (e?.name !== "ConditionalCheckFailedException") log.error?.(JSON.stringify({ msg: "link index backfill failed", error: e instanceof Error ? e.message : String(e) }));
        }
      }
      return r;
    },
    put: (input) => client.put(input?.Item ? { ...input, Item: withLinkSortKey(input.Item) } : input),
    query: (input) => client.query(input),
  };
  return ddbLinkStore({ client: indexed, tableName, gsiName });
}
