// HFY-TSK-062: flag-gated two-path sign-in (GIS + Cognito password at https://harrisonfamily.us/auth).
// Reads /_data/flags.json. With authV2 off (the default) this script does nothing and the legacy GIS flow runs unchanged.
// With authV2 on: /family-login/ redirects to /auth/login, and a signed-in visitor (GET /auth/session) gets "My Record" -> /person/?id=<gramps_id>.
// HFY-R58 fallbacks:
// - /auth/session must answer (200 JSON with a boolean "authenticated") before anything changes. If it is unreachable
//   (edge not attached, network error, HTML error page) the preview override is cleared and the legacy flow runs untouched.
// - An already edge-authenticated visitor who lands on /family-login/ is NOT bounced to /auth/login again: the edge session
//   does not mint the legacy X-HFY-Session token that person/search pages need, so they get the legacy GIS sign-in instead
//   of a redirect loop.
// - "Log out" ends the edge session AND runs the legacy signOut (Google ID token, gramps id, gateway session, auto-select).
// HFY-R66: the session probe is HFYFeatureFlags.edgeSession() (one GET /auth/session per page, shared with the data fetches),
// which refreshes a lapsed io_id from the refresh cookie once before reporting. An authenticated edge session is laid over the
// legacy feature state there, so the navbar search, My Record and Log out follow the edge session (navbarSearch was hidden
// for edge-only sign-ins before).
(function () {
  var SIGNOUT_LOCAL_KEYS = ["HFY_AUTH_ID_TOKEN", "HFY_AUTH_USER_GRAMPS_ID", "hfy:edge-session"];
  var SIGNOUT_SESSION_KEYS = ["HFY_GATEWAY_SESSION_V1"];
  var LOGOUT_TIMEOUT_MS = 4000;

  function getJSON(url, init) {
    return fetch(url, init).then(function (r) { return r.ok ? r.json() : null; }).catch(function () { return null; });
  }
  function show(el) { if (el) { el.classList.remove("d-none"); el.hidden = false; } }
  function hide(el) { if (el) { el.classList.add("d-none"); el.hidden = true; } }
  function flags() { return window.HFYFeatureFlags || null; }
  function dependencyUnavailable(what) {
    var f = flags();
    if (f && typeof f.flagUnavailable === "function") f.flagUnavailable(what);
  }
  // Resolves {authenticated, sub, ...} or null when /auth/session is unreachable (not a 200 JSON with a boolean "authenticated").
  function sessionProbe() {
    var f = flags();
    if (f && typeof f.edgeSession === "function") return f.edgeSession();
    return getJSON("/auth/session", { credentials: "same-origin", cache: "no-store" }).then(function (s) {
      return s && typeof s.authenticated === "boolean" ? s : null;
    });
  }

  function apply(session) {
    var link = document.querySelector("[data-my-record-link]");
    if (link) {
      link.setAttribute("href", "/person/?id=" + encodeURIComponent(session.sub));
      link.removeAttribute("aria-disabled");
      show(link.closest("li"));
    }
    hide(document.querySelector('[data-feature="familyLoginLink"]'));
    show(document.querySelector('[data-feature="logoutLink"]'));
  }

  // Clears the legacy credentials synchronously so they are gone even if the page is closed mid-logout.
  function clearLegacyCredentials() {
    SIGNOUT_LOCAL_KEYS.forEach(function (k) { try { localStorage.removeItem(k); } catch (e) { /* storage blocked */ } });
    SIGNOUT_SESSION_KEYS.forEach(function (k) { try { sessionStorage.removeItem(k); } catch (e) { /* storage blocked */ } });
    try {
      if (window.google && window.google.accounts && window.google.accounts.id) window.google.accounts.id.disableAutoSelect();
    } catch (e) { /* GIS not loaded */ }
  }

  // Runs the legacy auth.js signOut (state, feature-flag session, subscribers, redirect). Returns false if it is not on the page.
  function legacySignOut() {
    var legacy = window.HFY_AUTH;
    if (!legacy || typeof legacy.signOut !== "function") return false;
    try { legacy.signOut(); return true; } catch (e) { return false; }
  }

  function signOut() {
    clearLegacyCredentials();
    var f = flags();
    if (f && typeof f.forgetEdgeSession === "function") {
      try { f.forgetEdgeSession(); } catch (e) { /* keep signing out */ }
    }
    var done = fetch("/auth/logout", {
      method: "POST",
      credentials: "same-origin",
      keepalive: true,
      headers: { "content-type": "application/json", "x-requested-with": "io-kit" },
      body: "{}"
    }).catch(function () {});
    var timeout = new Promise(function (resolve) { setTimeout(resolve, LOGOUT_TIMEOUT_MS); });
    return Promise.race([done, timeout]).then(function () {
      if (!legacySignOut()) location.assign("/logged-out/");
    });
  }

  function wireSignOut() {
    var links = document.querySelectorAll("[data-auth-signout-link]");
    Array.prototype.forEach.call(links, function (out) {
      if (out.getAttribute("data-auth-v2-wired") === "1") return;
      out.setAttribute("data-auth-v2-wired", "1");
      // Capture phase so the edge logout is sent before the legacy handler navigates away; the legacy signOut is then
      // invoked explicitly (signOut above), so stopping propagation never skips the legacy cleanup.
      out.addEventListener("click", function (ev) {
        ev.preventDefault();
        ev.stopImmediatePropagation();
        signOut();
      }, true);
    });
  }

  // HFY-TSK-064: honour the ?hfy_flags runtime override via feature-flags.js when available
  var flagsReady = (flags() && flags().resolveFlags)
    ? flags().resolveFlags()
    : getJSON("/_data/flags.json", { cache: "no-store" });
  flagsReady.then(function (f) {
    if (!f || f.authV2 !== true) return;
    sessionProbe().then(function (s) {
      if (!s) {
        dependencyUnavailable("/auth/session");
        return;
      }
      if (/^\/family-login\/?$/.test(location.pathname)) {
        if (s.authenticated !== true) {
          location.replace("/auth/login?returnTo=" + encodeURIComponent("/"));
          return;
        }
        // Already signed in at the edge: keep the legacy sign-in on this page (see header) rather than looping.
      }
      if (s.authenticated !== true || !s.sub) return;
      // legacy feature-flags.js/auth.js also toggle these nav items; re-apply once they have settled
      apply(s);
      wireSignOut();
      window.addEventListener("load", function () { apply(s); setTimeout(function () { apply(s); }, 600); });
    });
  });
})();
