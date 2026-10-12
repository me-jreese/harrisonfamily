/* HFY-TSK-064: offline shell only. Registered by the shellV2 island; scope "/". Serve with Cache-Control: no-cache. */
const VERSION = "hfy-shell-v1";
const PRECACHE = ["/offline.html", "/js/islands/shell.js", "/js/islands/shell.css", "/manifest.webmanifest", "/images/pwa-192.png"];

// HOOK (HFY-TSK-068): @io-kit/notify's notify-sw (push + notificationclick) is pulled in here once built.
try { importScripts("/js/islands/notify-sw.js"); } catch (e) { /* not shipped yet */ }

self.addEventListener("install", (event) => {
  event.waitUntil(caches.open(VERSION).then((c) => Promise.all(PRECACHE.map((u) => c.add(u).catch(() => {})))));
});
self.addEventListener("activate", (event) => {
  event.waitUntil(caches.keys().then((keys) => Promise.all(keys.filter((k) => k !== VERSION).map((k) => caches.delete(k)))).then(() => self.clients.claim()));
});
self.addEventListener("message", (event) => { if (event.data === "SKIP_WAITING" || (event.data && event.data.type === "SKIP_WAITING")) self.skipWaiting(); });
self.addEventListener("fetch", (event) => {
  const req = event.request;
  if (req.method !== "GET") return;
  const url = new URL(req.url);
  if (url.origin !== location.origin || /^\/(auth|api)(\/|$)/.test(url.pathname)) return;
  if (req.mode === "navigate") {
    event.respondWith(fetch(req).catch(() => caches.match("/offline.html")));
    return;
  }
  if (PRECACHE.includes(url.pathname) || url.pathname.startsWith("/js/islands/")) {
    event.respondWith(caches.match(req).then((hit) => {
      const net = fetch(req).then((res) => { if (res.ok) caches.open(VERSION).then((c) => c.put(req, res.clone())); return res; });
      return hit || net;
    }));
  }
});
