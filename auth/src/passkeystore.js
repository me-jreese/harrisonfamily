// Passkey credential store for hfy-app (HFY-R67; the HFY-R58 ruling 6 defect, for PASSKEY# items). The kit's ddbPasskeyStore writes
// PASSKEY#<credentialId> items with GSI1PK = PASSKEYSUB#<sub> and no GSI1SK, but GSI1 in infrastructure/cloudformation/app-stack.yaml is
// keyed GSI1PK (HASH) + GSI1SK (RANGE). DynamoDB leaves an item out of a GSI unless it carries every key attribute, so listByPrincipal
// always returned []: no passkey list or Remove button on /auth/link, empty excludeCredentials, no per-member limit, no allowCredentials.
// This wraps the kit store's client so every credential item is written with GSI1SK = its PK (unique within the PASSKEYSUB#<sub>
// partition). An item written before the fix gets GSI1SK the next time it is read (every passkey sign-in and removal reads its
// credential). Backfilling PASSKEY# items that were written earlier is a deploy step (none exist live: passkeys ship in this release).
import { ddbPasskeyStore } from "@io-kit/auth/server";

export const PASSKEY_PREFIX = "PASSKEY#"; // challenges are PASSKEYCHAL#<challenge>, carry no GSI1PK and are never indexed
const isCredential = (item) => !!item && typeof item.PK === "string" && item.PK.startsWith(PASSKEY_PREFIX) && typeof item.GSI1PK === "string";
/** The GSI1 sort key of a credential item: its own PK. */
export const withPasskeySortKey = (item) => (isCredential(item) ? { ...item, GSI1SK: item.PK } : item);

/** `client` is the kit's `{get, put, query, delete, update}` (ddbFromDocumentClient with DeleteCommand and UpdateCommand). */
export function hfyPasskeyStore({ client, tableName, gsiName = "GSI1", log = console }) {
  const indexed = {
    async get(input) {
      const r = await client.get(input);
      const it = r?.Item;
      if (isCredential(it) && it.GSI1SK === undefined && client.update) {
        try {
          // Adds only the index key; never rewrites `rec`, so a concurrent sign-in's signature-counter update is not undone.
          await client.update({
            TableName: input.TableName,
            Key: { PK: it.PK, SK: it.SK },
            UpdateExpression: "SET GSI1SK = :sk",
            ConditionExpression: "attribute_exists(PK) AND attribute_not_exists(GSI1SK)",
            ExpressionAttributeValues: { ":sk": it.PK },
          });
        } catch (e) {
          if (e?.name !== "ConditionalCheckFailedException") log.error?.(JSON.stringify({ msg: "passkey index backfill failed", error: e instanceof Error ? e.message : String(e) }));
        }
      }
      return r;
    },
    put: (input) => client.put(input?.Item ? { ...input, Item: withPasskeySortKey(input.Item) } : input),
    query: (input) => client.query(input),
    ...(client.delete ? { delete: (input) => client.delete(input) } : {}),
    ...(client.update ? { update: (input) => client.update(input) } : {}),
  };
  return ddbPasskeyStore({ client: indexed, tableName, gsiName });
}
