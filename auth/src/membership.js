// Who may hold an MCP token, and with which groups: the email -> gramps_id allowlist (members) plus config/admins.json (admins).
import { parseAllowlist } from "@io-kit/auth/edge/deploy";

/** Returns async (sub) => string[] | null (null = not on the allowlist). Fails closed when no copy of the allowlist was ever loaded. */
export function createMembership({ readAllowlist, readAdmins, ttlMs = 60_000, now = () => Date.now(), log = console }) {
  let cache = { at: -Infinity, bySub: new Map(), admins: new Set() };
  async function load() {
    if (now() - cache.at < ttlMs) return cache;
    try {
      const bySub = new Map();
      for (const p of parseAllowlist(await readAllowlist()).values()) bySub.set(p.sub, (p.roles ?? []).filter((r) => r !== "member")); // "member" is the kit default role; the group is "members"
      let admins = new Set();
      try {
        const a = JSON.parse(await readAdmins());
        admins = new Set((Array.isArray(a) ? a : Array.isArray(a?.admins) ? a.admins : []).filter((x) => typeof x === "string"));
      } catch (e) { log.error?.("admin list unavailable (nobody is admin)", e instanceof Error ? e.message : String(e)); }
      cache = { at: now(), bySub, admins };
    } catch (e) {
      log.error?.("allowlist unavailable", e instanceof Error ? e.message : String(e));
      if (cache.at === -Infinity) throw e;
      cache = { ...cache, at: now() - ttlMs + 5_000 }; // keep serving the last good copy, retry in 5 s
    }
    return cache;
  }
  return async (sub) => {
    const c = await load();
    const roles = c.bySub.get(sub);
    return roles ? [...new Set(["members", ...roles, ...(c.admins.has(sub) ? ["admins"] : [])])] : null;
  };
}
