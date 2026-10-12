// HFY-TSK-062: flag-gated two-path sign-in (GIS + Cognito password at https://harrisonfamily.us/auth).
// Reads /_data/flags.json. With authV2 off (the default) this script does nothing and the legacy GIS flow runs unchanged.
// With authV2 on: /family-login/ redirects to /auth/login, and a signed-in visitor (GET /auth/session) gets "My Record" -> /person/?id=<gramps_id>.
(function () {
  function getJSON(url, init) {
    return fetch(url, init).then(function (r) { return r.ok ? r.json() : null; }).catch(function () { return null; });
  }
  function sha256Hex(text) {
    return crypto.subtle.digest("SHA-256", new TextEncoder().encode(text)).then(function (buf) {
      return Array.prototype.map.call(new Uint8Array(buf), function (b) { return b.toString(16).padStart(2, "0"); }).join("");
    });
  }
  function show(el) { if (el) { el.classList.remove("d-none"); el.hidden = false; } }
  function hide(el) { if (el) { el.classList.add("d-none"); el.hidden = true; } }

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

  function wireSignOut() {
    var out = document.querySelector("[data-auth-signout-link]");
    if (!out) return;
    out.addEventListener("click", function (ev) {
      ev.preventDefault();
      ev.stopImmediatePropagation();
      var body = "{}";
      sha256Hex(body).then(function (h) {
        return fetch("/auth/logout", {
          method: "POST", credentials: "same-origin",
          headers: { "content-type": "application/json", "x-requested-with": "io-kit", "x-amz-content-sha256": h }, body: body
        });
      }).catch(function () {}).then(function () { location.assign("/logged-out/"); });
    }, true);
  }

  // HFY-TSK-064: honour the ?hfy_flags runtime override via feature-flags.js when available
  var flagsReady = (window.HFYFeatureFlags && window.HFYFeatureFlags.resolveFlags)
    ? window.HFYFeatureFlags.resolveFlags()
    : getJSON("/_data/flags.json", { cache: "no-store" });
  flagsReady.then(function (flags) {
    if (!flags || flags.authV2 !== true) return;
    if (/^\/family-login\/?$/.test(location.pathname)) {
      location.replace("/auth/login?returnTo=" + encodeURIComponent("/"));
      return;
    }
    getJSON("/auth/session", { credentials: "same-origin", cache: "no-store" }).then(function (s) {
      if (!s || s.authenticated !== true || !s.sub) return;
      // legacy feature-flags.js/auth.js also toggle these nav items; re-apply once they have settled
      apply(s);
      wireSignOut();
      window.addEventListener("load", function () { apply(s); setTimeout(function () { apply(s); }, 600); });
    });
  });
})();
