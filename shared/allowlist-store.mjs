// The read side of the DynamoDB allowlist (HFY-TSK-134, surfaces.md 7.6, Q2-10). One item per approved email:
//   PK ALLOW#<normalized email>, SK META, { sub, state: "active" | "revoked", source, requestId?, at, by },
//   GSI1PK ALLOWSUB#<sub>, GSI1SK ALLOW#<email>.
// Precedence, everywhere: a DynamoDB item wins over io's S3 file, active or revoked. An email with no item is decided by the S3 file.
// The client and the command classes are injected (`ddb.send(new cmds.GetCommand(...))`), so this file imports nothing (shared/ contract).
// auth/src/allowlist.js (the sign-in resolver), auth/src/membership.js (MCP groups) and api/src/allowlist-store.js (the grant and revoke
// writes, and any later reader such as the chat directory) all build on it.

export const ALLOW_PREFIX = "ALLOW#";
export const ALLOWSUB_PREFIX = "ALLOWSUB#";

/** The kit's normalizeEmail (trim, lower-case), repeated here because shared/ takes no dependency. */
export const normalizeAllowEmail = (email) => String(email ?? "").trim().toLowerCase();

export const allowKeys = (email) => ({ PK: `${ALLOW_PREFIX}${normalizeAllowEmail(email)}`, SK: "META" });
export const allowSubKey = (sub) => `${ALLOWSUB_PREFIX}${sub}`;

/** The normalized email of an ALLOW# item, or undefined for any other item. */
export const emailOfAllowItem = (item) => (typeof item?.PK === "string" && item.PK.startsWith(ALLOW_PREFIX) ? item.PK.slice(ALLOW_PREFIX.length) : undefined);

/**
 * An item grants access at `nowMs` only when it is active, names a principal, and has taken effect. `effectiveAt` (an ISO time) is set on a SECOND
 * email for a member who already has access (surf-access-admin-api, review PS-13): the grant counts 72 hours after an admin allows it, unless the
 * member confirms it sooner (the admin API removes `effectiveAt`) or objects (the item is revoked). A malformed `effectiveAt` never grants.
 */
export function isAllowedNow(item, nowMs) {
  if (item?.state !== "active" || typeof item.sub !== "string" || item.sub.length === 0) return false;
  if (item.effectiveAt === undefined || item.effectiveAt === null) return true;
  const at = typeof item.effectiveAt === "string" ? Date.parse(item.effectiveAt) : Number.NaN;
  return Number.isFinite(at) && at <= nowMs;
}

/** isAllowedNow on the real clock. Safe as a bare callback (`items.filter(isActiveAllowItem)`): it takes the item alone. */
export const isActiveAllowItem = (item) => isAllowedNow(item, Date.now());

/** The host principal a granted item resolves to (the kit's HostPrincipal shape; DynamoDB grants carry the member role only). */
export const allowPrincipal = (item, email) => ({ sub: item.sub, label: normalizeAllowEmail(email), roles: ["member"], claims: {} });

/**
 * Strongly consistent GetItem of ALLOW#<email>: the item, or undefined when there is none. Rejects when DynamoDB fails; the caller
 * decides what a failure means (the resolver falls back to the S3 file, see auth/src/allowlist.js).
 */
export async function readAllowEntry(ddb, cmds, table, email) {
  const r = await ddb.send(new cmds.GetCommand({ TableName: table, Key: allowKeys(email), ConsistentRead: true }));
  return r?.Item;
}

/** Every ALLOW# item of one principal, active and revoked, through GSI1 (`GSI1PK = ALLOWSUB#<sub>`). Bounded at 5 pages. */
export async function listAllowBySub(ddb, cmds, table, sub) {
  const items = [];
  let ExclusiveStartKey;
  for (let page = 0; page < 5; page += 1) {
    const r = await ddb.send(
      new cmds.QueryCommand({
        TableName: table,
        IndexName: "GSI1",
        KeyConditionExpression: "GSI1PK = :pk",
        ExpressionAttributeValues: { ":pk": allowSubKey(sub) },
        ...(ExclusiveStartKey ? { ExclusiveStartKey } : {}),
      }),
    );
    for (const it of r?.Items ?? []) if (emailOfAllowItem(it) !== undefined && it.SK === "META") items.push(it);
    ExclusiveStartKey = r?.LastEvaluatedKey;
    if (!ExclusiveStartKey) break;
  }
  return items;
}

