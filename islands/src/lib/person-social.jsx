// The person page's social row (HFY-TSK-188, social.md section 8), contribV1 on: #hfy-person-social holds
//   section#hfy-person-comments       h2 "comments", the composer on top, newest first, capped, "show older comments"
//   section#hfy-person-contributions  h2 "contributions", the feed of lib/contrib-feed.jsx (HFY-TSK-189; R-26, R-27)
// side by side from 64rem and stacked below (src/social.css). Only the person-page-mount-points host #hfy-person-social is used.
import "../social.css";
import { Comments } from "./comments-ui.jsx";
import { ContributionsFeed } from "./contrib-feed.jsx";

/**
 * The contributions column's host (HFY-TSK-188 owns the host and the layout; HFY-TSK-189 draws the feed in it, lib/contrib-feed.jsx):
 * the heading, then `[data-hfy-contrib-host]` holding the total, the capped list and its empty, loading and error states.
 */
export function ContributionsHost({ personId }) {
  return (
    <section className="hfy-social__col" id="hfy-person-contributions" aria-labelledby="hfy-person-contributions-h" data-hfy-contributions>
      <h2 className="hfy-h" id="hfy-person-contributions-h">contributions</h2>
      <div className="hfy-social__contrib" data-hfy-contrib-host>
        <ContributionsFeed personId={personId} />
      </div>
    </section>
  );
}

export function PersonSocial({ id }) {
  return (
    <div className="hfy-social" data-hfy-social>
      <Comments subject={`person:${id}`} social />
      <ContributionsHost personId={id} />
    </div>
  );
}
