// The chat island (HFY-TSK-142, flag chatV1, default off; BRD2 R-33, R-34, R-36, R-38, R-40; chat.md 15, 17, 18). It runs @io-kit/chat's
// ChatClient on the page's one same-origin WebSocket (/chat/ws, the Cloudflare Worker route) and draws three things from one React tree:
//
//   * from 43rem, on every page: the roster panel (bottom left) and the dock of open chats, "moles" (bottom right), as in Gmail's chat;
//   * under 43rem: a chat entry in the chat slot of the top bar's end group (lib/bar-slots.js, owned by the shell, HFY-TSK-138 / review
//     DL-13: this island fills only its own slot and never edits shell.jsx), with a dot while anything is unread, linking to /chat/;
//   * on /chat/ (the static page 11ty/chat/index.html): the roster beside the conversation, or one after the other full screen on a phone.
//
// feature-flags.js loads this bundle only with chatV1: on every page for a signed-in member, and on /chat/ always (a signed-out visitor
// gets "sign in to chat."). The flag is not a security boundary: the Worker's CHAT_OPEN_TO / CHAT_UAT_SUBJECTS decide who may connect, and
// a member it refuses (close 4403) sees no chat at all. Which Gmail behaviours are on is lib/chat-config.js (Q2-16).
//
// The composer's R-18 pre-check is lib/chat-guard.js: shared/privacy-guard.mjs, the same module the Worker bundles.
import "@io-kit/chat/chat.css";
import "./chat.css";
import { createPortal } from "react-dom";
import { createRoot } from "react-dom/client";
import { useEffect, useMemo, useState, useSyncExternalStore } from "react";
import { ChatClient, browserPageEnv, dmConvId, indexedDbOutbox, webStorageSnapshot, websocketTransport } from "@io-kit/chat";
import { ChatEntryButton, ChatPage, ChatProvider, MoleDock, PresenceDot, RosterPanel, resolveCopy, useChat } from "@io-kit/chat/react";
import { barSlots } from "../lib/bar-slots.js";
import { memberSub } from "../lib/edge-session.js";
import { contactGuard } from "../lib/chat-guard.js";
import {
  CHAT_PAGE, CLIENT_OPTIONS, convFromSearch, copyFor, expSeconds, isMobileAgent, isPopout, noticeLine, outboxName, shellOptionsFor, signInHref, snapshotKey,
} from "../lib/chat-config.js";

const CONVO_CLASS = "hfy-chat-convo";

/** A matchMedia query as a React value. The widths are the shell's: 43rem (the palette / phone line, --io-bp-palette-min) and 64rem. */
function useQuery(query) {
  const subscribe = useMemo(() => (cb) => {
    const mq = window.matchMedia(query);
    mq.addEventListener("change", cb);
    return () => mq.removeEventListener("change", cb);
  }, [query]);
  return useSyncExternalStore(subscribe, () => window.matchMedia(query).matches, () => false);
}
// The widths are the theme's tokens (--io-bp-medium 43rem, --io-bp-wide 64rem; the shell's --io-bp-palette-min is the same 43rem), read once.
const breakpoint = (names, fallback) => {
  let v = "";
  try {
    const cs = getComputedStyle(document.documentElement);
    v = names.map((n) => cs.getPropertyValue(n).trim()).find(Boolean) || "";
  } catch { /* use the default */ }
  return v || fallback;
};
const phoneLine = () => breakpoint(["--io-bp-palette-min", "--io-bp-medium"], "43rem");
const wideLine = () => breakpoint(["--io-bp-wide"], "64rem");
const PHONE_UP = `(min-width: ${phoneLine()})`;
const WIDE_UP = `(min-width: ${wideLine()})`;

/** The bar's chat slot host, as an external store so the single React tree can portal the entry into it. */
function slotStore() {
  let host = null;
  const subs = new Set();
  return {
    set(next) { host = next; subs.forEach((f) => f()); },
    get: () => host,
    subscribe: (f) => { subs.add(f); return () => subs.delete(f); },
  };
}

function useNotice() {
  const { state } = useChat();
  return state.status.notice;
}

/** The chat entry, portalled into the bar's chat slot: only under 43rem, and never for a member the Worker refused. */
function Entry({ slot, narrow }) {
  const notice = useNotice();
  const host = useSyncExternalStore(slot.subscribe, slot.get, slot.get);
  const hidden = notice === "forbidden" || notice === "sign_in";
  useEffect(() => {
    if (!narrow || hidden) return undefined;
    // The shell puts a display:contents host span in the bar for a filled slot and unmounts it from inside its own effect cleanup.
    return barSlots().fill("chat", (el) => { slot.set(el); return () => slot.set(null); });
  }, [narrow, hidden, slot]);
  return host && narrow && !hidden ? createPortal(<ChatEntryButton href={CHAT_PAGE} />, host) : null;
}

