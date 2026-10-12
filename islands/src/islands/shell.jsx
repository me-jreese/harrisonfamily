// KitShell (frame="bare") replaces the Bootstrap navbar on every page when flag shellV2 is on (HFY-TSK-064).
import "../shell.css";
import { useEffect, useRef, useState } from "react";
import { defineNavRegistry } from "@io-kit/shell";
import { KitShell, ScrollTopZone, SearchLauncher, useShellScroll, usePwaInstall, useDisplayMode, detectPlatform } from "@io-kit/shell/react";
import { mountAt } from "../lib/mount.jsx";
import { suggestPeople } from "../lib/people-corpus.js";

// Nav registry (R8): the four top-level destinations.
export const NAV = [
  { id: "home", label: "Home", route: "/", icon: "\u2302", order: 1 },
  { id: "family", label: "Family", route: "/private/", icon: "\u2665", order: 2 },
  { id: "posts", label: "Posts", route: "/posts/", icon: "\u270E", order: 3 },
  { id: "me", label: "Me", route: "/family-login/", icon: "\u263A", order: 4 }
];
const registry = defineNavRegistry({ items: NAV.map((i) => ({ ...i, placement: "primary" })), stack: "enceladus" });
const router = { pathname: window.location.pathname, navigate: (href) => window.location.assign(href) };

function InstallPrompt() {
  const { canInstall, prompt, installed } = usePwaInstall();
  const mode = useDisplayMode();
  const [dismissed, setDismissed] = useState(() => { try { return localStorage.getItem("hfy:install-dismissed") === "1"; } catch { return false; } });
  const ios = detectPlatform() === "ios";
  const standalone = installed || mode === "standalone";
  if (dismissed || standalone || !(canInstall || ios)) return null;
  const dismiss = () => { try { localStorage.setItem("hfy:install-dismissed", "1"); } catch { /* ignore */ } setDismissed(true); };
  return (
    <div className="hfy-install" role="region" aria-label="Install the app" data-hfy-install>
      {ios ? <p>To install: tap the Share button, then choose Add to Home Screen.</p> : <p>Install Harrison Family on this device for quick access.</p>}
      {!ios && <button type="button" onClick={() => prompt()}>Install</button>}
      <button type="button" onClick={dismiss}>Not now</button>
    </div>
  );
}

function Content() {
  const { ref } = useShellScroll();
  const slot = useRef(null);
  useEffect(() => {
    // Move the existing page (everything but scripts and our root) into the scroller; scripts stay put.
    const host = slot.current;
    Array.from(document.body.childNodes).forEach((n) => {
      if (n === host?.closest("#hfy-shell-root")) return;
      if (n.nodeType === 1 && /^(SCRIPT|NOSCRIPT)$/.test(n.nodeName)) return;
      if (n.nodeType === 3 && !n.textContent.trim()) return;
      host.appendChild(n);
    });
  }, []);
  return (
    <main ref={ref} data-io-scroller style={{ flex: "1 1 auto", minHeight: 0, overflowY: "auto" }}>
      <InstallPrompt />
      <div className="hfy-content" ref={slot} />
    </main>
  );
}

// searchV2 (HFY-TSK-065): SearchLauncher gets local-corpus suggestions; with the flag off it only routes to /search/?q=.
function useSearchV2() {
  const [on, setOn] = useState(false);
  useEffect(() => { window.HFYFeatureFlags?.resolveFlags?.().then((f) => setOn(f.searchV2 === true)); }, []);
  return on;
}

function Shell() {
  const searchV2 = useSearchV2();
  return (
    <KitShell frame="bare" registry={registry} user={{ groups: [] }} router={router} stack="enceladus" title="Harrison Family" palette={false}>
      <div className="hfy-col">
      <ScrollTopZone as="header" className="hfy-bar io-safe-top">
        <a className="hfy-bar__brand" href="/">HARRISON FAMILY</a>
        <nav className="hfy-bar__links" aria-label="Primary">
          {NAV.map((i) => <a key={i.id} href={i.route} aria-current={router.pathname === i.route ? "page" : undefined}>{i.label}</a>)}
        </nav>
        <div className="hfy-bar__end"><SearchLauncher to="/search/" label="Search" placeholder="Search the family" suggest={searchV2 ? suggestPeople : undefined} /></div>
      </ScrollTopZone>
      <Content />
      </div>
    </KitShell>
  );
}

document.documentElement.classList.add("io-no-focus-zoom");
mountAt((h) => document.body.prepend(h), <Shell />, "hfy-shell-root");

// Offline shell only. 068 plugs @io-kit/notify's notify-sw into /sw.js (see the hook there).
if ("serviceWorker" in navigator) {
  navigator.serviceWorker.register("/sw.js", { scope: "/", updateViaCache: "none" }).catch(() => {});
}
