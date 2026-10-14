// The bell (HFY-TSK-185, flag inboxV1): fills the bell slot of the top bar's end group (lib/bar-slots.js, owned by the shell,
// HFY-TSK-138 / review DL-13) for a signed-in member, and opens the inbox. Under 43rem (a phone, an installed PWA) it opens the kit's
// bottom Sheet; from 43rem an anchored, non-modal panel under the bell. Escape, an outside click or a navigation closes it and focus
// returns to the bell. Opening marks nothing read. The unread count is the badge, and (useInbox) the app icon badge, kept in step with
// every read mark. feature-flags.js loads this bundle only with inboxV1 and a signed-in session; the shell is never edited for it.
import { useEffect, useId, useLayoutEffect, useRef, useState, useSyncExternalStore } from "react";
import { createPortal } from "react-dom";
import { createRoot } from "react-dom/client";
import { NotificationBell } from "@io-kit/notify/react";
import { Sheet } from "@io-kit/shell/react";
import { barSlots } from "../lib/bar-slots.js";
import { memberSub } from "../lib/edge-session.js";
import { COPY, INBOX_LABELS, INBOX_ROUTE, Inbox, SETTINGS_ROUTE, useFamilyInbox } from "../lib/inbox-ui.jsx";
// after the lib import on purpose: the kit's inbox.css (imported there) is first in the bundle, so these rules override it at equal specificity
import "./inbox.css";

/** The width from which the panel is anchored instead of a sheet: the shell's palette breakpoint (43rem), read from its token. */
const wideQuery = () => {
  let min = "";
  try { min = getComputedStyle(document.documentElement).getPropertyValue("--io-bp-palette-min").trim(); } catch { /* use the default */ }
  return `(min-width: ${min || "43rem"})`;
};
function useWide() {
  const mq = useRef(null);
  if (mq.current === null) mq.current = window.matchMedia(wideQuery());
  return useSyncExternalStore(
    (cb) => { mq.current.addEventListener("change", cb); return () => mq.current.removeEventListener("change", cb); },
    () => mq.current.matches,
    () => false
  );
}

// What keeps the focus it takes on a click. (A scroller made focusable only for keyboard scrolling is not one: the shell's page region.)
const INTERACTIVE = "a[href], button, input, select, textarea, summary, [contenteditable='true']";

/** The anchored panel: a portal to <body> (the bar's backdrop-filter would otherwise be its containing block), fixed under the bell. */
function Panel({ id, bell, onClose, children }) {
  const ref = useRef(null);
  const place = () => {
    const r = bell.getBoundingClientRect();
    return { top: Math.round(r.bottom), right: Math.max(0, Math.round(document.documentElement.clientWidth - r.right)) };
  };
  const [pos, setPos] = useState(place);
  useLayoutEffect(() => {
    const on = () => setPos((cur) => { const n = place(); return n.top === cur.top && n.right === cur.right ? cur : n; });
    // the bar can reflow without a window resize (a slot fills late, a font loads): follow the bell itself and any scroll
    const ro = typeof ResizeObserver === "function" ? new ResizeObserver(on) : null;
    ro?.observe(bell);
    ro?.observe(document.documentElement);
    window.addEventListener("resize", on);
    window.addEventListener("scroll", on, true);
    return () => { ro?.disconnect(); window.removeEventListener("resize", on); window.removeEventListener("scroll", on, true); };
  }, []);
  useEffect(() => {
    ref.current?.focus();
    const onKey = (e) => { if (e.key === "Escape") { e.stopPropagation(); onClose({ focusBell: true }); } };
    const onDown = (e) => {
      const t = e.target;
      if (!(t instanceof Node) || ref.current?.contains(t) || bell.contains(t)) return;
      // the clicked control keeps the focus it just took; a click on plain page area returns focus to the bell
      onClose({ focusBell: !(t instanceof Element && t.closest(INTERACTIVE)) });
    };
    document.addEventListener("keydown", onKey);
    document.addEventListener("pointerdown", onDown, true);
    return () => { document.removeEventListener("keydown", onKey); document.removeEventListener("pointerdown", onDown, true); };
  }, []);
  return createPortal(
    <div ref={ref} id={id} className="hfy-inbox-panel" role="dialog" aria-modal="false" aria-label={INBOX_LABELS.notifications} tabIndex={-1} data-hfy-inbox-panel style={{ "--io-hfy-inbox-top": `${pos.top}px`, "--io-hfy-inbox-right": `${pos.right}px` }}>
      {children}
    </div>,
    document.body
  );
}

function Footer({ onNavigate }) {
  return (
    <nav className="hfy-inbox__foot" aria-label="inbox links">
      <a className="hfy-inbox__link" href={INBOX_ROUTE} onClick={onNavigate}>{COPY.seeAll}</a>
      <a className="hfy-inbox__link" href={SETTINGS_ROUTE} onClick={onNavigate}>{COPY.settings}</a>
    </nav>
  );
}

export function Bell() {
  const inbox = useFamilyInbox();
  const wide = useWide();
  const [open, setOpen] = useState(false);
  const wrap = useRef(null);
  const panelId = useId();
  const bellButton = () => wrap.current?.querySelector("button.iok-notify-bell") ?? null;
  const close = ({ focusBell = false } = {}) => {
    setOpen(false);
    if (focusBell) requestAnimationFrame(() => bellButton()?.focus());
  };
  const body = (
    <>
      <Inbox inbox={inbox} onOpen={() => close()} />
      <Footer onNavigate={() => close()} />
    </>
  );
  return (
    <span ref={wrap} className="hfy-inbox" data-hfy-inbox-bell>
      <NotificationBell unread={inbox.unread} expanded={open} controls={open ? panelId : undefined} labels={INBOX_LABELS} onClick={() => setOpen((o) => !o)} />
      {open && wide && bellButton() && <Panel id={panelId} bell={bellButton()} onClose={close}>{body}</Panel>}
      {open && !wide && (
        <Sheet open onClose={() => close()} side="bottom" title={INBOX_LABELS.notifications} closeLabel="close" className="hfy-inbox-sheet">
          <div id={panelId}>{body}</div>
        </Sheet>
      )}
    </span>
  );
}

/** Mount the bell into the host the shell hands the bell slot; withdraw unmounts it. */
const mountBell = (host) => {
  const root = createRoot(host);
  root.render(<Bell />);
  // The shell unmounts a withdrawn filler from inside its own effect cleanup: React forbids unmounting a root synchronously there.
  return () => queueMicrotask(() => root.unmount());
};

// Fill the slot only for a signed-in session (the loader also gates on it): HFYFeatureFlags.edgeSession is the page's one probe.
Promise.resolve(typeof window.HFYFeatureFlags?.edgeSession === "function" ? window.HFYFeatureFlags.edgeSession() : null)
  .catch(() => null)
  .then((session) => { if (memberSub(session)) barSlots().fill("bell", mountBell); });