/**
 * Presence on a profile (chat.md 10.3, R-37): the person page's hero action slot ([data-slot="presence"], person-page mount points,
 * HFY-TSK-137) gets the dot, the state in words and, for someone else, a "chat" button. Only an eligible member (the hub's `people`)
 * gets it: a person without an account, a deceased person and every page that is not a person page get nothing. The hero is rebuilt
 * by every render, so the host is read again on each hfy:person-rendered; the host store lets the one React tree portal into it.
 */
function personStore() {
  let cur = null;
  const subs = new Set();
  const read = (id) => {
    const host = document.querySelector('#person-hero [data-slot="presence"]');
    const next = host && id ? { host, personId: id } : null;
    if (cur === next || (cur && next && cur.host === next.host && cur.personId === next.personId)) return;
    cur = next;
    subs.forEach((f) => f());
  };
  return {
    start() {
      if (!/^\/person\/?(index\.html)?$/.test(window.location.pathname)) return () => {};
      const on = (e) => read((e.detail && e.detail.personId) || new URLSearchParams(window.location.search).get("id"));
      document.addEventListener("hfy:person-rendered", on);
      read(new URLSearchParams(window.location.search).get("id")); // the hero may be drawn before the island started
      return () => document.removeEventListener("hfy:person-rendered", on);
    },
    get: () => cur,
    subscribe: (f) => { subs.add(f); return () => subs.delete(f); },
  };
}

function ProfilePresence({ person }) {
  const host = useSyncExternalStore(person.subscribe, person.get, person.get);
  const { state, copy, open } = useChat();
  useEffect(() => person.start(), [person]);
  const refused = ["forbidden", "sign_in", "unavailable"].includes(state.status.notice);
  const id = host && host.personId;
  if (!host || refused || !state.me || !state.people.some((p) => p.id === id)) return null;
  const mine = id === state.me;
  const st = state.presence[id] || "offline";
  const words = st === "active" ? copy.presenceActive : st === "idle" ? copy.presenceIdle : copy.presenceOffline;
  return createPortal(
    <p className="io-chat hfy-presence" data-hfy-presence={id} data-state={st}>
      <PresenceDot state={st} copy={copy} />
      <span className="hfy-presence__text">{words}</span>
      {!mine && <button type="button" className="hfy-presence__chat" onClick={() => open(dmConvId(state.me, id))}>{copy.entryLabel}</button>}
    </p>,
    host.host,
  );
}

/** "sign in to chat." with the edge sign-in, back to this page afterwards. */
function SignIn({ copy }) {
  return (
    <div className="hfy-chat__gate" role="status" data-hfy-chat-gate>
      <p>{copy.signedOut}</p>
      <a className="hfy-chat__signin" href={signInHref(window.location)}>sign in</a>
    </div>
  );
}

/** The /chat/ page: the kit's two-pane page (a stack under 43rem), the URL's ?c=, and the line a halted connection owes the reader. */
function Page({ narrow, popout }) {
  const { copy, state } = useChat();
  const [conv, setConv] = useState(() => convFromSearch(window.location.search));
  const line = noticeLine(state.status.notice);
  const hidden = line === "unavailable";
  // Phone: while a conversation is open the shell's compact bottom bar steps aside so the keyboard and the composer have the room
  // (html.hfy-chat-convo, chat.css). It is cleared the moment the roster, another page or a wider screen takes over.
  const full = narrow && conv !== null;
  useEffect(() => {
    document.documentElement.classList.toggle(CONVO_CLASS, full);
    return () => document.documentElement.classList.remove(CONVO_CLASS);
  }, [full]);
  const sync = (next) => {
    setConv(next);
    // Keep ?c= true to the selection without adding history entries of its own: the kit pushes the entry Back returns through.
    const url = new URL(window.location.href);
    if (next) url.searchParams.set("c", next); else url.searchParams.delete("c");
    try { window.history.replaceState(window.history.state, "", url); } catch { /* history not available */ }
  };
  if (line === "signedOut") return <SignIn copy={copy} />;
  return (
    <>
      {line && <p className="hfy-chat__line" role="status" data-hfy-chat-line>{copy[line]}</p>}
      {!hidden && (
        <div className="hfy-chat__page" data-hfy-chat-page data-conv={conv ? "open" : "none"}>
          <ChatPage roster={!popout} defaultConv={conv} onConvChange={sync} />
        </div>
      )}
    </>
  );
}

