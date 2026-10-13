// KitShell (frame="bare") replaces the Bootstrap navbar on every page when flag shellV2 is on (HFY-TSK-064).
// Styling follows the approved design system (ds/components/Shell, HFY-R13): five-item bottom bar under 688 px (four with navMe), a translucent
// Columbia top bar with links and an inline search field from 688 px up, no kit rail or sidebar. The theme (fonts, tokens,
// bridges) is the static /css/hfy-theme.css layer; shell.css only aliases --io-shell-* / --io-* tokens.
import "../shell.css";
import { useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import { defineNavRegistry } from "@io-kit/shell";
import { KitShell, ScrollTopZone, SearchLauncher, Sheet, useBreakpoint, useShellScroll, usePwaInstall, useDisplayMode, detectPlatform } from "@io-kit/shell/react";
import { mountAt } from "../lib/mount.jsx";
import { suggestPeople } from "../lib/people-corpus.js";
import { navPathname, ownRoute } from "../lib/family-route.js";
import { SETTINGS_ROUTE, navItems, onSettings } from "../lib/nav.js";
import { signOut } from "../lib/sign-out.js";
import { SLOT_ORDER, barSlots } from "../lib/bar-slots.js";
// The page's edge session (HFYFeatureFlags.edgeSession, one GET /auth/session per page) and the "signed in" rule, shared with the
// settings hub: undefined while pending, null when authV2 is off or /auth/session is unreachable, else {authenticated, sub, label}.
import { memberSub, useEdgeSession } from "../lib/edge-session.js";

// Nav registry (R8, DS Shell anatomy): lowercase destinations composed by navItems() (lib/nav.js) from the flags navMe, familyViz and
// notifyV2 and the edge session's sub. Without navMe it is today's five: home, family, search, posts, me. "family" is "your family":
// /private/ is its stable route, a redirect page (HFYFeatureFlags.goToFamily) that sends a signed-in member to their own page and a
// signed-out visitor to the sign-in, which returns there. Once the edge session says who the member is, the route is the own page
// itself (lib/family-route.js), so the tab links straight to it. With navMe (HFY-TSK-091) "me" takes that own-page route and "family"
// leaves the bar until familyViz gives it the tree; the settings move behind the gear (/me/). The own-page tab is marked current on
// that page only; another person's page has no marked tab.
const navigate = (href) => window.location.assign(href);
// Same rule as the kit's bottom bar: "/" is exact, every other route also matches its sub-paths.
const isCurrent = (pathname, route) => (route === "/" ? pathname === "/" : pathname === route || pathname.startsWith(route));
const here = () => window.location.pathname + window.location.search + window.location.hash;

function InstallPrompt() {
  const { canInstall, prompt, installed } = usePwaInstall();
  const mode = useDisplayMode();
  const [dismissed, setDismissed] = useState(() => { try { return localStorage.getItem("hfy:install-dismissed") === "1"; } catch { return false; } });
  const ios = detectPlatform() === "ios";
  const standalone = installed || mode === "standalone";
  // On iPhone the notification settings page carries its own add-to-home-screen card (the kit PushNudge's iosHint, which is the
  // reason push needs the install). Two stacked cards said the same thing twice with a "not now" each (QA2): that page shows one.
  const notifyCard = ios && /^\/me\/notifications\/?$/.test(window.location.pathname);
  if (dismissed || standalone || notifyCard || !(canInstall || ios)) return null;
  const dismiss = () => { try { localStorage.setItem("hfy:install-dismissed", "1"); } catch { /* ignore */ } setDismissed(true); };
  return (
    <div className="hfy-install" role="region" aria-label="add to home screen" data-hfy-install>
      <p>{ios ? "add this to your home screen so it works like an app: tap share → add to home screen." : "add this to your home screen so it works like an app."}</p>
      <div className="hfy-install__actions">
        {!ios && <button type="button" className="hfy-install__add" onClick={() => prompt()}>add</button>}
        <button type="button" className="hfy-install__dismiss" onClick={dismiss}>not now</button>
      </div>
    </div>
  );
}

// DS Shell, degraded state: going offline says so, below the bar, until the connection comes back. navigator.onLine is the browser's
// own signal (the service worker keeps the opened pages working, which is what the line promises).
function Offline() {
  const [online, setOnline] = useState(() => (typeof navigator === "undefined" ? true : navigator.onLine !== false));
  useEffect(() => {
    const on = () => setOnline(true);
    const off = () => setOnline(false);
    window.addEventListener("online", on);
    window.addEventListener("offline", off);
    return () => { window.removeEventListener("online", on); window.removeEventListener("offline", off); };
  }, []);
  if (online) return null;
  return <div className="hfy-offline-banner" role="status" data-hfy-offline-banner><p>you're offline. the pages you already opened still work.</p></div>;
}

function Content() {
  const { ref } = useShellScroll();
  const slot = useRef(null);
  useEffect(() => {
    // Move the existing page into the scroller. Scripts, [data-hfy-keep] fixed overlays (preview-flags banner) and Bootstrap
    // .modal dialogs stay direct children of <body>: a modal inside the scroller sits under its own backdrop (the backdrop is
    // appended to <body>), which is what blocked the person-page lightbox. person-page.js re-parents a nested modal before showing it.
    const host = slot.current;
    Array.from(document.body.childNodes).forEach((n) => {
      if (n === host?.closest("#hfy-shell-root")) return;
      if (n.nodeType === 1 && /^(SCRIPT|NOSCRIPT)$/.test(n.nodeName)) return;
      if (n.nodeType === 1 && n.hasAttribute("data-hfy-keep")) return;
      if (n.nodeType === 1 && n.classList.contains("modal")) return;
      if (n.nodeType === 3 && !n.textContent.trim()) return;
      host.appendChild(n);
    });
  }, []);
  return (
    // HFY-TSK-069 (D-11 item 5): the scroller overflows with no focusable child on some pages (axe scrollable-region-focusable), so it
    // is focusable (tabIndex 0) and named. It is a region, not a <main>: the page's own Eleventy <main> is the only main landmark.
    <div ref={ref} className="hfy-scroller" data-io-scroller role="region" aria-label="page content" tabIndex={0}>
      <InstallPrompt />
      <div className="hfy-content" ref={slot} />
    </div>
  );
}

// searchV2 (HFY-TSK-065): SearchLauncher gets local-corpus suggestions; with the flag off it only routes to /search/?q=.
function useFlag(name, initial = false) {
  const [on, setOn] = useState(initial);
  useEffect(() => { window.HFYFeatureFlags?.resolveFlags?.().then((f) => setOn(f[name] === true)); }, [name]);
  return on;
}

function Account({ notifyV2, navMe }) {
  const session = useEdgeSession();
  const bp = useBreakpoint();
  const [open, setOpen] = useState(false);
  if (session === undefined) return <span className="hfy-account__skel" aria-hidden="true" data-hfy-account="loading" data-slot="account" />;
  if (!memberSub(session)) {
    // authV2 signed out: the edge sign-in. authV2 off / edge unreachable: the legacy entry, which hands `next` to the edge when authV2 is on.
    const href = session ? `/auth/login?returnTo=${encodeURIComponent(here())}` : `/family-login/?next=${encodeURIComponent(here())}`;
    return <a className="hfy-signin" href={href} data-hfy-account="signed-out" data-slot="account">sign in</a>;
  }
  const label = String(session.label || session.sub);
  const initial = label.trim().charAt(0).toUpperCase() || "?";
  return (
    <>
      <button type="button" className="hfy-account__btn" aria-label={`you're signed in as ${label}`} aria-haspopup="dialog" data-hfy-account="signed-in" data-slot="account" onClick={() => setOpen(true)}>
        <span className="hfy-avatar" aria-hidden="true">{initial}</span>
      </button>
      <Sheet open={open} onClose={() => setOpen(false)} side={bp === "compact" ? "bottom" : "right"} title={label} closeLabel="close" className="hfy-account">
        <ul className="hfy-account__list">
          <li><a className="hfy-account__item" href={ownRoute(session.sub)}>your page</a></li>
          {/* navMe: the notification settings move into the hub, which the sheet opens as "settings" */}
          {navMe ? <li><a className="hfy-account__item" href={SETTINGS_ROUTE}>settings</a></li> : notifyV2 && <li><a className="hfy-account__item" href="/me/notifications/">notifications</a></li>}
          <li><button type="button" className="hfy-account__item" onClick={() => { setOpen(false); signOut(); }}>sign out</button></li>
        </ul>
      </Sheet>
    </>
  );
}

function MagnifierIcon() {
  return (
    <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden="true" focusable="false">
      <circle cx="11" cy="11" r="7" /><path d="m20 20-3.5-3.5" />
    </svg>
  );
}

// The gear (HFY-TSK-091, navMe): the settings hub, signed in only (settings need a session), before the account control. A 44px link
// with a single-weight gear drawn as a currentColor mask (shell.css), gold when current: on /me/ and its sub-paths.
function Gear() {
  const current = onSettings(window.location.pathname);
  return (
    <a className="hfy-gear" href={SETTINGS_ROUTE} aria-label="settings" aria-current={current ? "page" : undefined} data-hfy-gear data-slot="gear">
      <span className="hfy-gear__icon" aria-hidden="true" />
    </a>
  );
}

// A filled bell/chat slot: a display:contents host the filling island mounts into (lib/bar-slots.js); withdrawn, it unmounts.
function SlotHost({ name, entry }) {
  const ref = useRef(null);
  useEffect(() => {
    // A throwing filler must not take the shell down: log it and leave the slot empty.
    let cleanup;
    try { cleanup = entry.mount(ref.current); } catch (err) { console.error(`HFYBarSlots: the ${name} filler threw while mounting`, err); }
    return () => { if (typeof cleanup === "function") { try { cleanup(); } catch (err) { console.error(`HFYBarSlots: the ${name} filler threw in cleanup`, err); } } };
  }, [entry]);
  return <span ref={ref} className="hfy-bar__slot" data-slot={name} />;
}

// .hfy-bar__end: the four ordered slots (HFY-TSK-138, review DL-13): bell, chat, gear, account. The gear (navMe, signed in) and the
// account control are the shell's own; the bell and the chat entry render only once their island has filled them, and render nothing
// (no element, no space) before.
function BarEnd({ navMe, notifyV2, sub }) {
  const reg = barSlots();
  useSyncExternalStore(reg.subscribe, reg.snapshot, reg.snapshot);
  return (
    <div className="hfy-bar__end">
      {SLOT_ORDER.map((name) => {
        if (name === "gear") return navMe && sub ? <Gear key={name} /> : null;
        if (name === "account") return <Account key={name} notifyV2={notifyV2} navMe={navMe} />;
        const entry = reg.get(name);
        return entry ? <SlotHost key={name} name={name} entry={entry} /> : null;
      })}
    </div>
  );
}

function Shell({ flags }) {
  const searchV2 = useFlag("searchV2");
  // notifyV2 (HFY-TSK-068): "me" opens the notification settings page (without navMe).
  const notifyV2 = useFlag("notifyV2");
  // navMe (HFY-TSK-091) and familyViz (viz domain) change how many items the bar has, so they start from the flags the shell was
  // mounted with (resolved before the mount, below) instead of false: the bottom bar never paints five cells and then four.
  const navMe = useFlag("navMe", flags.navMe === true);
  const familyViz = useFlag("familyViz", flags.familyViz === true);
  // The own-page tab opens the member's own page once the edge session names them; until then (pending, signed out, authV2 off) it is
  // the stable /private/ redirect, which decides the same way. Only an authenticated session with a sub gives an own page.
  const session = useEdgeSession();
  const sub = memberSub(session);
  const nav = useMemo(() => navItems({ navMe, familyViz, notifyV2, sub }), [navMe, familyViz, notifyV2, sub]);
  const registry = useMemo(() => defineNavRegistry({ items: nav.map((i) => ({ ...i, placement: "primary" })), stack: "enceladus" }), [nav]);
  const pathname = navPathname(window.location, sub);
  const router = useMemo(() => ({ pathname, navigate }), [pathname]);
  // stack "enceladus" only names the kit's data-theme; no harrisonfamily selector matches it, so it is inert (a StackName
  // "harrisonfamily" is a kit follow-up). The theme resolves on :root from the static layer.
  return (
    <KitShell frame="bare" registry={registry} user={{ groups: [] }} router={router} stack="enceladus" title="Harrison Family" palette={false}>
      <div className="hfy-col">
        <ScrollTopZone as="header" className="hfy-bar">
          <a className="hfy-bar__brand" href="/">Harrison Family</a>
          <nav className="hfy-bar__links" aria-label="primary">
            {nav.map((i) => <a key={i.id} href={i.route} aria-current={isCurrent(pathname, i.route) ? "page" : undefined}>{i.label}</a>)}
          </nav>
          <SearchLauncher
            to="/search/"
            label="search"
            placeholder="search the family"
            suggest={searchV2 ? suggestPeople : undefined}
            icon={<><MagnifierIcon /><span className="hfy-bar__search-hint" aria-hidden="true">search the family</span></>}
          />
          <BarEnd navMe={navMe} notifyV2={notifyV2} sub={sub} />
        </ScrollTopZone>
        <Offline />
        <Content />
      </div>
    </KitShell>
  );
}

document.documentElement.classList.add("io-no-focus-zoom");
// The slot registry exists from the first script tick, so an island that loads before the shell can already fill its slot.
barSlots();
// The loader injects this island only after resolveFlags() settled, so this awaits an already settled promise, not a fetch: the shell
// mounts with the flags that decide the bar's shape (navMe, familyViz) already known.
Promise.resolve(window.HFYFeatureFlags?.resolveFlags?.())
  .catch(() => null)
  .then((flags) => { mountAt((h) => document.body.prepend(h), <Shell flags={flags || {}} />, "hfy-shell-root"); });

// Offline shell only. 068 plugs @io-kit/notify's notify-sw into /sw.js (see the hook there).
// Registered at /sw.js?v=<sha8 of sw.js> (stamped into feature-flags.js by islands/build.mjs): updateViaCache "none" makes the
// browser skip its own HTTP cache for the worker script, but Cloudflare's edge may still hold a 4 h old /sw.js; a new ?v is a new
// URL the edge has never seen, and the worker takes its cache name from it. Without the stamp (an unbuilt checkout) it is /sw.js.
if ("serviceWorker" in navigator) {
  const versions = (typeof window !== "undefined" && window.HFYFeatureFlags && window.HFYFeatureFlags.assetVersions) || {};
  const swUrl = versions.sw ? `/sw.js?v=${versions.sw}` : "/sw.js";
  navigator.serviceWorker.register(swUrl, { scope: "/", updateViaCache: "none" }).catch(() => {});
}
