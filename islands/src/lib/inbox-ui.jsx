// The inbox UI both surfaces share (HFY-TSK-185, inboxV1): the bell's panel / sheet (islands/inbox.jsx) and the /me/inbox/ page
// (islands/inbox-page.jsx) render the same @io-kit/notify 0.6.0 NotificationInbox over one useInbox, with the same copy and the same
// open rule. Opening a surface marks nothing read: only an explicit action does (a tap on an item, "mark read", "mark all read").
import "@io-kit/notify/inbox-tokens.css";
import "@io-kit/notify/inbox.css";
import "../inbox.css";
import { NotificationInbox, useInbox } from "@io-kit/notify/react";
import { notifyApi } from "./notify-api.js";
import { formatTime } from "./time.js";
import { INBOX_LABELS, leadWithBody, safeTarget } from "./inbox-model.js";

export { COPY, INBOX_LABELS, INBOX_ROUTE, SETTINGS_ROUTE, SITE_TITLE, leadWithBody, safeTarget } from "./inbox-model.js";

/** The inbox state, with the one api both surfaces use. `pollMs` stays the kit's 60 s while the page is visible. */
export const useFamilyInbox = (opts = {}) => useInbox({ api: notifyApi, ...opts });

/** Where a tap on an item goes. The kit has already sent the read mark (keepalive, so it survives the navigation). */
export const go = (href) => window.location.assign(href);

/**
 * The kit's inbox for `inbox` (a useInbox state). `onOpen` runs before the navigation (a surface closes itself there); the tap marks the
 * item read first, then navigates, and a modified click keeps the browser's own new-tab behaviour.
 */
export function Inbox({ inbox, onOpen, headingLevel = 2, id }) {
  return (
    <NotificationInbox
      inbox={{ ...inbox, items: inbox.items.map(leadWithBody) }}
      id={id}
      labels={INBOX_LABELS}
      formatTime={(iso) => formatTime(iso)}
      headingLevel={headingLevel}
      onOpen={(item) => { onOpen?.(item); go(safeTarget(item.navigate)); }}
    />
  );
}
