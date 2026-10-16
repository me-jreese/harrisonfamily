// The notification catalog behind /me/notifications (the per-type toggles and the lock-screen preview): one entry per type of the
// API's TEMPLATE_REGISTRY (api/src/notify.js). Plain JS, so the contract test (tests/notify-catalog.test.mjs) can import it and compare it
// with the registry. title / generic / detailed are the push text and stay word for word what the server sends (generic = level 0,
// detailed = level 1), so the preview never promises a text the lock screen will not show. Labels and descriptions are the DS catalog
// copy (lowercase, "my page", never "record"). Types are in the order the settings page lists them inside each group.
//
// `chat_message` (HFY-TSK-164, chat.md 13) is here with its strings identical to the registry's. It is shown only while the `chatV1` flag is on
// (catalogFor({chat})), and it is the one type that defaults OFF (CHAT-D12, BRD2 11.5): the server sends a chat text only to a member who turned it on,
// so the page shows it off until they do (CHAT_DEFAULT_OFF, applied in islands/notifications.jsx).
// tests/notify-catalog.test.mjs pins the exceptions; moving a type into CATALOG means removing it from CATALOG_EXEMPT.
const T = "Harrison Family";

export const GROUP_ABOUT_ME = "about_me";
export const GROUP_FAMILY = "family";
export const GROUP_MODERATORS = "moderators";

export const CATALOG = {
  groups: [
    { id: GROUP_ABOUT_ME, label: "about me" },
    { id: GROUP_FAMILY, label: "family" },
    { id: GROUP_MODERATORS, label: "for moderators" }
  ],
  types: {
    comment_on_my_record: { group: GROUP_ABOUT_ME, label: "someone comments on my page", desc: "a comment on your page in the family tree.", title: T, generic: "someone commented on your page.", detailed: "{actor} commented on your page." },
    reply_to_me: { group: GROUP_ABOUT_ME, label: "someone replies to me", desc: "a reply where you commented.", title: T, generic: "someone replied to you.", detailed: "{actor} replied to you." },
    mention: { group: GROUP_ABOUT_ME, label: "someone mentions me", desc: "someone writes @ and your name in a comment.", title: T, generic: "you were mentioned.", detailed: "{actor} mentioned you." },
    record_updated_mine: { group: GROUP_ABOUT_ME, label: "my page is updated", desc: "someone changes your page.", title: T, generic: "your page was updated.", detailed: "{actor} updated your page." },
    proposal_accepted: { group: GROUP_ABOUT_ME, label: "my suggested change is accepted", desc: "an admin adds a change you suggested.", title: T, generic: "your suggested change was accepted.", detailed: "{actor} accepted your change to {subject}'s page." },
    proposal_declined: { group: GROUP_ABOUT_ME, label: "my suggested change isn't added", desc: "an admin decides not to add a change you suggested.", title: T, generic: "your suggested change wasn't added.", detailed: "{actor} didn't add your change to {subject}'s page." },
    proposal_needs_changes: { group: GROUP_ABOUT_ME, label: "an admin has a question about my suggestion", desc: "an admin asks you something before they decide.", title: T, generic: "an admin has a question about your suggestion.", detailed: "{actor} has a question about your suggestion for {subject}'s page." },
    proposal_stale: { group: GROUP_ABOUT_ME, label: "my suggestion needs a quick update", desc: "the page changed after you made your suggestion.", title: T, generic: "your suggestion needs a quick update.", detailed: "your suggestion for {subject}'s page needs a quick update." },
    photo_graduated: { group: GROUP_ABOUT_ME, label: "my photo is added to a family page", desc: "a photo you shared is added to a page in the family tree.", title: T, generic: "your photo was added to a family page.", detailed: "{actor} added your photo to {subject}'s page." },
    moderation_hidden: { group: GROUP_ABOUT_ME, label: "a moderator hides something of mine", desc: "the reason stays private.", title: T, generic: "a moderator hid something you shared.", detailed: "{actor} hid your {item}." },
    moderation_request: { group: GROUP_ABOUT_ME, label: "a moderator asks me to update something", desc: "a moderator asks you to change something you shared.", title: T, generic: "a moderator asked you to update something you shared.", detailed: "{actor} asked you to update your {item}." },
    moderation_question: { group: GROUP_ABOUT_ME, label: "a moderator has a question for me", desc: "a moderator asks you about something you shared.", title: T, generic: "a moderator has a question about something you shared.", detailed: "{actor} has a question about your {item}." },
    moderation_unhidden: { group: GROUP_ABOUT_ME, label: "something of mine is visible again", desc: "a moderator brings back something that was hidden.", title: T, generic: "something you shared is visible again.", detailed: "your {item} is visible again." },
    chat_message: { group: GROUP_FAMILY, label: "someone sends me a chat message", desc: "a chat message while you're away from the site.", title: T, generic: "you have a new chat message.", detailed: "{actor} sent you a chat message." },
    new_family_post: { group: GROUP_FAMILY, label: "family posts something new", desc: "a new post on the family timeline.", title: T, generic: "there's a new family post.", detailed: "{actor} shared a new family post." },
    record_updated_followed: { group: GROUP_FAMILY, label: "a followed page is updated", desc: "a page you chose to follow changes.", title: T, generic: "a page you follow was updated.", detailed: "{subject}'s page was updated." },
    records_updated_followed_digest: { group: GROUP_FAMILY, label: "several followed pages are updated", desc: "one note when a batch of changes touches more than three pages you follow.", title: T, generic: "pages you follow were updated.", detailed: "{count} pages you follow were updated." },
    proposal_submitted: { group: GROUP_MODERATORS, label: "someone suggests a change", desc: "a member suggests a change to a page and it waits for review.", title: T, generic: "someone suggested a change.", detailed: "{actor} suggested a change to {subject}'s page." },
    moderation_resolved: { group: GROUP_MODERATORS, label: "an item you asked about is updated", desc: "an author updates something you asked them about.", title: T, generic: "an item you asked about was updated.", detailed: "{actor} updated the {item} you asked about." }
  },
  levels: { generic: "hide the details", detailed: "show who", hint: "hidden details keep names off your lock screen." },
  sample: { actor: "A family member", subject: "Sam Example", item: "post", count: "3" }
};

