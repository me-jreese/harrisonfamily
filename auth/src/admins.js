// Who the admins are and where to reach them, for the "someone asked to join" notices (surfaces.md 7.2, "Admin email addresses").
// Principals are the gramps_ids in config/admins.json. Their addresses are computed by inverting the allowlist: the S3 file (email ->
// gramps_id) plus the DynamoDB ALLOW# items through GSI1PK = ALLOWSUB#<sub>. First match per sub (the smallest live address), sorted.
// An ALLOW# item of either state overrides the file for its email, as everywhere else (shared/allowlist-store.mjs).
// Nothing here logs an address: failures are a fixed label and an error name.
import { emailOfAllowItem, isActiveAllowItem, listAllowBySub, normalizeAllowEmail } from "./shared/allowlist-store.mjs";

/** At most this many admins are notified (a bound on reads and mail per request; the family has a handful). */
export const MAX_ADMINS = 20;

const errName = (e) => (e instanceof Error && e.name ? e.name : "error");

/**
 * - `readAdmins()` returns the text of config/admins.json (a JSON array of gramps_ids, or { admins: [...] }).
 * - `readEntries()` returns the S3 allowlist as a Map email -> { sub } (the kit's parseAllowlist of config/userGrampsID.json).
 * - `ddb`, `cmds`, `table` are the DocumentClient, its command classes and the app table; without them only the file decides.
 * Both answers are cached for `ttlMs`; a failure is never cached and answers an empty list (the notice is best effort).
 */
export function createAdminDirectory({ readAdmins, readEntries, ddb, cmds, table, ttlMs = 60_000, now = () => Date.now(), log = console }) {
  let cachedPrincipals = { at: -Infinity, list: [] };
  let cachedEmails = { at: -Infinity, list: [] };

  async function principals() {
    if (now() - cachedPrincipals.at < ttlMs) return cachedPrincipals.list;
    try {
      const a = JSON.parse(await readAdmins());
      const raw = Array.isArray(a) ? a : Array.isArray(a?.admins) ? a.admins : [];
      const list = [...new Set(raw.filter((x) => typeof x === "string" && x.trim()).map((x) => x.trim()))].sort().slice(0, MAX_ADMINS);
      cachedPrincipals = { at: now(), list };
      return list;
    } catch (e) {
      log.error?.(JSON.stringify({ msg: "admin list unavailable", error: errName(e) }));
      return [];
    }
  }

  async function emails() {
    if (now() - cachedEmails.at < ttlMs) return cachedEmails.list;
    try {
      const subs = await principals();
      if (!subs.length) return [];
      const entries = await readEntries();
      const out = new Set();
      for (const sub of subs) {
        const items = ddb ? await listAllowBySub(ddb, cmds, table, sub) : [];
        const overridden = new Set(items.map(emailOfAllowItem));
        const live = items.filter(isActiveAllowItem).map(emailOfAllowItem);
        for (const [email, p] of entries ?? []) if (p?.sub === sub && !overridden.has(normalizeAllowEmail(email))) live.push(normalizeAllowEmail(email));
        const first = [...new Set(live)].sort()[0];
        if (first) out.add(first);
      }
      const list = [...out].sort();
      cachedEmails = { at: now(), list };
      return list;
    } catch (e) {
      log.error?.(JSON.stringify({ msg: "admin addresses unavailable", error: errName(e) }));
      return [];
    }
  }

  return { principals, emails };
}
