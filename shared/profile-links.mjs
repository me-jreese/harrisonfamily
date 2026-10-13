// Profile links (HFY-PLN-002 surfaces.md section 6.2, D2-22; task surf-links-validator): the single validator for the API and
// the editor. Per-platform URL and handle checks, canonical URLs, and R-17: the website field rejects every host of the six
// platforms. Contact channels are refused in every field and the R-18 detector (privacy-guard.mjs) runs on handles and URL
// paths. Pure ESM with relative imports only; WHATWG URL is the one global it uses (Node, browsers and Workers all have it).
import { KINDS, isContactChannel, matchesDomain, scanText, CONTACT_SCHEMES } from "./privacy-guard.mjs";
import { isRecord } from "./validate.mjs";

/** The editor's field order (surfaces.md 6.4). */
export const PLATFORMS = Object.freeze(["facebook", "instagram", "snapchat", "tiktok", "linktree", "linkedin", "website"]);
export const ERROR_CODES = Object.freeze([
  "invalid_url", "scheme_not_allowed", "wrong_platform", "not_a_profile", "short_link", "contact_channel", "contact_info",
  "too_long", "invalid_handle",
]);
export const MAX_LENGTH = 300;

/** Every domain of each platform, profile, short, CDN and corporate hosts alike: the website field refuses all of them (R-17). */
export const PLATFORM_DOMAINS = Object.freeze({
  facebook: Object.freeze(["facebook.com", "fb.com", "fb.me", "fb.watch", "facebook.net", "fbcdn.net", "fbsbx.com"]),
  instagram: Object.freeze(["instagram.com", "instagr.am", "cdninstagram.com"]),
  tiktok: Object.freeze(["tiktok.com", "tiktokv.com", "tiktokcdn.com"]),
  snapchat: Object.freeze(["snapchat.com", "snap.com"]),
  linkedin: Object.freeze(["linkedin.com", "lnkd.in", "linkedin.cn", "licdn.com"]),
  linktree: Object.freeze(["linktr.ee", "linktree.com"]),
});
/** Generic shorteners, refused in every field: a short link hides where it goes, and resolving it would be an outbound fetch. */
export const SHORTENERS = Object.freeze([
  "bit.ly", "tinyurl.com", "t.co", "ow.ly", "buff.ly", "rebrand.ly", "is.gd", "cutt.ly", "shorturl.at", "goo.gl", "s.id",
]);
// Platform short, share and link-shim hosts, and share paths on profile hosts ([domain, first path segment]).
const SHORT_HOSTS = ["fb.me", "fb.watch", "l.facebook.com", "lm.facebook.com", "instagr.am", "vm.tiktok.com", "vt.tiktok.com",
  "t.snapchat.com", "lnkd.in"];
const SHORT_PATHS = [["tiktok.com", "t"], ["facebook.com", "share"], ["instagram.com", "share"]];

