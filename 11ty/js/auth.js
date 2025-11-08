(() => {
  const STORAGE_KEY = "HFY_AUTH_ID_TOKEN";
  const GRAMPS_STORAGE_KEY = "HFY_AUTH_USER_GRAMPS_ID";
  const CONFIG = window.HFY_AUTH_CONFIG || {};
  const DEFAULT_CLIENT_ID = "770284891867-3sfgo71osgn2ani7v4f6s6nj97m15r7e.apps.googleusercontent.com";
  const featureFlags = window.HFYFeatureFlags;
  const listeners = new Set();
  const LOGOUT_REDIRECT = CONFIG.logoutRedirect || "/logged-out/";

  const state = {
    clientId: CONFIG.clientId || DEFAULT_CLIENT_ID,
    idToken: null,
    profile: null,
    signedIn: false,
    initializing: false,
    googleReady: false,
    userGrampsID: null
  };

  const dom = {
    status: null,
    buttonContainer: null,
    signOutBtn: null
  };
  let logoutLinks = [];
  let myRecordLinks = [];
  let hasRedirectedToRecord = false;

  const debugEnabled = (() => {
    if (CONFIG.debug) {
      return true;
    }
    if (typeof window !== "undefined" && window.HFY_DEBUG_AUTH === true) {
      return true;
    }
    try {
      return typeof localStorage !== "undefined" && localStorage.getItem("HFY_DEBUG_AUTH") === "true";
    } catch (error) {
      console.warn("[HFY_AUTH] Unable to read HFY_DEBUG_AUTH flag", error);
      return false;
    }
  })();

  function logDebug(message, ...args) {
    if (debugEnabled) {
      console.debug("[HFY_AUTH]", message, ...args);
    }
  }

  function decodeJwt(token) {
    try {
      const payload = token.split(".")[1];
      const normalized = payload.replace(/-/g, "+").replace(/_/g, "/");
      const json = decodeURIComponent(
        atob(normalized)
          .split("")
          .map((c) => `%${("00" + c.charCodeAt(0).toString(16)).slice(-2)}`)
          .join("")
      );
      return JSON.parse(json);
    } catch (error) {
      logDebug("Failed to decode JWT payload", error);
      return null;
    }
  }

  function setStatus({ message, variant = "info", hidden = false }) {
    if (!dom.status) {
      return;
    }
    dom.status.classList.remove("d-none", "alert-info", "alert-success", "alert-danger", "alert-warning");
    if (hidden) {
      dom.status.classList.add("d-none");
      return;
    }
    dom.status.classList.add(`alert-${variant}`);
    dom.status.innerHTML = message;
  }

  function updateUI() {
    if (dom.buttonContainer) {
      if (state.signedIn) {
        dom.buttonContainer.classList.add("d-none");
        dom.buttonContainer.setAttribute("aria-hidden", "true");
      } else {
        dom.buttonContainer.classList.remove("d-none");
        dom.buttonContainer.removeAttribute("aria-hidden");
      }
    }

    if (dom.signOutBtn) {
      dom.signOutBtn.classList.toggle("d-none", !state.signedIn);
      dom.signOutBtn.setAttribute("aria-hidden", state.signedIn ? "false" : "true");
    }

    if (!dom.status) {
      return;
    }

    if (state.signedIn && state.profile && state.profile.email) {
      setStatus({
        message: `Signed in as <strong>${state.profile.email}</strong>.`,
        variant: "success"
      });
    } else if (!state.signedIn) {
      setStatus({
        message: "Please sign in with your approved Google account to continue.",
        variant: "info"
      });
    }
  }

  function notifySubscribers() {
    const snapshot = {
      signedIn: state.signedIn,
      profile: state.profile,
      idToken: state.idToken ? "[redacted]" : null,
      userGrampsID: state.userGrampsID
    };
    listeners.forEach((fn) => {
      try {
        fn(snapshot);
      } catch (error) {
        console.error("[HFY_AUTH] listener error", error);
      }
    });
  }

  function reflectFeatureFlags() {
    if (!featureFlags || typeof featureFlags.updateState !== "function") {
      return;
    }
    featureFlags.updateState({
      loggedIn: state.signedIn,
      userGrampsID: state.userGrampsID,
      hasRecord: Boolean(state.userGrampsID)
    });
  }

  async function ensureGatewaySession() {
    if (!featureFlags || typeof featureFlags.verifySession !== "function" || !state.idToken) {
      logDebug("Skipping ensureGatewaySession; feature flags or idToken missing.", {
        hasFeatureFlags: Boolean(featureFlags),
        idTokenPresent: Boolean(state.idToken)
      });
      return;
    }
    try {
      logDebug("Verifying session with gateway…");
      const result = await featureFlags.verifySession({
        googleIdToken: state.idToken
      });
      if (result && result.allowed) {
        logDebug("Gateway verification succeeded.", {
          grampsId: result.grampsId,
          hasSessionToken: Boolean(result.sessionToken)
        });
        syncUserRecord(result.grampsId || null);
      } else {
        logDebug("Gateway verification returned denied result.", result);
        syncUserRecord(null);
      }
      notifySubscribers();
    } catch (error) {
      console.error("[HFY_AUTH] Failed to verify session via gateway", error);
    }
  }

  function persistToken(token) {
    if (!token) {
      localStorage.removeItem(STORAGE_KEY);
      return;
    }
    localStorage.setItem(STORAGE_KEY, token);
  }

  function persistUserGrampsID(value) {
    if (!value) {
      localStorage.removeItem(GRAMPS_STORAGE_KEY);
      return;
    }
    localStorage.setItem(GRAMPS_STORAGE_KEY, value);
  }

  function updateMyRecordLinks() {
    const href = state.userGrampsID ? `/person/?id=${encodeURIComponent(state.userGrampsID)}` : null;
    myRecordLinks.forEach((link) => {
      if (!href) {
        link.classList.add("disabled");
        link.setAttribute("aria-disabled", "true");
        link.removeAttribute("href");
      } else {
        link.classList.remove("disabled");
        link.setAttribute("aria-disabled", "false");
        link.setAttribute("href", href);
      }
    });
  }

  function syncUserRecord(grampsId) {
    logDebug("syncUserRecord", { grampsId, previous: state.userGrampsID });
    state.userGrampsID = grampsId || null;
    persistUserGrampsID(state.userGrampsID);
    updateMyRecordLinks();
    reflectFeatureFlags();
    maybeRedirectToRecord();
  }

  function handleCredentialResponse(response) {
    if (!response || !response.credential) {
      logDebug("Credential response missing payload");
      return;
    }
    logDebug("Received credential response from Google Identity.", {
      profilePreview: response.select_by,
      redirecting: window.location.pathname
    });
    state.idToken = response.credential;
    state.profile = decodeJwt(response.credential) || {};
    state.signedIn = true;
    persistToken(response.credential);
    updateUI();
    reflectFeatureFlags();
    ensureGatewaySession();
    notifySubscribers();
  }

  function signOut() {
    if (window.google && window.google.accounts && window.google.accounts.id) {
      window.google.accounts.id.disableAutoSelect();
    }
    state.idToken = null;
    state.profile = null;
    state.signedIn = false;
    hasRedirectedToRecord = false;
    persistToken(null);
    syncUserRecord(null);
    if (featureFlags && typeof featureFlags.updateState === "function") {
      featureFlags.updateState({
        loggedIn: false,
        sessionToken: null,
        userGrampsID: null,
        hasRecord: false
      });
    }
    updateUI();
    setStatus({
      message: "Signed out. Use the button above to sign in again.",
      variant: "warning"
    });
    notifySubscribers();
    if (LOGOUT_REDIRECT) {
      window.location.assign(LOGOUT_REDIRECT);
    }
  }

  function waitForGoogleClient() {
    return new Promise((resolve, reject) => {
      if (window.google && window.google.accounts && window.google.accounts.id) {
        return resolve(window.google.accounts.id);
      }
      let attempts = 0;
      const timer = setInterval(() => {
        attempts += 1;
        if (window.google && window.google.accounts && window.google.accounts.id) {
          clearInterval(timer);
          resolve(window.google.accounts.id);
        } else if (attempts > 50) {
          clearInterval(timer);
          reject(new Error("Google Identity Services script failed to load"));
        }
      }, 100);
    });
  }

  function renderGoogleButton(googleAccounts) {
    if (!dom.buttonContainer || !googleAccounts || typeof googleAccounts.renderButton !== "function") {
      return;
    }
    dom.buttonContainer.innerHTML = "";
    googleAccounts.renderButton(dom.buttonContainer, {
      type: "standard",
      theme: "outline",
      size: "large",
      width: 320,
      text: "signin_with",
      shape: "pill"
    });
  }

  async function initAuthUI() {
    if (!state.clientId) {
      logDebug("No Google client ID configured; skipping auth initialization.");
      return;
    }

    dom.status = document.querySelector("[data-auth-status]");
    dom.buttonContainer = document.querySelector("[data-google-signin-button]");
    dom.signOutBtn = document.querySelector("[data-auth-signout]");
    logoutLinks = Array.from(document.querySelectorAll("[data-auth-signout-link]"));
    myRecordLinks = Array.from(document.querySelectorAll("[data-my-record-link]"));
    updateMyRecordLinks();

    if (dom.signOutBtn) {
      dom.signOutBtn.addEventListener("click", (event) => {
        event.preventDefault();
        signOut();
      });
    }

    logoutLinks.forEach((link) => {
      link.addEventListener("click", (event) => {
        event.preventDefault();
        signOut();
      });
    });

    updateUI();

    try {
      const googleAccounts = await waitForGoogleClient();
      state.googleReady = true;
      googleAccounts.initialize({
        client_id: state.clientId,
        callback: handleCredentialResponse,
        ux_mode: "popup",
        context: "signin",
        auto_select: false
      });
      renderGoogleButton(googleAccounts);
      googleAccounts.prompt();
    } catch (error) {
      console.error("[HFY_AUTH] Unable to initialize Google Sign-In", error);
      setStatus({
        message: "Google Sign-In is unavailable right now. Please try again later.",
        variant: "danger"
      });
    }

    restoreStoredSession();
  }

  function restoreStoredSession() {
    const storedToken = localStorage.getItem(STORAGE_KEY);
    const storedGrampsId = localStorage.getItem(GRAMPS_STORAGE_KEY);
    if (!storedToken) {
      logDebug("No stored ID token found in localStorage.");
      if (storedGrampsId) {
        syncUserRecord(storedGrampsId);
      }
      return;
    }
    const profile = decodeJwt(storedToken);
    if (!profile) {
      persistToken(null);
      return;
    }
    logDebug("Restoring stored session from localStorage.", {
      hasGrampsId: Boolean(storedGrampsId)
    });
    state.idToken = storedToken;
    state.profile = profile;
    state.signedIn = true;
    syncUserRecord(storedGrampsId);
    updateUI();
    reflectFeatureFlags();
    ensureGatewaySession();
    notifySubscribers();
  }

  function onReady(callback) {
    if (document.readyState === "loading") {
      document.addEventListener("DOMContentLoaded", callback, { once: true });
    } else {
      callback();
    }
  }

  function shouldRedirectToRecord() {
    if (!state.userGrampsID) {
      logDebug("shouldRedirectToRecord skipped: missing userGrampsID.");
      return false;
    }
    if (hasRedirectedToRecord) {
      return false;
    }
    const path = window.location.pathname || "";
    return path === "/family-login/" || path === "/family-login";
  }

  function maybeRedirectToRecord() {
    if (!shouldRedirectToRecord()) {
      return;
    }
    const featureState = featureFlags && typeof featureFlags.getState === "function" ? featureFlags.getState() : {};
    if (!featureState.sessionToken) {
      logDebug("Deferring redirect; sessionToken missing.", featureState);
      return;
    }
    hasRedirectedToRecord = true;
    const destination = `/person/?id=${encodeURIComponent(state.userGrampsID)}`;
    logDebug("Redirecting to My Record.", { destination });
    window.location.assign(destination);
  }

  const authAPI = {
    isSignedIn() {
      return state.signedIn;
    },
    getLatestIdToken() {
      return state.idToken;
    },
    getUserGrampsID() {
      return state.userGrampsID;
    },
    signOut,
    onChange(callback) {
      if (typeof callback === "function") {
        listeners.add(callback);
        return () => listeners.delete(callback);
      }
      return () => {};
    }
  };

  window.HFY_AUTH = authAPI;

  onReady(initAuthUI);
})();
