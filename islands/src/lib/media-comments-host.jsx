// The comment thread on a media detail page (HFY-TSK-389-0A, flag mediaCommentsV1; BRD HFY-PLN-004 D-35, D-36). It is the kit thread the person and post pages use
// (lib/comments-ui.jsx: comment photos, reactions, the moderation overlay, notification preferences and record subscriptions all follow their own flags) with the
// subject media:<gramps_id>. Media comments live in the cloud only; nothing here touches a Gramps path (D-36). Flag off, the slot stays an empty host.
import { Comments } from "./comments-ui.jsx";

export function MediaCommentsHost({ subject, enabled }) {
  const on = enabled === true && typeof subject === "string" && /^media:[A-Za-z0-9_.-]{1,64}$/.test(subject);
  return (
    <div data-slot="media-comments" data-subject={subject}>
      {on && <Comments subject={subject} />}
    </div>
  );
}