/** Registry types the catalog does not hold yet (see the header). */
export const CATALOG_EXEMPT = ["access_request_new", "access_request_decided", "second_email_notice"];

/** Types that start switched off for a member who never chose (the server sends them only after an explicit opt-in). */
export const CHAT_TYPE = "chat_message";
export const CHAT_DEFAULT_OFF = [CHAT_TYPE];

/**
 * The catalog a viewer sees: the moderators' group (and its types) only for a viewer `/api/me` reports as `admin`, since the server sends
 * those types only to admins and a toggle for a push nobody will send is noise; and the chat toggle only while the `chatV1` flag is on (`chat: true`).
 */
export function catalogFor({ admin = false, chat = false } = {}) {
  const hide = (t, id) => (admin !== true && t.group === GROUP_MODERATORS) || (chat !== true && id === CHAT_TYPE);
  if (admin === true && chat === true) return CATALOG;
  return {
    ...CATALOG,
    groups: admin === true ? CATALOG.groups : CATALOG.groups.filter((g) => g.id !== GROUP_MODERATORS),
    types: Object.fromEntries(Object.entries(CATALOG.types).filter(([id, t]) => !hide(t, id)))
  };
}

/**
 * Preferences as the page shows them: every default-off type the member never saved is switched off (the kit would show a missing type as on).
 * Anything the member saved is left as it is.
 */
export function withDefaultOff(prefs) {
  const types = { ...(prefs?.types ?? {}) };
  for (const id of CHAT_DEFAULT_OFF) if (!types[id]) types[id] = { enabled: false, level: 0 };
  return { ...(prefs ?? {}), types };
}

/**
 * What the page saves: a default-off type that is still untouched (off, level 0) is dropped when `shown` is false, so a member who never sees the
 * chat toggle never gets a stored choice for it. When the toggle is shown the page saves the whole map as the kit builds it.
 */
export function withoutHiddenDefaults(prefs, shown) {
  if (shown === true || !prefs?.types) return prefs;
  const types = { ...prefs.types };
  for (const id of CHAT_DEFAULT_OFF) if (types[id] && types[id].enabled === false && types[id].level === 0) delete types[id];
  return { ...prefs, types };
}
