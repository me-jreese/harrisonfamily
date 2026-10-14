// The pure parts of the inbox UI (HFY-TSK-185): routes, copy and the two small functions the kit components are fed through. Plain JS, no
// React and no CSS, so tests/inbox-model.test.mjs can import it under node. lib/inbox-ui.jsx is the React side.

export const INBOX_ROUTE = "/me/inbox/";
export const SETTINGS_ROUTE = "/me/notifications/";

/** DS voice for every string the kit's bell and inbox render (lowercase; "page", never "record"). */
export const INBOX_LABELS = {
  notifications: "notifications",
  bellUnread: "{label}, {count} unread",
  announceUnread: "{count} unread notifications",
  unreadFilter: "unread",
  allFilter: "all",
  filterGroup: "show",
  markAllRead: "mark all read",
  markRead: "mark read: {title}",
  select: "select",
  markSelectedRead: "mark selected read",
  selectItem: "select: {title}",
  unreadItem: "unread",
  count: "×{count}",
  more: "more",
  less: "less",
  showOlder: "show older",
  loading: "loading notifications",
  empty: "you're all caught up.",
  // the line every other surface shows when a load fails
  failed: "that didn't work. try again, or text J.",
  retry: "try again",
  actionFailed: "that didn't work. try again."
};
export const COPY = {
  seeAll: "see all",
  settings: "notification settings",
  title: "your inbox",
  signedOut: "this page is family-only. sign in to see it.",
  signIn: "sign in",
  loading: "loading"
};

/** A server-generated item target is a same-origin path; anything else (never expected) falls back to the inbox page. */
export const safeTarget = (p) => (typeof p === "string" && /^\/(?!\/|\\)[^\u0000-\u001f]*$/.test(p) ? p : INBOX_ROUTE);

// The API's inbox items carry the push title, which for every HFY type is the site name, and the sentence in `body`. A list of rows that
// all start "Harrison Family" hides what each one says (and gives every "mark read" button the same name), so the sentence leads: it is
// the row's title, with the unread weight and the "mark read: <sentence>" name. Any other title (a later type's own) is left alone.
export const SITE_TITLE = "Harrison Family";
export const leadWithBody = (item) => (item.title === SITE_TITLE && item.body ? { ...item, title: item.body, body: "" } : item);