const PROFILE_HOSTS = {
  facebook: (h) => ["facebook.com", "www.facebook.com", "m.facebook.com", "mbasic.facebook.com", "touch.facebook.com", "web.facebook.com"].includes(h),
  instagram: (h) => ["instagram.com", "www.instagram.com", "m.instagram.com"].includes(h),
  tiktok: (h) => ["tiktok.com", "www.tiktok.com", "m.tiktok.com"].includes(h),
  snapchat: (h) => ["snapchat.com", "www.snapchat.com"].includes(h),
  linkedin: (h) => h === "linkedin.com" || h === "www.linkedin.com" || /^[a-z]{2}\.linkedin\.com$/.test(h),
  linktree: (h) => ["linktr.ee", "www.linktr.ee", "linktree.com", "www.linktree.com"].includes(h),
};
const HANDLE = {
  facebook: /^[A-Za-z0-9.]{5,50}$/,
  instagram: /^[A-Za-z0-9._]{1,30}$/,
  tiktok: /^[A-Za-z0-9._]{2,24}$/,
  snapchat: /^[A-Za-z][A-Za-z0-9._-]{2,14}$/,
  linkedin: /^[A-Za-z0-9-]{3,100}$/,
  linktree: /^[A-Za-z0-9._]{2,30}$/,
};
// First path segments that are product pages, not people.
const RESERVED = {
  facebook: ["groups", "pages", "events", "watch", "sharer", "sharer.php", "story.php", "permalink.php", "photo.php", "photo",
    "photos", "video.php", "videos", "reel", "reels", "stories", "marketplace", "gaming", "hashtag", "login", "login.php",
    "home.php", "settings", "help", "policies", "privacy", "legal", "notifications", "friends", "bookmarks", "saved", "search",
    "l.php", "dialog", "plugins", "business", "ads", "media", "fundraisers", "live", "posts", "people", "profile.php", "p"],
  instagram: ["p", "reel", "reels", "explore", "accounts", "stories", "m", "direct", "share", "tv", "about", "legal"],
  tiktok: ["t", "discover", "explore", "tag", "music", "live", "foryou", "following", "login", "signup", "upload"],
  snapchat: ["add", "t", "discover", "spotlight", "lens", "unlock"],
  linkedin: [],
  linktree: ["s", "login", "register", "signup", "admin", "pricing", "blog", "help", "templates", "features", "about", "terms",
    "privacy", "marketplace", "discover"],
};
// Schemes that are never a web page; any other "x:" without "//" is read as a bare host (example.org:8080 is a host with a port).
const OTHER_SCHEMES = ["javascript", "data", "vbscript", "file", "ftp", "ftps", "sftp", "blob", "about", "chrome", "ws", "wss",
  "intent", "market", "content", "ssh", "irc", "git", "news", "nntp", "gopher", "ldap", "view-source", "http", "https"];
const COMMON_TLDS = ["com", "org", "net", "edu", "gov", "mil", "int", "io", "co", "us", "uk", "ca", "au", "nz", "de", "fr", "nl",
  "es", "it", "me", "info", "biz", "app", "dev", "ly", "ee", "am", "gl", "gd", "in", "cn", "tv", "xyz", "site", "online", "page",
  "blog", "link", "ie", "ch", "se", "no", "dk", "fi", "be", "at", "jp", "br", "mx"];
const CONTACT_INFO_KINDS = KINDS.filter((k) => k !== "dob_heuristic" && k !== "contact_url");

const fail = (code, suggest) => (suggest ? { ok: false, code, suggest } : { ok: false, code });
const ownerOf = (host) => Object.keys(PLATFORM_DOMAINS).find((p) => PLATFORM_DOMAINS[p].some((d) => matchesDomain(host, d))) || null;
const isShort = (host, seg) => SHORT_HOSTS.some((d) => matchesDomain(host, d)) || SHORT_PATHS.some(([d, s]) => seg === s && matchesDomain(host, d));
/** R-18: a phone number, email, street address or PO box in a handle or path is refused (matched text never leaves here). */
const hasContactInfo = (text) => scanText(text, { kinds: CONTACT_INFO_KINDS }).length > 0;

function isLocalOrIp(host) {
  if (host.startsWith("[") || /^[0-9]+(?:\.[0-9]+){3}$/.test(host)) return true; // URL has already normalized 0x7f.1 to 127.0.0.1
  if (!host.includes(".")) return true; // a single label is never a public host
  return host === "localhost" || ["localhost", "local", "internal", "home.arpa"].some((s) => host.endsWith("." + s) || host === s);
}

/** A bare token (no "/" or ":") that names a host rather than a handle: wa.me, ig.com, example.org; but not jane.doe. */
function looksLikeHost(raw) {
  if (!raw.includes(".")) return false;
  const host = raw.toLowerCase().replace(/\.+$/, "");
  const known = [...Object.values(PLATFORM_DOMAINS).flat(), ...SHORTENERS];
  if (known.some((d) => matchesDomain(host, d)) || isContactChannel(host)) return true;
  return COMMON_TLDS.includes(host.slice(host.lastIndexOf(".") + 1));
}

