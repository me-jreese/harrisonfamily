// HFY-TSK-062: the sign-in script. The edge sign-in at https://harrisonfamily.us/auth (Google through Cognito federation, or a
// passkey) is the only sign-in (HFY-TSK-317 removed the Google Identity Services client, its sign-in script and the legacy allowlist endpoint).
// Reads /_data/flags.json. With authV2 off this script does nothing.
// With authV2 on, a signed-in visitor (GET /auth/session) gets "My Record" -> /person/?id=<gramps_id> and "Log out"; signed out, the
// sign-in links (data-feature="familyLoginLink") point straight at /auth/login?returnTo=<this page>.
// HFY-R58 fallback: /auth/session must answer (200 JSON with a boolean "authenticated") before anything changes. If it is
// unreachable (edge not attached, network error, HTML error page) the preview override is cleared and the page is left as it is.
// HFY-R66: the session probe is HFYFeatureFlags.edgeSession() (one GET /auth/session per page, shared with the data fetches),
// which refreshes a lapsed io_id from the refresh cookie once before reporting. An authenticated edge session is laid over the
// feature state there, so My Record and Log out follow the edge session.
// /family-login/ is a static redirect page to /auth/login (11ty/family-login/index.html), so old bookmarks still work.
(function () {
  var SIGNOUT_LOCAL_KEYS = ["hfy:edge-session"];
  // The keys the retired Google sign-in left behind are purged by feature-flags.js (HFYFeatureFlags.purgeRetiredKeys), which every page loads.
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

  // Login continuity (HFY-TSK-069 D-11 item 6): the return target of a sign-in link is a same-origin PATH only, by the same rules as
  // the edge's returnTo guard (@io-kit/auth safeReturnTo): exactly one leading "/" (so no "//", no scheme, no host), no
  // backslash, no tab/CR/LF or other control character. Anything else (and the sign-in pages themselves, which would loop) falls
  // back to "/".
  var FALLBACK_RETURN = "/";
  function safeReturnPath(raw) {
    if (typeof raw !== "string" || raw === "" || raw.length > 2048) return FALLBACK_RETURN;
    if (raw.charAt(0) !== "/" || raw.charAt(1) === "/") return FALLBACK_RETURN;
    if (/[\\\u0000-\u001f\u007f]/.test(raw)) return FALLBACK_RETURN;
    if (/^\/(auth|family-login)(\/|\?|#|$)/i.test(raw)) return FALLBACK_RETURN;
    return raw;
  }
  // Signed out under authV2: "sign in" (the home hero button, the navbar link) goes straight to the edge sign-in and comes back to
  // this page. The static href is /auth/login (no return) for authV2 off, and until /auth/session has answered.
  function pointSignInLinks() {
    var href = "/auth/login?returnTo=" + encodeURIComponent(safeReturnPath(location.pathname + location.search + location.hash));
    Array.prototype.forEach.call(document.querySelectorAll('[data-feature="familyLoginLink"]'), function (el) {
      var link = el.tagName === "A" ? el : el.querySelector('a[href^="/auth/login"]');
      if (link) link.setAttribute("href", href);
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

  // Clears the local sign-in marker synchronously so it is gone even if the page is closed mid-logout.
  function clearLocalMarkers() {
    SIGNOUT_LOCAL_KEYS.forEach(function (k) { try { localStorage.removeItem(k); } catch (e) { /* storage blocked */ } });
  }

  function signOut() {
    clearLocalMarkers();
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
      location.assign("/logged-out/");
    });
  }

  function wireSignOut() {
    var links = document.querySelectorAll("[data-auth-signout-link]");
    Array.prototype.forEach.call(links, function (out) {
      if (out.getAttribute("data-auth-v2-wired") === "1") return;
      out.setAttribute("data-auth-v2-wired", "1");
      // Capture phase so the edge logout is sent before any other click handler navigates away.
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
      if (s.authenticated !== true) pointSignInLinks();
      if (s.authenticated !== true || !s.sub) return;
      // feature-flags.js also toggles these nav items; re-apply once it has settled
      apply(s);
      wireSignOut();
      window.addEventListener("load", function () { apply(s); setTimeout(function () { apply(s); }, 600); });
    });
  });
})();
