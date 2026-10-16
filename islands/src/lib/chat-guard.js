// The chat composer's R-18 pre-check (HFY-TSK-142, BRD2 5.3, chat.md 12.2). The detector is shared/privacy-guard.mjs, the very module the
// chat Worker bundles as the hub's contactGuard (chat-worker/src/common.mjs) and hfy-api and the auth edge run (D2-09), so the composer
// highlights exactly what the hub would refuse with CONTACT_INFO. No DOM and no CSS here: the kit's Composer and the group-name box draw
// the verdict (the highlighted spans and the line under the box); the hub's check stays the authority.
//
// Every kind is scanned, birth dates included: chat is kept in the cloud for good (R-35), so there is no "learn from a refusal" switch
// here as there is for the post and comment composers (lib/contact-precheck.js).
import { scanText } from "../../../shared/privacy-guard.mjs";

/** @io-kit/chat ContactGuard: the spans `[start, end, kind]` of every hit in `text` (UTF-16 offsets). The matched text is never copied. */
export function contactGuard(text) {
  return scanText(text).map((hit) => [hit.start, hit.end, hit.kind]);
}
