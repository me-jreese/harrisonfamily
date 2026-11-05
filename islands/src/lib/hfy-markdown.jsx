// HFY-TSK-171: @io-kit/md's KitMarkdown with the HFY sanitize policy as its default. build.mjs and importContentReact (kit-content.mjs)
// resolve the "@io-kit/md/react" import of @io-kit/content to this module, because PostCard and ArticleView (0.3.2) render the post
// body through KitMarkdown with no `policy` prop to pass one through. Kit gap, for the kit backlog: PostCard and ArticleView take a
// `policy`; then delete this module, hfyContentSanitizePolicy in kit-content.mjs and its two uses.
//
// KIT TRAP (@io-kit/md 1.2.0, record for the kit backlog): hast-util-sanitize reads an EMPTY protocol list as "no check", so a
// policy with protocols.src = [] lets every markdown image through, https or not. The policy keeps src = [] as the intent (images only
// through attachments), and `img` is mapped to HfyNoImage here, so no <img> is ever drawn from markdown and no host is requested.
// Upstream: treat [] as "none" in buildSchema; then the `img` mapping is a second line of defence and can stay.
import { KitMarkdown as KitMarkdownBase } from "@io-kit/md/react";
import { hfySanitizePolicy } from "./sanitize-policy.js";

export { useOutline } from "@io-kit/md/react";

/** A markdown image is never drawn. Its alt text stays as plain text, so the sentence still reads. */
function HfyNoImage({ alt }) {
  return alt ? <span data-hfy-md-image-omitted="">{alt}</span> : null;
}

/**
 * A protocol-relative href ("//other.example/x") has no scheme, so the policy reads it as a relative path and keeps it, yet the
 * browser resolves it to another host, in the same tab. It is drawn as plain text.
 */
const OFF_SITE_RELATIVE = /^\/\//;
function HfyLink({ href, children, node, ...rest }) {
  // No href: the policy dropped it (mailto:, javascript:), and an anchor without one is not a link, so only its text is drawn.
  if (typeof href !== "string" || OFF_SITE_RELATIVE.test(href.trim())) return <span data-hfy-md-link-omitted="">{children}</span>;
  return <a href={href} {...rest}>{children}</a>;
}

export function KitMarkdown(props) {
  return <KitMarkdownBase {...props} policy={props.policy ?? hfySanitizePolicy} components={{ ...props.components, img: HfyNoImage, a: HfyLink }} />;
}
