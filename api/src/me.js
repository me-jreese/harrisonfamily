// GET /api/me (HFY-TSK-237): the one identity route for every domain. The server computes every capability from actor.admin
// (config/admins.json, src/auth.js); no client infers admin from can.delete. The shape is additive-only: later tasks add fields
// (edit-api-core: ownRecord, editing), never rename or remove one.
// Gate exemption (BRD2 10.1, api-feature-gate): /api/me is exempt from the feature gate, because every surface reads it to
// learn identity and capabilities before it knows which flags are on. routes.js declares it with gateExempt, the only exemption
// test/features.test.js allows.

/** Pending access requests: GSI1 partition ACCESSREQS#pending, counted (Select COUNT) across every page. An empty partition is 0.
 * `pageSize` (optional) sets the query Limit; production leaves it to DynamoDB's own 1 MB page. */
export async function countPendingAccessRequests({ ddb, cmds, table, pageSize }) {
  let n = 0;
  let key;
  do {
    const r = await ddb.send(new cmds.QueryCommand({
      TableName: table, IndexName: "GSI1", KeyConditionExpression: "GSI1PK = :pk", ExpressionAttributeValues: { ":pk": "ACCESSREQS#pending" },
      Select: "COUNT", ...(pageSize ? { Limit: pageSize } : {}), ...(key ? { ExclusiveStartKey: key } : {}),
    }));
    n += r.Count ?? 0;
    key = r.LastEvaluatedKey;
  } while (key);
  return n;
}

/** Server-computed capabilities. Today all three follow actor.admin (HFY-R17); each is its own key so they can diverge later. */
export const capabilitiesFor = (actor) => ({ moderate: actor.admin === true, graduate: actor.admin === true, approve: actor.admin === true });

/**
 * `extras(actor)` is the additive extension point: later tasks merge their fields in, and the core keys below always win.
 * A badge failure (throttle, missing index permission) is logged and the badge omitted: /me is the identity route for every
 * surface, so it must still say who you are and what you can do.
 */
export async function buildMe(actor, { accessRequestCount, log, extras }) {
  const admin = actor.admin === true;
  let badges;
  if (admin) {
    try {
      badges = { accessRequests: await accessRequestCount() };
    } catch (e) {
      log?.error?.("me: access-request badge failed, omitted", e instanceof Error ? e.message : String(e));
    }
  }
  return {
    ...(extras ? await extras(actor) : {}),
    id: actor.id,
    label: actor.label,
    admin,
    can: capabilitiesFor(actor),
    ...(badges ? { badges } : {}),
  };
}
