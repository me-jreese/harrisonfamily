// GET /api/me (HFY-TSK-237): the one identity route for every domain. The server computes every capability from actor.admin
// (config/admins.json, src/auth.js); no client infers admin from can.delete. The shape is additive-only: later tasks add fields
// (edit-api-core: ownRecord, editing), never rename or remove one.

/** Pending access requests: GSI1 partition ACCESSREQS#pending, counted (Select COUNT) across pages. An empty partition is 0. */
export async function countPendingAccessRequests({ ddb, cmds, table }) {
  let n = 0;
  let key;
  for (let i = 0; i < 100; i += 1) {
    const r = await ddb.send(new cmds.QueryCommand({
      TableName: table, IndexName: "GSI1", KeyConditionExpression: "GSI1PK = :pk", ExpressionAttributeValues: { ":pk": "ACCESSREQS#pending" },
      Select: "COUNT", ...(key ? { ExclusiveStartKey: key } : {}),
    }));
    n += r.Count ?? 0;
    key = r.LastEvaluatedKey;
    if (!key) break;
  }
  return n;
}

/** Server-computed capabilities. Today all three follow actor.admin (HFY-R17); each is its own key so they can diverge later. */
export const capabilitiesFor = (actor) => ({ moderate: actor.admin === true, graduate: actor.admin === true, approve: actor.admin === true });

export async function buildMe(actor, { accessRequestCount }) {
  const admin = actor.admin === true;
  return {
    id: actor.id,
    label: actor.label,
    admin,
    can: capabilitiesFor(actor),
    ...(admin ? { badges: { accessRequests: await accessRequestCount() } } : {}),
  };
}
