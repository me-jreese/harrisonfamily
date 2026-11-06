// The posts-page carousel's pure pieces (HFY-TSK-388-0C, flag mediaBrowserV1; BRD HFY-PLN-004 D-29 to D-31, D-38). The kit's links are built on a
// hard-coded /media/ (a private data prefix, P4-R33), so every address the band hands out is moved to /all-media/ here.
import { detailHrefIn } from "@io-kit/media/browser";

export const ALL_MEDIA_BASE = "/all-media/";
export const rebaseMedia = (href) => href.replace(/^\/media\/(?=\?|$)/, ALL_MEDIA_BASE);
/** A card's address: the media detail page on /all-media/ (the carousel spans both sections, so the context is the default one). */
export const carouselDetailHref = (mediaId) => rebaseMedia(detailHrefIn(mediaId));

/** The band shows only on the posts list (`/posts/`), not on one post (`/posts/?id=<ulid>`), and only for a member. */
export const showsOnPath = (pathname, search) => /^\/posts\/?(index\.html)?$/.test(pathname) && !new URLSearchParams(search).has("id");

/** Wraps the browse source so a failed first read is reported once (the band then renders nothing) and still rejects as the kit expects. No message is kept. */
export function guardSource(source, onFail) {
  return {
    async listMedia(q) {
      try {
        return await source.listMedia(q);
      } catch (e) {
        try { onFail(); } catch { /* the band is optional */ }
        throw e;
      }
    },
  };
}
