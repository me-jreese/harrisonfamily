// "sign out", shared by the shell's account sheet and the settings hub (HFY-TSK-091). It proxies the legacy navbar link, which
// auth-v2.js wires to end the edge session AND run the legacy signOut. Pages without the navbar (posts/, me/, me/notifications/) do
// not load auth-v2.js, so the fallback ends the edge session the same way (POST /auth/logout, x-requested-with: io-kit) before going
// to /logged-out/; a bare location.assign would leave the visitor signed in.
export function signOut() {
  const link = document.querySelector("nav.navbar-hf [data-auth-signout-link]");
  if (link && link.getAttribute("data-auth-v2-wired") === "1") { link.click(); return; }
  try { window.HFYFeatureFlags?.forgetEdgeSession?.(); } catch { /* keep signing out */ }
  for (const k of ["HFY_AUTH_ID_TOKEN", "HFY_AUTH_USER_GRAMPS_ID", "hfy:edge-session"]) { try { localStorage.removeItem(k); } catch { /* storage blocked */ } }
  try { sessionStorage.removeItem("HFY_GATEWAY_SESSION_V1"); } catch { /* storage blocked */ }
  const done = fetch("/auth/logout", { method: "POST", credentials: "same-origin", keepalive: true, headers: { "content-type": "application/json", "x-requested-with": "io-kit" }, body: "{}" }).catch(() => {});
  Promise.race([done, new Promise((r) => setTimeout(r, 4000))]).then(() => {
    try { if (typeof window.HFY_AUTH?.signOut === "function") { window.HFY_AUTH.signOut(); return; } } catch { /* fall through */ }
    window.location.assign("/logged-out/");
  });
}
