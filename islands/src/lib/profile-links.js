// Profile links for the islands (HFY-TSK-217; HFY-PLN-002 surfaces 6.4, R-16 and R-17): the copy, the chip text and the editor's pure
// helpers. The validator is the one the API runs, shared/profile-links.mjs, bundled here: the editor's blur check and the API's 422
// give the same code for the same input. No DOM and no CSS in this file.
import { ERROR_CODES, PLATFORMS, validateLink } from "../../../shared/profile-links.mjs";

export { ERROR_CODES, PLATFORMS, validateLink };

export const LINKS_PATH = "/me/links/";
export const SECTION_TITLE = "links";
export const EDIT_LINKS = "edit links";
export const ADD_LINKS = "add your links";

/** The editor's words (DS voice: lowercase, no exclamation marks). */
export const EDITOR_COPY = Object.freeze({
  title: "your links",
  lede: "facebook, instagram and the rest, on your page. everyone in the family can see them.",
  hint: "@yourname, or the link to your profile",
  save: "save",
  saving: "saving…",
  saved: "saved",
  remove: "remove",
  moveIt: "move it",
  off: "your links aren't available yet.",
  noPerson: "we can't tell which page is yours yet. try again in a moment.",
  signedOut: "sign in to change your links.",
  conflict: "someone changed this a moment ago. here's the latest.",
  forbidden: "you can only change your own links.",
  failed: "that didn't work. try again.",
  loadFailed: "your links didn't load. try again.",
  loading: "loading",
  nothingToSave: "nothing to change yet."
});

export const PLATFORM_LABEL = Object.freeze({
  facebook: "facebook", instagram: "instagram", snapchat: "snapchat", tiktok: "tiktok", linktree: "linktree", linkedin: "linkedin", website: "website"
});

const SHARE_LINK = "that's a share link. open your profile and copy the address from there.";

/**
 * The line under a field for a validator code. `suggest` is the field a wrong-platform link belongs in (rendered with a "move it"
 * button by the editor); `message` is the validator's own member-facing text (a legacy linkedin.com/pub/ address).
 */
export function errorLine({ field, code, suggest, message }) {
  switch (code) {
    case "wrong_platform":
      return suggest && PLATFORM_LABEL[suggest] ? `that's ${/^[aeiou]/.test(suggest) ? "an" : "a"} ${PLATFORM_LABEL[suggest]} link. move it to ${PLATFORM_LABEL[suggest]}?` : "that link belongs in a different field.";
    case "short_link":
      return SHARE_LINK;
    case "contact_channel":
      return "that's a way to message someone, not a profile. use your profile's address instead.";
    case "contact_info":
      return "that looks like a phone number. take it out, then save.";
    case "not_a_profile":
      return message || "that's not a profile address. open your profile and copy the address from there.";
    case "scheme_not_allowed":
      return "links start with https. paste your profile's address, or your @name.";
    case "too_long":
      return "that's too long. use your profile's address.";
    case "invalid_handle":
      return `that name doesn't look right for ${PLATFORM_LABEL[field] || "that field"}. check it and try again.`;
    case "unknown_platform":
      return "that field isn't one we know.";
    case "invalid_url":
    default:
      return field === "website" ? "that doesn't look like a link. paste your website's address." : "that doesn't look like a link. paste your profile's address, or your @name.";
  }
}

/** One input's check on blur: null when the value is blank or fine, else the field error `{field, code, suggest?, message?}`. */
export function checkField(field, value) {
  const text = typeof value === "string" ? value.trim() : "";
  if (!text) return null;
  const r = validateLink(field, text);
  return r.ok ? null : { field, code: r.code, ...(r.suggest && { suggest: r.suggest }), ...(r.message && { message: r.message }) };
}

/** The stored links as input text: the canonical URL, or "" for a platform with no link. */
export function valuesFromLinks(links) {
  const out = {};
  for (const p of PLATFORMS) out[p] = links && typeof links[p]?.url === "string" ? links[p].url : "";
  return out;
}

/** The PUT body's `links`: only the fields whose text differs from the stored one; a blank is null (clear). */
export function changesFrom(values, stored) {
  const out = {};
  for (const p of PLATFORMS) {
    const now = (values[p] ?? "").trim();
    const was = stored[p] ?? "";
    if (now !== was) out[p] = now === "" ? null : now;
  }
  return out;
}

/** The per-field error list of an ApiError (a 422's details.fields), keyed by field. Unknown shapes give {}. */
export function fieldErrors(fields) {
  const out = {};
  if (Array.isArray(fields)) for (const f of fields) if (f && typeof f.field === "string" && typeof f.code === "string") out[f.field] = f;
  return out;
}

const safeUrl = (url) => {
  if (typeof url !== "string" || !/^https:\/\//i.test(url)) return null;
  try { return new URL(url).href; } catch { return null; }
};

/**
 * The chips of a links object, in the editor's field order: `{platform, href, text, label}`. A platform with a handle shows `@handle`,
 * facebook and linkedin show the platform name, the website shows its host. Anything without an https URL is dropped.
 */
export function chipsFrom(links) {
  const out = [];
  if (!links || typeof links !== "object") return out;
  for (const platform of PLATFORMS) {
    const entry = links[platform];
    const href = safeUrl(entry?.url);
    if (!href) continue;
    let text = PLATFORM_LABEL[platform];
    if (platform === "website") text = typeof entry.host === "string" && entry.host ? entry.host : new URL(href).hostname;
    else if (platform !== "facebook" && platform !== "linkedin" && typeof entry.handle === "string" && entry.handle) text = `@${entry.handle}`;
    const label = platform === "facebook" || platform === "linkedin" ? `${platform} (opens in a new tab)` : `${platform}: ${text} (opens in a new tab)`;
    out.push({ platform, href, text, label });
  }
  return out;
}

/** The rel and referrer policy of every outside link (members' links are user content). */
export const CHIP_REL = "noopener noreferrer nofollow ugc";
