// The notification registry (every HFY type, level 0 by default), shared by hfy-api (api/src/notify.js re-exports it) and the auth edge
// (auth/src/admin-notify.js writes the admin inbox item for a new access request through the same registry). Pure data, no imports.
/** Level 0 is content-free; level 1 may name the actor. Recipients opt in to level 1 per type. */
const T = "Harrison Family";
export const TEMPLATE_REGISTRY = {
  features: {
    // Voice (DS guide/04-voice.md): lowercase sentences, "page" never "record", the site name as the title (a proper noun keeps its case).
    // The lock-screen preview on /me/notifications/ mirrors these word for word (islands/src/islands/notifications.jsx CATALOG).
    comment_on_my_record: { title: T, level0: "someone commented on your page.", level1: "{actor} commented on your page.", many: "{count} new comments on your page." },
    reply_to_me: { title: T, level0: "someone replied to you.", level1: "{actor} replied to you.", many: "{count} new replies to you." },
    // Push-only: the timeline is its in-app surface, and an inbox item per member for every post would be noise (BRD2 D2-15; inbox:false).
    new_family_post: { title: T, level0: "there's a new family post.", level1: "{actor} shared a new family post.", inbox: false },
    mention: { title: T, level0: "you were mentioned.", level1: "{actor} mentioned you." },
    // PLN-002 (HFY-TSK-253, social.md section 5 and editing.md section 8). Proposals: R-10 submitted, R-11 decided.
    proposal_submitted: { title: T, level0: "someone suggested a change.", level1: "{actor} suggested a change to {subject}'s page.", many: "{count} suggested changes are waiting for review." },
    proposal_accepted: { title: T, level0: "your suggested change was accepted.", level1: "{actor} accepted your change to {subject}'s page." },
    proposal_declined: { title: T, level0: "your suggested change wasn't added.", level1: "{actor} didn't add your change to {subject}'s page." },
    proposal_needs_changes: { title: T, level0: "an admin has a question about your suggestion.", level1: "{actor} has a question about your suggestion for {subject}'s page." },
    proposal_stale: { title: T, level0: "your suggestion needs a quick update.", level1: "your suggestion for {subject}'s page needs a quick update." },
    // Record changes: R-11 mine, R-12 followed, and one digest when a batch touches more than DIGEST_OVER followed pages for a recipient.
    record_updated_mine: { title: T, level0: "your page was updated.", level1: "{actor} updated your page.", many: "your page was updated {count} times." },
    record_updated_followed: { title: T, level0: "a page you follow was updated.", level1: "{subject}'s page was updated.", many: "a page you follow was updated {count} times." },
    // inboxText has no {count}: the store's count is how many digests coalesced, not how many pages (the push line carries the page count).
    records_updated_followed_digest: { title: T, level0: "pages you follow were updated.", level1: "{count} pages you follow were updated.", inboxText: "pages you follow were updated." },
    // Moderation (R-32). The reason for a hide stays private; an admin's note travels as the inbox `detail`, never in a push.
    moderation_hidden: { title: T, level0: "a moderator hid something you shared.", level1: "{actor} hid your {item}." },
    moderation_request: { title: T, level0: "a moderator asked you to update something you shared.", level1: "{actor} asked you to update your {item}." },
    moderation_question: { title: T, level0: "a moderator has a question about something you shared.", level1: "{actor} has a question about your {item}." },
    moderation_unhidden: { title: T, level0: "something you shared is visible again.", level1: "your {item} is visible again." },
    moderation_resolved: { title: T, level0: "an item you asked about was updated.", level1: "{actor} updated the {item} you asked about.", many: "{count} items you asked about were updated." },
    photo_graduated: { title: T, level0: "your photo was added to a family page.", level1: "{actor} added your photo to {subject}'s page." },
    // Access requests (surf-access-submit, surfaces.md 7.2): the auth edge writes this inbox item for every admin after a request is stored. No requester detail,
    // ever: both levels are the same content-free line, and the item navigates to the admin queue.
    access_request_new: { title: T, level0: "someone asked to join.", level1: "someone asked to join." },
    // Push-only (chat.md section 13, CHAT-D12): content-free, never any message text. Called by hfy-chat-api-service-routes.
    chat_message: { title: T, level0: "you have a new chat message.", level1: "{actor} sent you a chat message.", inbox: false },
  },
  whitelist: ["actor", "subject", "item", "count"],
};

/**
 * The one admin inbox item a new access request produces (surfaces.md 7.2 step 4): written by the auth edge after the request commits,
 * once per admin. It names nothing about the requester, and it opens the admin queue.
 */
export const ACCESS_REQUEST_NOTIFICATION = Object.freeze({ feature: "access_request_new", navigate: "/me/requests/" });