function canonical(platform, h) {
  switch (platform) {
    case "facebook": return `https://www.facebook.com/${h}`;
    case "instagram": return `https://www.instagram.com/${h}/`;
    case "tiktok": return `https://www.tiktok.com/@${h}`;
    case "snapchat": return `https://www.snapchat.com/@${h}`;
    case "linkedin": return `https://www.linkedin.com/in/${h}`;
    case "linktree": return `https://linktr.ee/${h}`;
  }
  throw new TypeError(`no canonical form for ${platform}`);
}

function handleResult(platform, h) {
  if (hasContactInfo(h)) return fail("contact_info");
  if (!HANDLE[platform].test(h)) return fail("invalid_handle");
  if (RESERVED[platform].includes(h.toLowerCase())) return fail("not_a_profile");
  return { ok: true, url: canonical(platform, h), handle: h };
}

/** The profile behind a URL on a platform's profile host: segs are the decoded path segments, params the query. */
function profileResult(platform, segs, params) {
  const one = segs.length === 1 ? segs[0] : null;
  switch (platform) {
    case "facebook": {
      if (one === "profile.php") {
        const id = params.get("id") || "";
        return /^[0-9]{1,20}$/.test(id) ? { ok: true, url: `https://www.facebook.com/profile.php?id=${id}`, handle: id } : fail("not_a_profile");
      }
      if (segs.length === 3 && segs[0] === "people" && /^[0-9]{1,20}$/.test(segs[2])) {
        if (hasContactInfo(segs[1])) return fail("contact_info");
        return { ok: true, url: `https://www.facebook.com/profile.php?id=${segs[2]}`, handle: segs[2] };
      }
      return one ? handleResult(platform, one) : fail("not_a_profile");
    }
    case "instagram":
    case "linktree":
      return one ? handleResult(platform, one) : fail("not_a_profile");
    case "tiktok":
      return one && one.startsWith("@") ? handleResult(platform, one.slice(1)) : fail("not_a_profile");
    case "snapchat":
      if (segs.length === 2 && segs[0].toLowerCase() === "add") return handleResult(platform, segs[1]);
      return one && one.startsWith("@") ? handleResult(platform, one.slice(1)) : fail("not_a_profile");
    case "linkedin": {
      const kind = (segs[0] || "").toLowerCase();
      if (kind === "in" && segs.length === 2) return handleResult(platform, segs[1]);
      // legacy public profiles: /pub/<name>/<x>/<y>/<z>, the groups being short base-36 ids (never read as a phone number)
      if (kind === "pub" && segs.length >= 2 && segs.length <= 5 && segs.slice(2).every((s) => /^[0-9a-z]{1,3}$/i.test(s))) {
        if (hasContactInfo(segs[1])) return fail("contact_info");
        if (!HANDLE.linkedin.test(segs[1])) return fail("invalid_handle");
        return { ok: true, url: `https://www.linkedin.com/pub/${segs.slice(1).join("/")}`, handle: segs[1] };
      }
      return fail("not_a_profile"); // /company/ (SURF-D8), /school/, /feed/, ...
    }
  }
  return fail("not_a_profile");
}

