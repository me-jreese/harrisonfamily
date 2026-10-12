/* HFY-TSK-064: offline shell only. Registered by the shellV2 island; scope "/". Serve with Cache-Control: no-cache. */
// HFY-R58: bump VERSION whenever the caching strategy changes; activate drops every other cache (incl. stale shell.js).
const VERSION = "hfy-shell-v2";
const PRECACHE = ["/offline.html", "/js/islands/shell.js", "/js/islands/shell.css", "/manifest.webmanifest", "/images/pwa-192.png"];
const ISLANDS = "/js/islands/";
const CHUNKS = "/js/islands/chunks/";

// HFY-TSK-068: @io-kit/notify's notify-sw (push + notificationclick deep links) is copied to /js/islands/ by islands/build.mjs.
try { importScripts("/js/islands/notify-sw.js"); } catch (e) { /* not shipped yet */ }

self.addEventListener("install", (event) => {
  event.waitUntil(caches.open(VERSION).then((c) => Promise.all(PRECACHE.map((u) => c.add(u).catch(() => {})))));
});
self.addEventListener("activate", (event) => {
  event.waitUntil(caches.keys().then((keys) => Promise.all(keys.filter((k) => k !== VERSION).map((k) => caches.delete(k)))).then(() => self.clients.claim()));
});
self.addEventListener("message", (event) => { if (event.data === "SKIP_WAITING" || (event.data && event.data.type === "SKIP_WAITING")) self.skipWaiting(); });

// Clone synchronously, before the response is handed to respondWith (whose body the browser then consumes);
// the cache write is kept alive with waitUntil.
function fetchAndStore(event, req) {
  return fetch(req).then((res) => {
    if (res.ok && res.status === 200 && res.type === "basic") {
      const copy = res.clone();
      event.waitUntil(caches.open(VERSION).then((c) => c.put(req, copy)).catch(() => {}));
    }
    return res;
  });
}

self.addEventListener("fetch", (event) => {
  const req = event.request;
  if (req.method !== "GET") return;
  const url = new URL(req.url);
  if (url.origin !== location.origin || /^\/(auth|api)(\/|$)/.test(url.pathname)) return;
  if (req.mode === "navigate") {
    event.respondWith(fetch(req).catch(() => caches.match("/offline.html")));
    return;
  }
  // Content-hashed chunks never change under a URL: cache-first, stored on first use so the shell works offline.
  if (url.pathname.startsWith(CHUNKS)) {
    event.respondWith(caches.match(req).then((hit) => hit || fetchAndStore(event, req)));
    return;
  }
  // Stable names (shell.js, <island>.js/.css, manifest, ...): network-first, so after a deploy the entry module always
  // matches the chunk hashes that are actually on the server; the cached copy is only the offline fallback.
  if (PRECACHE.includes(url.pathname) || url.pathname.startsWith(ISLANDS)) {
    event.respondWith(fetchAndStore(event, req).catch(() => caches.match(req).then((hit) => hit || Response.error())));
  }
});
