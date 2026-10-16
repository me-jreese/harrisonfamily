// The harrisonfamily host configuration of @io-kit/chat (HFY-TSK-142). Plain JS with no DOM and no React, so tests/chat-config.test.mjs
// can pin it. Everything here is a host option of the kit: turning one off removes that behaviour from the UI and never changes the
// protocol (chat.md 15, BRD2 Q2-16).
//
// Q2-16 (io: "obsessively imitate the UX and functionality" of the original Gmail chat, "NO BELLS AND WHISTLES"): the behaviours the
// original verifiably had are imitation, so they are ON; io's exclusions and everything not in the original stay OFF.
//   ON   docked chat windows ("moles") with pop-out; the title-bar flash and the tab-title flash on a new message; typed emoticons
//        shown as emoji; the typing and "has entered text" states; sparse "sent at" lines; Enter to send with no Send button;
//        `q` to focus the roster search; idle after 15 minutes.
//   OFF  an incoming message opening a chat by itself (autoOpen); changing a group between private and open after it was created
//        (changePolicy); chat web push (a per-user setting that starts off: lib/notify-catalog.js CHAT_DEFAULT_OFF). Reactions,
//        photos, GIFs, attachments, receipts, "last seen" and invisible mode are not in the kit at all.
// io keeps or cuts each item at the chat UAT (hfy-chat-uat); until then these are the defaults, and `renameGroup` (a CHAT-D10 reading,
// not a verified Gmail behaviour) stays on until that answer.

/** Prefix of every key the shell remembers: `hfy:chat:panel` (localStorage) and `hfy:chat:moles` (sessionStorage). */
export const STORAGE_KEY = "hfy:chat";
/** The chat page, the entry's target and the pop-out window's page. */
export const CHAT_PAGE = "/chat/";
/** Session-scoped snapshot and per-user outbox, named with the user id so two accounts in one browser never share a queue. */
export const snapshotKey = (uid) => `hfy:chat:v1:${uid}`;
export const outboxName = (uid) => `hfy:chat:outbox:${uid}`;

/** The shell options that do not depend on the screen. */
export const SHELL_OPTIONS = Object.freeze({
  dock: true,
  popOut: true,
  titleFlash: true,
  tabFlash: true,
  searchShortcut: true,
  autoOpen: false,
  renameGroup: true,
  changePolicy: false,
  rosterCap: 40,
  storageKey: STORAGE_KEY,
});

/** Options of every ConversationView the shell renders. */
export const CONVERSATION_OPTIONS = Object.freeze({
  emoticons: true,
  typingLine: true,
  enteredText: true,
  sentAtLines: true,
  sentAtGapMs: 5 * 60 * 1000,
});

/** ChatClient options that are host choices. `timings` is not overridden: the kit's idle (15 minutes) and ping timings are the verified ones. */
export const CLIENT_OPTIONS = Object.freeze({ sendPaused: true });

/** `/chat/?c=<conversation>` for a conversation id (and `&popout=1` for the pop-out window, which the kit builds). */
export function chatUrl(conv) {
  return conv ? `${CHAT_PAGE}?c=${encodeURIComponent(conv)}` : CHAT_PAGE;
}

/** The conversation a `/chat/` URL selects (`?c=`), or null. */
export function convFromSearch(search) {
  const c = new URLSearchParams(search || "").get("c");
  return c && c.length <= 200 ? c : null;
}

/** True for the pop-out window (`?popout=1`): no roster column, no dock. */
export function isPopout(search) {
  return new URLSearchParams(search || "").get("popout") === "1";
}

/**
 * The shell options for this screen (chat.md 15.1, 15.3, 15.4). From 43rem the moles dock (the roster panel starts open from 64rem and
 * collapsed between 43rem and 64rem); under 43rem nothing docks and opening a chat goes to the /chat/ page.
 */
export function shellOptionsFor({ narrow, medium, navigate }) {
  return {
    ...SHELL_OPTIONS,
    dock: narrow ? false : SHELL_OPTIONS.dock,
    defaultPanelOpen: !narrow && !medium,
    conversation: { ...CONVERSATION_OPTIONS },
    onOpen: (conv) => navigate(chatUrl(conv)),
  };
}

/** Strings this site words differently from the kit defaults (chat.md 15.5): the phone's placeholder has no keyboard hint. */
export function copyFor({ narrow }) {
  return narrow ? { placeholder: "type a message" } : {};
}

/** A phone: closing the socket when the page is hidden is the mobile rule (the kit's `closeOnHidden`). */
export function isMobileAgent(ua) {
  return /iPhone|iPad|iPod|Android/i.test(String(ua || ""));
}

/** The line a halted client shows on the /chat/ page, from its notice (chat.md 6.5, 15.5). `null`: show nothing. */
export function noticeLine(notice) {
  switch (notice) {
    case "sign_in": return "signedOut";
    case "reload": return "newVersion";
    case "forbidden":
    case "unavailable":
    case "protocol": return "unavailable";
    default: return null;
  }
}

/** The session expiry as epoch seconds (the edge session carries seconds; a millisecond value is converted), or undefined. */
export function expSeconds(session) {
  const n = Number(session && session.exp);
  if (!Number.isFinite(n) || n <= 0) return undefined;
  return n > 1e12 ? Math.floor(n / 1000) : Math.floor(n);
}
