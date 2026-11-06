// The person page's social row (HFY-TSK-188, social.md section 8), contribV1 on: #hfy-person-social holds
//   section#hfy-person-comments       h2 "comments", the composer on top, newest first, capped, "show older comments"
//   section#hfy-person-contributions  h2 "contributions", the host hfy-person-contrib-ui fills (R-26, R-27)
// side by side from 64rem and stacked below (src/social.css). Only the person-page-mount-points host #hfy-person-social is used.
import "../social.css";
import { Comments } from "./comments-ui.jsx";

/**
 * The contributions column's host. This task owns the host and the layout; hfy-person-contrib-ui draws the feed in it, and with it the empty
 * line for a person with none (the design lists that state only for a real empty feed). Until it lands the column is its heading and an empty
 * host, `[data-hfy-contrib-host]`, which that task fills; contribV1 stays off until then.
 */
export function ContributionsHost() {
  return (
    <section className="hfy-social__col" id="hfy-person-contributions" aria-labelledby="hfy-person-contributions-h" data-hfy-contributions>
      <h2 className="hfy-h" id="hfy-person-contributions-h">contributions</h2>
      <div className="hfy-social__contrib" data-hfy-contrib-host />
    </section>
  );
}

export function PersonSocial({ id }) {
  return (
    <div className="hfy-social" data-hfy-social>
      <Comments subject={`person:${id}`} social />
      <ContributionsHost />
    </div>
  );
}