function Chrome({ slot, person, pageHost, popout }) {
  const narrow = !useQuery(PHONE_UP);
  const notice = useNotice();
  const refused = notice === "forbidden" || notice === "sign_in";
  const onPage = pageHost !== null;
  // The dock is for the wide screens (and never in a pop-out, which is one chat in its own window). On /chat/ the page's own roster
  // column replaces the panel, and the other open chats stay docked beside it.
  const dock = !narrow && !popout && !refused;
  return (
    <>
      <Entry slot={slot} narrow={narrow} />
      <ProfilePresence person={person} />
      {dock && !onPage && <RosterPanel />}
      {dock && <MoleDock reservePanel={!onPage} />}
      {onPage && createPortal(<Page narrow={narrow} popout={popout} />, pageHost)}
    </>
  );
}

function App({ client, slot, person, pageHost, popout }) {
  const narrow = !useQuery(PHONE_UP);
  const medium = !useQuery(WIDE_UP);
  const options = useMemo(() => shellOptionsFor({ narrow, medium, navigate: (url) => window.location.assign(url) }), [narrow, medium]);
  const copy = useMemo(() => copyFor({ narrow }), [narrow]);
  return (
    <ChatProvider client={client} options={options} copy={copy}>
      <Chrome slot={slot} person={person} pageHost={pageHost} popout={popout} />
    </ChatProvider>
  );
}

/** The signed-out reader of /chat/ (no ChatClient is built for them). */
function Gate() {
  return <SignIn copy={resolveCopy()} />;
}

function buildClient({ uid, exp }) {
  const flags = window.HFYFeatureFlags;
  const proto = window.location.protocol === "https:" ? "wss:" : "ws:";
  return new ChatClient({
    ...CLIENT_OPTIONS,
    transport: websocketTransport(`${proto}//${window.location.host}/chat/ws`),
    page: browserPageEnv(),
    // The user id is in both names, so two accounts in one browser never share a queue or a snapshot.
    outbox: indexedDbOutbox(outboxName(uid)),
    snapshot: webStorageSnapshot(window.sessionStorage, snapshotKey(uid)),
    uid,
    closeOnHidden: isMobileAgent(navigator.userAgent),
    session: { exp, refresh: () => (flags && typeof flags.refreshSession === "function" ? flags.refreshSession() : Promise.reject(new Error("no refresh"))) },
    contactGuard,
  });
}

/** /chat/'s static "isn't turned on yet." line, kept until the island knows what it will draw (it is removed once the client is built). */
const offLine = () => document.querySelector("[data-chat-off]");

/** The island could not start (storage or the socket blocked, a constructor error): say so on /chat/ rather than leave a blank page. */
function showUnavailable() {
  const line = offLine();
  if (!line) return;
  line.removeAttribute("data-chat-off");
  line.setAttribute("data-hfy-chat-line", "");
  line.setAttribute("role", "status");
  line.textContent = resolveCopy().unavailable;
}

async function start() {
  const flags = window.HFYFeatureFlags;
  if (!flags || typeof flags.resolveFlags !== "function") return;
  const on = await flags.resolveFlags().then((f) => f && f.chatV1 === true, () => false);
  if (!on) return;
  try {
    const pageHost = document.querySelector('[data-island="chat"]');
    const session = await Promise.resolve(typeof flags.edgeSession === "function" ? flags.edgeSession() : null).catch(() => null);
    const uid = memberSub(session);
    if (!uid) {
      // Signed out: nothing of a past session stays readable (a shared device), and /chat/ asks the reader to sign in.
      try { flags.purgeChatState?.(); } catch { /* storage blocked */ }
      if (pageHost) { offLine()?.remove(); createRoot(pageHost).render(<Gate />); }
      return;
    }
    const client = buildClient({ uid, exp: expSeconds(session) });
    // Sign-out (HFYFeatureFlags.forgetEdgeSession, lib/sign-out.js, auth-v2.js) announces itself: the client stops and erases its snapshot
    // and its outbox, so no conversation text or unsent message outlives the session.
    window.addEventListener("hfy:signout", () => { client.signOut().catch(() => {}); }, { once: true });
    // One host for the panel, the dock and the portals. data-hfy-keep keeps it a direct child of <body>: the shell moves every other
    // child of <body> into its scroller, where a fixed dock would be clipped by the scroller's compositing.
    const host = document.createElement("div");
    host.id = "hfy-chat-root";
    host.setAttribute("data-hfy-keep", "");
    document.body.appendChild(host);
    createRoot(host).render(<App client={client} slot={slotStore()} person={personStore()} pageHost={pageHost} popout={isPopout(window.location.search)} />);
    // The island is running and draws everything from here on.
    offLine()?.remove();
    // After the first render, so the first paint has the snapshot's conversations and a connect does not delay it.
    client.start().catch((err) => console.error("chat: start failed", err && err.message));
  } catch (err) {
    console.error("chat: the island could not start", err && err.message);
    showUnavailable();
  }
}

if (typeof window !== "undefined") start();
