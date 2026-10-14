// The site's own flags file, read the way hfy-api reads it (api/src/features.js): GET https://<site>/_data/flags.json through CloudFront,
// cached for 60 s. When a read fails the last good value is kept for up to 10 minutes after the last success, then every flag is off
// (fail closed) until a read succeeds. The auth edge uses it for one thing: the persist-first inbox write behind `inboxV1` (BRD2 D2-28).
export const DEFAULT_FLAGS_URL = "https://harrisonfamily.us/_data/flags.json";
export const FLAGS_TTL_MS = 60_000;
export const FLAGS_MAX_STALE_MS = 600_000;
export const FLAGS_RETRY_MS = 5_000;
export const FLAGS_TIMEOUT_MS = 3_000;

export function createFlagReader({ url = DEFAULT_FLAGS_URL, fetch: fetchImpl = globalThis.fetch, now = () => Date.now(), log = console }) {
  let good = { at: -Infinity, flags: {} };
  let retryAt = -Infinity;
  async function load() {
    const t = now();
    if (t - good.at < FLAGS_TTL_MS) return good.flags;
    if (t < retryAt) return t - good.at < FLAGS_MAX_STALE_MS ? good.flags : {};
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), FLAGS_TIMEOUT_MS);
    try {
      const res = await fetchImpl(url, { signal: ctl.signal });
      if (!res?.ok) throw Object.assign(new Error("flags read failed"), { name: "FlagsHttpError" });
      const flags = await res.json();
      if (!flags || typeof flags !== "object" || Array.isArray(flags)) throw Object.assign(new Error("flags malformed"), { name: "FlagsMalformed" });
      good = { at: now(), flags };
      return flags;
    } catch (e) {
      retryAt = now() + FLAGS_RETRY_MS;
      log.error?.(JSON.stringify({ msg: "flags unavailable", error: e instanceof Error && e.name ? e.name : "error" }));
      return now() - good.at < FLAGS_MAX_STALE_MS ? good.flags : {};
    } finally {
      clearTimeout(timer);
    }
  }
  return { on: async (name) => (await load())[name] === true };
}
