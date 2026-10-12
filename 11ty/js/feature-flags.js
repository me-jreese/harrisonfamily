(function () {
  const config = window.HFY_FEATURE_FLAGS || {};
  const components = config.components || {};
  const gatewayConfig = config.gateway || {};
  const SESSION_STORAGE_KEY = "HFY_GATEWAY_SESSION_V1";
  const state = Object.assign(
    {
      loggedIn: false,
      sessionToken: null,
      userGrampsID: null,
      hasRecord: false,
      sessionExpiresAt: null,
      verifying: false,
      verifiedAt: null
    },
    config.defaultState || {}
  );
  const ANY = "any";
  const LOG_PREFIX = "[HFYFeatureFlags]";
  const debugEnabled = (() => {
    if (config.debug) {
      return true;
    }
    if (typeof window !== "undefined" && window.HFY_DEBUG_FEATURES === true) {
      return true;
    }
    try {
      return typeof localStorage !== "undefined" && localStorage.getItem("HFY_DEBUG_FEATURES") === "true";
    } catch (error) {
      console.warn(`${LOG_PREFIX} Unable to read HFY_DEBUG_FEATURES flag`, error);
      return false;
    }
  })();

  function logDebug(message, ...args) {
    if (debugEnabled) {
      console.debug(`${LOG_PREFIX} ${message}`, ...args);
    }
  }

  const isProductionHost =
    typeof window !== "undefined" &&
    window.location &&
    window.location.hostname === "harrisonfamily.us";
  if (isProductionHost && gatewayConfig.enforceAssets !== true) {
    console.error(
      `${LOG_PREFIX} Production domain detected but enforceAssets was false. Forcing it to true to protect gated assets.`
    );
    gatewayConfig.enforceAssets = true;
  }

  hydrateSessionState();

  function normalizeAllowed(allowed) {
    if (!allowed) {
      return [ANY];
    }

    if (!Array.isArray(allowed)) {
      return [allowed];
    }

    return allowed;
  }

  function matchesCondition(value, allowedValues) {
    const normalized = normalizeAllowed(allowedValues);
    if (normalized.includes(ANY)) {
      return true;
    }

    const candidate = value === undefined || value === null ? "unknown" : value;
    return normalized.map(String).includes(String(candidate));
  }

  function shouldShow(featureKey, contextState = state) {
    const featureConfig = components[featureKey];
    if (!featureConfig || !featureConfig.showWhen) {
      return true;
    }

    return Object.entries(featureConfig.showWhen).every(([conditionKey, allowedValues]) => {
      return matchesCondition(contextState[conditionKey], allowedValues);
    });
  }

  function setVisibility(node, visible) {
    node.dataset.featureVisible = visible ? "true" : "false";
    if (node.hasAttribute("hidden") || !visible) {
      node.toggleAttribute("hidden", !visible);
    }
    if (visible) {
      node.classList.remove("d-none");
      node.removeAttribute("aria-hidden");
    } else {
      node.classList.add("d-none");
      node.setAttribute("aria-hidden", "true");
    }
  }

  function applyFeatureVisibility() {
    const nodes = document.querySelectorAll("[data-feature]");
    nodes.forEach((node) => {
      const featureKey = node.getAttribute("data-feature");
      if (!featureKey) {
        return;
      }
      setVisibility(node, shouldShow(featureKey));
    });
  }

  async function verifySession({ googleIdToken } = {}) {
    if (!gatewayConfig.endpoint) {
      logDebug("No gateway endpoint configured; treating session as anonymous.");
      return false;
    }

    if (!googleIdToken) {
      logDebug("verifySession called without googleIdToken");
    }

    try {
      state.verifying = true;
      logDebug("POSTing to gateway endpoint", {
        endpoint: gatewayConfig.endpoint,
        context: gatewayConfig.context,
        hasIdToken: Boolean(googleIdToken)
      });
      const response = await fetch(gatewayConfig.endpoint, {
        method: "POST",
        headers: {
          "Content-Type": "application/json"
        },
        body: JSON.stringify({
          id_token: googleIdToken,
          context: gatewayConfig.context || "site"
        }),
        credentials: "include"
      });

      if (!response.ok) {
        throw new Error(`Gateway response ${response.status}`);
      }

      const payload = await response.json();
      if (!payload.allowed || !payload.sessionToken) {
        logDebug("Gateway denied access or omitted session token.", payload);
        state.loggedIn = false;
        state.sessionToken = null;
        state.userGrampsID = null;
        state.hasRecord = false;
        clearSessionState();
        return false;
      }

      state.loggedIn = true;
      state.sessionToken = payload.sessionToken;
      state.userGrampsID = payload.grampsId || null;
      state.hasRecord = Boolean(payload.grampsId);
      state.sessionExpiresAt = payload.expiresAt
        ? Date.parse(payload.expiresAt)
        : payload.expiresIn
          ? Date.now() + Number(payload.expiresIn) * 1000
          : null;
      state.verifiedAt = Date.now();
      logDebug("Session verified via gateway.", {
        verifiedAt: state.verifiedAt,
        sessionTokenPreview: `${payload.sessionToken.slice(0, 6)}...`,
        grampsId: payload.grampsId
      });
      persistSessionState({
        token: payload.sessionToken,
        grampsId: payload.grampsId || null
      });
      applyFeatureVisibility();
      return payload;
    } catch (error) {
      console.error(`${LOG_PREFIX} verification failed`, error);
      state.loggedIn = false;
      state.sessionToken = null;
      state.userGrampsID = null;
      state.hasRecord = false;
      clearSessionState();
      return false;
    } finally {
      state.verifying = false;
    }
  }

  function requireSessionToken() {
    if (!state.sessionToken) return null;
    if (state.sessionExpiresAt && Date.now() >= state.sessionExpiresAt) {
      state.sessionToken = null;
      clearSessionState();
      return null;
    }
    return state.sessionToken;
  }

  function onReady(callback) {
    if (document.readyState === "loading") {
      document.addEventListener("DOMContentLoaded", callback, { once: true });
    } else {
      callback();
    }
  }

  const featureAPI = {
    config,
    getState() {
      return Object.assign({}, state);
    },
    getUserGrampsID() {
      return state.userGrampsID || null;
    },
    updateState(partialState = {}) {
      Object.assign(state, partialState);
       if (Object.prototype.hasOwnProperty.call(partialState, "sessionToken") && partialState.sessionToken === null) {
         state.sessionToken = null;
         clearSessionState();
       }
      applyFeatureVisibility();
    },
    shouldShow(featureKey, overrides = {}) {
      const combinedState = Object.assign({}, state, overrides);
      return shouldShow(featureKey, combinedState);
    },
    refresh() {
      applyFeatureVisibility();
    },
    acceptSession(payload) {
      if (!payload || !payload.sessionToken) {
        return false;
      }
      state.loggedIn = true;
      state.sessionToken = payload.sessionToken;
      state.userGrampsID = payload.grampsId || null;
      state.hasRecord = Boolean(payload.grampsId);
      state.sessionExpiresAt = payload.expiresAt
        ? Date.parse(payload.expiresAt)
        : payload.expiresIn
          ? Date.now() + Number(payload.expiresIn) * 1000
          : null;
      state.verifiedAt = Date.now();
      persistSessionState({ token: payload.sessionToken, grampsId: payload.grampsId || null });
      applyFeatureVisibility();
      return true;
    },
    verifySession,
    requireSessionToken
  };

  window.HFYFeatureFlags = featureAPI;

  // HFY-TSK-064 (R42) + HFY-R58: build-time flags (/_data/flags.json) plus a runtime preview override.
  // ?hfy_flags=shellV2,authV2 persists in sessionStorage "hfy:flags" (this tab only, gone when it closes); "-name" forces off;
  // ?hfy_flags= (empty) clears it. While an override is active a small fixed "Preview flags on — turn off" banner is shown,
  // and the override is cleared automatically when a flagged dependency is unavailable (island bundle 404, /auth/session
  // unreachable) so the page falls back to the legacy behaviour.
  // With shellV2 off nothing below changes the page. With it on, the island bundle (islands/ build) is injected.
  const FLAGS_URL = "/_data/flags.json";
  const OVERRIDE_KEY = "hfy:flags";
  const BANNER_ATTR = "data-hfy-flag-banner";
  // Pre-R58 builds kept the override in localStorage with no expiry; purge it so a crafted link cannot stick.
  try {
    localStorage.removeItem(OVERRIDE_KEY);
  } catch (error) {
    logDebug("legacy flag override purge unavailable", error);
  }
  let overrideRaw = "";
  try {
    const q = new URLSearchParams(window.location.search);
    if (q.has("hfy_flags")) {
      const v = (q.get("hfy_flags") || "").trim();
      if (v === "") {
        sessionStorage.removeItem(OVERRIDE_KEY);
      } else {
        sessionStorage.setItem(OVERRIDE_KEY, v);
      }
    }
    overrideRaw = (sessionStorage.getItem(OVERRIDE_KEY) || "").trim();
  } catch (error) {
    logDebug("flag override storage unavailable; honouring the URL for this page only", error);
    try {
      overrideRaw = (new URLSearchParams(window.location.search).get("hfy_flags") || "").trim();
    } catch (ignored) {
      overrideRaw = "";
    }
  }
  const overrideFlags = {};
  overrideRaw.split(",").forEach((token) => {
    const t = token.trim();
    if (!t) return;
    if (t.charAt(0) === "-") overrideFlags[t.slice(1)] = false;
    else overrideFlags[t] = true;
  });
  let overrideActive = Object.keys(overrideFlags).length > 0;

  function removeOverrideBanner() {
    document.querySelectorAll("[" + BANNER_ATTR + "]").forEach((n) => n.remove());
  }

  function clearOverride(reason) {
    try {
      sessionStorage.removeItem(OVERRIDE_KEY);
    } catch (error) {
      logDebug("unable to clear flag override", error);
    }
    try {
      localStorage.removeItem(OVERRIDE_KEY);
    } catch (error) {
      logDebug("unable to clear legacy flag override", error);
    }
    if (overrideActive && reason) {
      console.warn(`${LOG_PREFIX} preview flags turned off: ${reason}`);
    }
    overrideActive = false;
    removeOverrideBanner();
  }

  function turnOffOverride() {
    clearOverride();
    const next = new URL(window.location.href);
    next.searchParams.delete("hfy_flags");
    window.location.replace(next.toString());
  }

  // A flagged dependency is unavailable: drop any preview override (callers fall back to legacy for this page).
  function flagUnavailable(what) {
    if (overrideActive) clearOverride(`${what} unavailable`);
  }

  function renderOverrideBanner() {
    if (!overrideActive || document.querySelector("[" + BANNER_ATTR + "]")) return;
    const style = document.createElement("style");
    style.setAttribute(BANNER_ATTR, "");
    style.textContent =
      "[data-hfy-flag-banner]{position:fixed;left:8px;bottom:calc(8px + env(safe-area-inset-bottom,0px));z-index:2147483000;" +
      "display:flex;align-items:center;gap:4px;max-width:calc(100vw - 16px);box-sizing:border-box;margin:0;padding:0 4px 0 12px;" +
      "border-radius:22px;background:#12384f;color:#fff;font:600 13px/1.2 system-ui,-apple-system,sans-serif;box-shadow:0 2px 8px rgba(0,0,0,.3)}" +
      "html.hfy-shell-v2 [data-hfy-flag-banner]{bottom:calc(72px + env(safe-area-inset-bottom,0px))}" +
      "[data-hfy-flag-banner] button{min-height:44px;min-width:44px;margin:0;padding:0 10px;border:0;background:transparent;color:#ffd54f;" +
      "font:inherit;text-decoration:underline;cursor:pointer}";
    document.head.appendChild(style);
    const bar = document.createElement("div");
    bar.setAttribute(BANNER_ATTR, "");
    bar.setAttribute("data-hfy-keep", ""); // the shell island leaves it in <body> instead of moving it into the scroller
    bar.setAttribute("role", "region");
    bar.setAttribute("aria-label", "Preview flags");
    const label = document.createElement("span");
    label.textContent = "Preview flags on —";
    const off = document.createElement("button");
    off.type = "button";
    off.textContent = "turn off";
    off.setAttribute("aria-label", "Turn off preview flags");
    off.addEventListener("click", turnOffOverride);
    bar.appendChild(label);
    bar.appendChild(off);
    document.body.appendChild(bar);
  }

  featureAPI.overrideActive = () => overrideActive;
  featureAPI.clearOverride = clearOverride;
  featureAPI.flagUnavailable = flagUnavailable;
  if (overrideActive) onReady(renderOverrideBanner);

  let flagsPromise = null;
  function resolveFlags() {
    if (!flagsPromise) {
      flagsPromise = fetch(FLAGS_URL, { cache: "no-store" })
        .then((r) => (r.ok ? r.json() : {}))
        .catch(() => ({}))
        .then((build) => {
          const merged = Object.assign({}, build, overrideFlags);
          // HFY-R48: the search island's launcher lives in the shell, so searchV2 implies shellV2 (unless explicitly forced off).
          if (merged.searchV2 === true && overrideFlags.shellV2 !== false) merged.shellV2 = true;
          return merged;
        });
    }
    return flagsPromise;
  }
  featureAPI.resolveFlags = resolveFlags;

  // HFY-TSK-080: the private data paths (/person/*.json, /family|event|note|place|media/*) are gated at the edge by the io_id
  // session cookie (Lambda@Edge, edge-gate/). With authV2 on, data fetches therefore send that cookie (credentials
  // "same-origin") and NOT the legacy X-HFY-Session token, which nothing validates any more. With authV2 off this resolves null
  // and every caller keeps its legacy request exactly as before. NOTE: once the gate is live, authV2-off visitors cannot read
  // person data, which is why the gate and the authV2 flip ship together (cloudfront/README.md, "Private data gate").
  let authV2Seen = false;
  featureAPI.dataFetchInit = function dataFetchInit() {
    return resolveFlags().then((flags) => {
      authV2Seen = flags.authV2 === true;
      return authV2Seen ? { credentials: "same-origin" } : null;
    });
  };
  // Call with each data response: a 401 from the gate under authV2 sends the visitor to the edge sign-in and back.
  featureAPI.dataResponse = function dataResponse(response) {
    if (authV2Seen && response && response.status === 401) {
      window.location.replace("/auth/login?returnTo=" + encodeURIComponent(window.location.pathname + window.location.search + window.location.hash));
    }
    return response;
  };

  // Island loader pattern: HFYFeatureFlags.loadIsland("name") injects /js/islands/<name>.js (+ .css) once.
  // Every requested island has a settle promise: true once its module graph has loaded and run, false on a 404 or
  // network failure (the loader then drops any preview override and the caller's onError restores the legacy UI).
  const islands = {};
  function islandEntry(name) {
    if (!islands[name]) {
      let settle = null;
      const promise = new Promise((resolve) => {
        settle = resolve;
      });
      islands[name] = { promise, settle, script: null };
    }
    return islands[name];
  }
  function loadIsland(name, { onError, onLoad } = {}) {
    const entry = islandEntry(name);
    if (entry.script) return entry.script;
    const css = document.createElement("link");
    css.rel = "stylesheet";
    css.href = "/js/islands/" + name + ".css";
    document.head.appendChild(css);
    const script = document.createElement("script");
    script.type = "module";
    script.src = "/js/islands/" + name + ".js";
    script.onload = function () {
      entry.settle(true);
      if (onLoad) onLoad();
    };
    script.onerror = function () {
      entry.settle(false);
      css.remove();
      flagUnavailable(`island "${name}"`);
      if (onError) onError();
    };
    document.head.appendChild(script);
    entry.script = script;
    return script;
  }
  featureAPI.loadIsland = loadIsland;
  // Resolves true only once the named island actually loaded; false if it was never requested on this page or failed.
  function whenIsland(name) {
    return resolveFlags().then(() => (islands[name] ? islands[name].promise : false));
  }
  featureAPI.whenIsland = whenIsland;
  // HFY-TSK-065 + HFY-R58: legacy search defers to searchV2 only once the replacement has mounted.
  // part "page" = the /search/ island, part "launcher" = the shell's SearchLauncher (replaces navbar search).
  featureAPI.searchV2Live = function searchV2Live(part) {
    return resolveFlags().then((flags) => (flags.searchV2 === true ? whenIsland(part === "page" ? "search" : "shell") : false));
  };

  resolveFlags().then((flags) => {
    // HFY-TSK-066: personV2 swaps person notes to @io-kit/md and adds the kit comments thread (person page only).
    if (flags.personV2 === true && /^\/person\/?$/.test(window.location.pathname) && new URLSearchParams(window.location.search).has("id")) {
      loadIsland("person");
    }
    // HFY-TSK-067: postsV2 adds own-page posting, the homepage timeline and the /posts/ page.
    if (flags.postsV2 === true) {
      const path = window.location.pathname;
      if (/^\/person\/?$/.test(path) && new URLSearchParams(window.location.search).has("id")) loadIsland("my-posts");
      else if (/^\/(index\.html)?$/.test(path)) loadIsland("timeline");
      else if (/^\/posts\/?(index\.html)?$/.test(path)) loadIsland("posts");
    }
    if (flags.shellV2 !== true) return;
    const root = document.documentElement;
    root.classList.add("hfy-shell-v2");
    loadIsland("shell", {
      // HFY-R58: the manifest and theme colour belong to the shell, so they are applied only once it has mounted.
      onLoad() {
        const head = document.head;
        const manifest = document.createElement("link");
        manifest.rel = "manifest";
        manifest.href = "/manifest.webmanifest";
        head.appendChild(manifest);
        const theme = document.createElement("meta");
        theme.name = "theme-color";
        theme.content = "#12384f";
        head.appendChild(theme);
      },
      onError() {
        root.classList.remove("hfy-shell-v2");
      }
    });
  });

  // HFY-TSK-065 (D-09): searchV2 swaps the Lunr search page for the @io-kit/search island (local tier only).
  // The legacy section is hidden while the island loads; search-results.js / search-navbar.js stay wired and only stand
  // down once HFYFeatureFlags.searchV2Live() confirms the island mounted, so a failed island leaves legacy search working.
  resolveFlags().then((flags) => {
    if (flags.searchV2 !== true || !/^\/search\/?(index\.html)?$/.test(window.location.pathname)) return;
    islandEntry("search"); // registered now so searchV2Live("page") waits for the island rather than reporting "not requested"
    const root = document.documentElement;
    root.classList.add("hfy-search-v2");
    const style = document.createElement("style");
    style.textContent = ".hfy-search-v2 [data-search-page]{display:none!important}";
    document.head.appendChild(style);
    onReady(() => {
      const legacy = document.querySelector("[data-search-page]");
      if (legacy) legacy.setAttribute("hidden", "");
      loadIsland("search", {
        onError() {
          root.classList.remove("hfy-search-v2");
          style.remove();
          if (legacy) legacy.removeAttribute("hidden");
        }
      });
    });
  });

  // HFY-TSK-068 (D-08): notifyV2 mounts the notifications island on the static /me/notifications/ page.
  resolveFlags().then((flags) => {
    if (flags.notifyV2 !== true || !/^\/me\/notifications\/?$/.test(window.location.pathname)) return;
    loadIsland("notifications", { onError() { /* the page keeps its "not enabled" text */ } });
  });

  onReady(applyFeatureVisibility);

  function hydrateSessionState() {
    if (typeof sessionStorage === "undefined") {
      return;
    }
    try {
      const raw = sessionStorage.getItem(SESSION_STORAGE_KEY);
      if (!raw) {
        return;
      }
      const parsed = JSON.parse(raw);
      if (!parsed || !parsed.token) {
        sessionStorage.removeItem(SESSION_STORAGE_KEY);
        return;
      }
      if (parsed.expiresAt && Number(parsed.expiresAt) < Date.now()) {
        sessionStorage.removeItem(SESSION_STORAGE_KEY);
        return;
      }
      state.sessionToken = parsed.token;
      state.userGrampsID = parsed.grampsId || null;
      state.hasRecord = Boolean(parsed.grampsId);
      state.sessionExpiresAt = parsed.expiresAt || null;
      state.loggedIn = true;
      state.verifiedAt = parsed.verifiedAt || null;
      logDebug("Restored session token from storage.", {
        hasToken: true,
        grampsId: state.userGrampsID
      });
    } catch (error) {
      console.warn(`${LOG_PREFIX} Unable to hydrate session cache`, error);
    }
  }

  function persistSessionState({ token, grampsId }) {
    if (typeof sessionStorage === "undefined" || !token) {
      return;
    }
    try {
      sessionStorage.setItem(
        SESSION_STORAGE_KEY,
        JSON.stringify({
          token,
          grampsId: grampsId || null,
          expiresAt: state.sessionExpiresAt,
          verifiedAt: state.verifiedAt
        })
      );
    } catch (error) {
      console.warn(`${LOG_PREFIX} Unable to persist session cache`, error);
    }
  }

  function clearSessionState() {
    if (typeof sessionStorage === "undefined") {
      return;
    }
    try {
      sessionStorage.removeItem(SESSION_STORAGE_KEY);
    } catch (error) {
      console.warn(`${LOG_PREFIX} Unable to clear session cache`, error);
    }
  }
})();
