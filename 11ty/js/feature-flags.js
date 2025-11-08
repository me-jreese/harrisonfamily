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
    return state.sessionToken || null;
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
    verifySession,
    requireSessionToken
  };

  window.HFYFeatureFlags = featureAPI;

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
