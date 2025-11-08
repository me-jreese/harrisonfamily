(function () {
  const config = window.HFY_FEATURE_FLAGS || {};
  const components = config.components || {};
  const gatewayConfig = config.gateway || {};
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
      applyFeatureVisibility();
      return payload;
    } catch (error) {
      console.error(`${LOG_PREFIX} verification failed`, error);
      state.loggedIn = false;
      state.sessionToken = null;
      state.userGrampsID = null;
      state.hasRecord = false;
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
})();
