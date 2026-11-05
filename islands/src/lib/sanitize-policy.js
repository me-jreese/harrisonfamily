// HFY-TSK-171 (PS-11, HFY-R*): the SanitizePolicy for member-written markdown that the kit renders: post bodies today (PostCard and
// ArticleView of @io-kit/content), and the one policy comments and record notes adopt in their own tasks.
//   - images only through attachments: protocols.src is [] so a markdown image (![](https://other.example/x.png)) loses its src and
//     the browser never requests an external host. A photo reaches a post as an attachment, which the kit draws itself;
//   - links: href is https and http only, so mailto: is dropped (relative paths always pass);
//   - raw HTML is escaped (never allowed), links get noopener noreferrer nofollow ugc and open in a new tab.
// Only @io-kit/md's defaultPolicy is spread, so a new policy field of a later kit version keeps its default.
import { defaultPolicy } from "@io-kit/md";

export const hfySanitizePolicy = Object.freeze({
  ...defaultPolicy,
  rawHtml: "escape",
  protocols: Object.freeze({ href: Object.freeze(["https", "http"]), src: Object.freeze([]) }),
  internalSchemes: Object.freeze([]),
  externalLinks: Object.freeze({ rel: "noopener noreferrer nofollow ugc", target: "_blank" })
});
