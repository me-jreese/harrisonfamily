// HFY-TSK-187 (BRD2 review finding PS-11): @io-kit/md's KitMarkdown with the HFY SanitizePolicy FORCED, for the comment bodies the kit renders.
// build.mjs and importCommentsReact (kit-content.mjs) resolve the "@io-kit/md/react" import of @io-kit/comments to this module.
// Why forced rather than defaulted (compare lib/hfy-markdown.jsx): the kit's CommentBody passes `policy: userContentPolicy` itself
// (https images, mailto: links), and Thread / Comment have no policy prop, so a default would never apply. Whatever policy the kit hands
// in is replaced by the one HFY policy: protocols.src [] (images only through attachments) and href https and http (no mailto:).
// The same two component overrides as posts apply (see hfy-markdown.jsx for the hast-util-sanitize trap that makes the `img` mapping
// necessary): a markdown image is never drawn, so no external host is requested; a protocol-relative link is plain text.
import { KitMarkdown as KitMarkdownBase } from "@io-kit/md/react";
import { hfySanitizePolicy } from "./sanitize-policy.js";
import { HfyLink, HfyNoImage } from "./hfy-markdown.jsx";

export { useOutline } from "@io-kit/md/react";

export function KitMarkdown(props) {
  return <KitMarkdownBase {...props} policy={hfySanitizePolicy} components={{ ...props.components, img: HfyNoImage, a: HfyLink }} />;
}
