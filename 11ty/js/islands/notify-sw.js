/* eslint-disable no-undef */
// @io-kit/notify service-worker handler. importScripts it from the generated
// service worker. Handles classic pushes and the declarative web push (8030)
// wrapper; tapping a notification focuses a window and navigates it.
self.addEventListener("push", (event) => {
  let data;
  try { data = event.data ? event.data.json() : {}; } catch { data = {}; }
  const n = data.notification || data;
  const badge = n.app_badge === null || n.app_badge === undefined || n.app_badge === "" ? NaN : Number(n.app_badge);
  const opts = { body: n.body || "", data: { navigate: n.navigate || "/" }, renotify: false };
  if (n.tag) opts.tag = n.tag;
  event.waitUntil(Promise.all([
    self.registration.showNotification(n.title || "Notification", opts),
    Number.isFinite(badge) && self.navigator && self.navigator.setAppBadge
      ? self.navigator.setAppBadge(badge).catch(() => {}) : null,
  ]));
});

self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  const target = (event.notification.data && event.notification.data.navigate) || "/";
  event.waitUntil((async () => {
    const wins = await self.clients.matchAll({ type: "window", includeUncontrolled: true });
    for (const w of wins) {
      if (w.focus) {
        await w.focus();
        if (w.navigate) { try { await w.navigate(target); } catch { /* ignore */ } }
        return;
      }
    }
    await self.clients.openWindow(target);
  })());
});
