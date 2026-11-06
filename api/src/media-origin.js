// The two Gramps Attributes on a Media object that the Media Browser origin line reads (ruling HFY-P4-R26, BRD D-08: on the Media, never on a MediaRef).
// ONE module for the names and value formats: the reader (media-browser.js) and the writers (post-graduate.js; the upload commit, later) import it.
//   hfy:source    `post:<post ulid>[/<upload id>]` for a graduated post photo, `upload` for a member upload. An import carries neither attribute.
//   hfy:added-by  the author's or uploader's gramps_id.
export const ATTR_SOURCE = "hfy:source";
export const ATTR_ADDED_BY = "hfy:added-by";
export const SOURCE_UPLOAD = "upload";
const POST_SOURCE_RE = /^post:([0-9A-Z]{26})(?:[/:]|$)/;

/** The hfy:source value of a graduated post photo. The upload id after the slash lets the browser tell that the attachment has graduated. */
export const postSource = (postId, uploadId) => `post:${postId}${uploadId ? `/${uploadId}` : ""}`;
/** The post id an hfy:source value names, or undefined (`upload`, an import, anything else). */
export const postIdOfSource = (value) => POST_SOURCE_RE.exec(String(value ?? ""))?.[1];