function urlResult(platform, raw) {
  const scheme = /^([A-Za-z][A-Za-z0-9+.\-]*):/.exec(raw);
  const hasScheme = scheme && (raw.slice(scheme[0].length).startsWith("//") || OTHER_SCHEMES.includes(scheme[1].toLowerCase()));
  let u;
  try {
    u = new URL(hasScheme ? raw : `https://${raw}`);
  } catch {
    return fail("invalid_url");
  }
  if (u.protocol !== "https:" && u.protocol !== "http:") return fail("scheme_not_allowed");
  if (u.username || u.password || u.port) return fail("invalid_url"); // userinfo (facebook.com@evil.example), non-default ports
  const host = u.hostname.toLowerCase().replace(/\.+$/, "");
  if (!host || isLocalOrIp(host)) return fail("invalid_url");
  let path, query, hash;
  try {
    path = decodeURIComponent(u.pathname);
    query = decodeURIComponent(u.search);
    hash = decodeURIComponent(u.hash);
  } catch {
    return fail("invalid_url");
  }
  const segs = path.replace(/^\/+/, "").replace(/\/$/, "").split("/").filter((s, i, all) => s !== "" || all.length > 1);
  const seg = (segs[0] || "").toLowerCase();
  if (isContactChannel(host, path)) return fail("contact_channel");
  if (SHORTENERS.some((d) => matchesDomain(host, d)) || isShort(host, seg)) return fail("short_link");
  const owner = ownerOf(host);
  if (platform === "website") {
    if (owner) return fail("wrong_platform", owner);
    // a contact link carried in the path, query or fragment (example.org/?u=wa.me/...) is still a contact channel
    if (scanText(`${path} ${query} ${hash}`, { kinds: ["contact_url"] }).length) return fail("contact_channel");
    // the whole URL is scanned, so the detector's own URL rules apply: /555-010-0123 is refused, /blog/12345678 is an id
    if (hasContactInfo(`${host}${path}${query}${hash}`)) return fail("contact_info");
    return { ok: true, url: `${u.protocol}//${host}${u.pathname}${u.search}${u.hash}`, host };
  }
  if (!owner) return fail("wrong_platform", "website");
  if (owner !== platform) return fail("wrong_platform", owner);
  if (!PROFILE_HOSTS[platform](host)) return fail("not_a_profile"); // CDN, corporate and other subdomains
  if (segs.some((s) => s === "")) return fail("not_a_profile");
  return profileResult(platform, segs, u.searchParams);
}

/**
 * One field: `{ ok: true, url, handle }` for a platform, `{ ok: true, url, host }` for the website (host is ASCII, punycode for
 * an IDN), or `{ ok: false, code, suggest? }` with a code from ERROR_CODES; `suggest` names the field a link belongs in.
 * @param {string} platform one of PLATFORMS
 * @param {string} input a URL, a bare host, or (platforms only) a handle such as @name
 */
export function validateLink(platform, input) {
  if (!PLATFORMS.includes(platform)) throw new TypeError(`validateLink: unknown platform ${String(platform)}`);
  if (typeof input !== "string") return fail("invalid_url");
  const raw = input.trim();
  if (!raw) return fail("invalid_url");
  if (raw.length > MAX_LENGTH) return fail("too_long");
  const scheme = /^([A-Za-z][A-Za-z0-9+.\-]*):/.exec(raw);
  if (scheme && CONTACT_SCHEMES.includes(scheme[1].toLowerCase())) return fail("contact_channel"); // mailto:, tel:, sms:, ...
  if (!raw.includes("/") && !raw.includes(":") && hasContactInfo(raw)) return fail("contact_info"); // a bare phone number or email
  if (platform !== "website") {
    if (raw.startsWith("@")) return handleResult(platform, raw.slice(1));
    if (!raw.includes("/") && !raw.includes(":") && !looksLikeHost(raw)) return handleResult(platform, raw);
  }
  return urlResult(platform, raw);
}

/**
 * Every field of a `{platform: string | null}` map: `{ ok: true, links }` where a null, missing or blank value clears the field
 * (`links[platform] = null`), or `{ ok: false, fields: [{field, code, suggest?}] }` (the API's 422 details.fields).
 */
export function validateLinks(map) {
  if (!isRecord(map)) throw new TypeError("validateLinks: expected an object of platform -> link");
  const links = {};
  const fields = [];
  for (const [field, value] of Object.entries(map)) {
    if (!PLATFORMS.includes(field)) {
      fields.push({ field, code: "unknown_platform" });
      continue;
    }
    if (value === null || value === undefined || (typeof value === "string" && value.trim() === "")) {
      links[field] = null;
      continue;
    }
    const r = validateLink(field, value);
    if (r.ok) links[field] = field === "website" ? { url: r.url, host: r.host } : { url: r.url, handle: r.handle };
    else fields.push(r.suggest ? { field, code: r.code, suggest: r.suggest } : { field, code: r.code });
  }
  return fields.length ? { ok: false, fields } : { ok: true, links };
}
