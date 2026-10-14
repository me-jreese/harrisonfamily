// Who may hold an MCP token, and with which groups: the composite allowlist (io's S3 email -> gramps_id file plus DynamoDB ALLOW# items,
// HFY-TSK-134) for members, plus config/admins.json for admins.
import { parseAllowlist } from "@io-kit/auth/edge/deploy";
import { createCompositeMemberReader } from "./shared/allowlist-store.mjs";

/**
 * Returns async (sub) => string[] | null (null = not on the allowlist). Fails closed when no copy of the S3 allowlist was ever loaded and
 * no active ALLOW# item decides it. Pass `ddb`, `cmds` and `table` to read the DynamoDB grants; without them the S3 file alone decides.
 */
export function createMembership({ readAllowlist, readAdmins, ddb, cmds, table, ttlMs = 60_000, now = () => Date.now(), log = console }) {
  const member = createCompositeMemberReader({ readEntries: async () => parseAllowlist(await readAllowlist()), ddb, cmds, table, ttlMs, now, log });
  let admins = { at: -Infinity, set: new Set() };
  async function loadAdmins() {
    if (now() - admins.at < ttlMs) return admins.set;
    let set = new Set();
    try {
      const a = JSON.parse(await readAdmins());
      set = new Set((Array.isArray(a) ? a : Array.isArray(a?.admins) ? a.admins : []).filter((x) => typeof x === "string"));
    } catch (e) { log.error?.("admin list unavailable (nobody is admin)", e instanceof Error ? e.message : String(e)); }
    admins = { at: now(), set };
    return set;
  }
  return async (sub) => {
    const m = await member(sub); // "member" is the kit default role; the group is "members"
    if (!m) return null;
    return [...new Set(["members", ...m.roles, ...((await loadAdmins()).has(sub) ? ["admins"] : [])])];
  };
}