/**
 * The composite member reader: `async (sub) => { roles } | null`, where `roles` are the S3 file's roles other than the kit default
 * "member". A principal is a member when either
 *   - one of its ALLOW# items is active, or
 *   - the S3 file lists one of its emails and no ALLOW# item exists for that email (an item of either state overrides the file).
 * `readEntries()` returns the S3 file as a Map email -> { sub, roles? } (the caller parses it, the kit's `parseAllowlist`). It is cached
 * for `ttlMs`; if a refresh fails the last good copy is served and retried in 5 s, and with no copy at all the call rejects (fail closed)
 * unless an active ALLOW# item already decides it. Each sub's items are cached for `ttlMs` too. A DynamoDB failure falls back to the S3
 * file alone (a hit stays a member, a miss is null) and is not cached. Omit `ddb` for an S3-only reader.
 *
 * A held second email (`effectiveAt` still ahead) is not active, so the principal stays a member through its other addresses only.
 *
 * Known limits, kept on purpose (docs/how-to/manage-family-access.md, "Allowlist grants in DynamoDB"):
 *   - Same-sub assumption. Items are found by the caller's sub through GSI1, so a revoked item whose sub differs from the sub the file lists
 *     for that email is invisible here: sign-in for the email is denied, but the file's sub keeps its groups. Grants and revokes
 *     are written with the member's own Gramps ID, so the subs match in practice.
 *   - An active item replaces the file's entry for its email outright: the file's extra roles (and label) are not merged, here or in the
 *     sign-in resolver, which builds the principal with the member role only.
 *   - GSI1 reads are eventually consistent and cached for `ttlMs`, so a grant or revoke reaches the groups after up to ~60 s plus index lag.
 *     Sign-in uses a strongly consistent GetItem and sees it at once.
 *   - On a DynamoDB failure the file alone decides, so a revoked email still listed in the file is a member again until the table recovers.
 */
export function createCompositeMemberReader({ readEntries, ddb, cmds, table, ttlMs = 60_000, now = () => Date.now(), log = console, maxSubs = 2000 }) {
  let file = { at: -Infinity, bySub: new Map() };
  const items = new Map(); // sub -> { at, list }

  async function loadFile() {
    if (now() - file.at < ttlMs) return { bySub: file.bySub };
    try {
      const bySub = new Map();
      for (const [email, p] of await readEntries()) {
        if (!p || typeof p.sub !== "string" || !p.sub) continue;
        if (!bySub.has(p.sub)) bySub.set(p.sub, []);
        bySub.get(p.sub).push({ email: normalizeAllowEmail(email), roles: Array.isArray(p.roles) ? p.roles : [] });
      }
      file = { at: now(), bySub };
    } catch (e) {
      log.error?.("allowlist unavailable", e instanceof Error ? e.message : String(e));
      if (file.at === -Infinity) return { bySub: new Map(), error: e };
      file = { ...file, at: now() - ttlMs + 5_000 }; // keep serving the last good copy, retry in 5 s
    }
    return { bySub: file.bySub };
  }

  async function loadItems(sub) {
    if (!ddb) return undefined;
    const hit = items.get(sub);
    if (hit && now() - hit.at < ttlMs) return hit.list;
    try {
      const list = await listAllowBySub(ddb, cmds, table, sub);
      if (items.size >= maxSubs) items.clear();
      items.set(sub, { at: now(), list });
      return list;
    } catch (e) {
      log.error?.("allowlist table unavailable (the file decides)", e instanceof Error ? e.name : "error");
      return undefined;
    }
  }

  return async (sub) => {
    const [{ bySub, error }, list] = await Promise.all([loadFile(), loadItems(sub)]);
    const rows = list ?? [];
    const overridden = new Set(rows.map(emailOfAllowItem));
    const live = (bySub.get(sub) ?? []).filter((x) => !overridden.has(x.email));
    if (!rows.some((r) => isAllowedNow(r, now())) && live.length === 0) {
      if (error) throw error;
      return null;
    }
    return { roles: [...new Set(live.flatMap((x) => x.roles).filter((r) => r !== "member"))] };
  };
}
