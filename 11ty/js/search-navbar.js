(() => {
  const config = window.HFY_SEARCH_CONFIG || {};
  const loginRedirect = config.loginRedirect || "/family-login/";
  let featureFlags = window.HFYFeatureFlags;
  const form = document.querySelector('[data-search-form]');
  const input = form ? form.querySelector('[data-search-input]') : null;
  const autocomplete = form ? form.querySelector('[data-search-autocomplete]') : null;
  const list = form ? form.querySelector('[data-search-list]') : null;
  const countEl = form ? form.querySelector('[data-search-count]') : null;
  const viewAllBtn = form ? form.querySelector('[data-search-view-all]') : null;

  if (!form || !input || !autocomplete || !list) {
    return;
  }

  const state = {
    manifest: [],
    searchIndex: [],
    store: new Map(),
    activeIndex: -1,
    loading: false,
    ready: false,
    pendingQuery: '',
  };

  const SEARCH_CACHE_KEY = "HFY_SEARCH_DATA_CACHE_V1";
  const SEARCH_DEBUG_FLAG = "HFY_DEBUG_FEATURES";
  const SEARCH_LIMIT = 6;
  const DEBOUNCE_MS = 120;
  let debounceTimer = null;
  let sharedManifest = null;
  let sharedSearchIndex = null;
  let sharedLoadPromise = null;
  let sessionVerifyPromise = null;
  hydrateSharedCache();
  applySharedCacheIfAvailable();
  subscribeToAuthChanges();

  const searchDebugEnabled = (() => {
    if (config.debug === true) {
      return true;
    }
    if (window.HFY_DEBUG_FEATURES === true) {
      return true;
    }
    try {
      return typeof localStorage !== "undefined" && localStorage.getItem(SEARCH_DEBUG_FLAG) === "true";
    } catch (error) {
      console.warn("[HFY_SEARCH] Unable to read debug flag", error);
      return false;
    }
  })();

  function logSearchDebug(message, ...args) {
    if (searchDebugEnabled) {
      console.debug("[HFY_SEARCH]", message, ...args);
    }
  }

  function normalize(text) {
    return (text || '').toLowerCase();
  }

  function tokenize(text) {
    return normalize(text)
      .split(/\s+/)
      .map((token) => token.trim())
      .filter(Boolean);
  }

  async function buildAuthHeaders() {
    const flags = await waitForFeatureFlags();
    if (!flags) {
      return {};
    }

    const gateway = (flags.config && flags.config.gateway) || {};
    const enforcementEnabled = gateway.enforceAssets === true;
    const existingToken = flags.requireSessionToken && flags.requireSessionToken();

    if (!enforcementEnabled) {
      return existingToken ? { 'X-HFY-Session': existingToken } : {};
    }

    if (existingToken) {
      return { 'X-HFY-Session': existingToken };
    }

    const { token } = await waitForSessionToken({
      timeoutMs: 8000,
      label: "[HFY_SEARCH] buildAuthHeaders"
    });
    if (!token) {
      throw new Error('Unable to obtain session token for search assets.');
    }
    return { 'X-HFY-Session': token };
  }

  async function loadData(options = {}) {
    const { forceReload = false, eager = false } = options;
    if (!forceReload && state.ready) {
      return true;
    }

    if (!forceReload && applySharedCacheIfAvailable()) {
      logSearchDebug("Applied cached search data.");
      return true;
    }

    if (state.loading && sharedLoadPromise) {
      await sharedLoadPromise;
      return applySharedCacheIfAvailable();
    }

    state.loading = true;
    if (!sharedLoadPromise || forceReload) {
      sharedLoadPromise = fetchAndCacheSearchData();
    }

    const currentPromise = sharedLoadPromise;

    try {
      await currentPromise;
      if (applySharedCacheIfAvailable() && state.pendingQuery) {
        renderSuggestions(state.pendingQuery);
      }
      return state.ready;
    } catch (err) {
      console.error('[Search] Failed to load search data:', err);
      return false;
    } finally {
      state.loading = false;
      if (sharedLoadPromise === currentPromise) {
        sharedLoadPromise = null;
      }
    }
  }

  async function fetchAndCacheSearchData() {
    const authorized = await requireAuthenticated();
    if (!authorized) {
      throw new Error("User is not authenticated for search.");
    }

    const headers = await buildAuthHeaders();
    const fetchOptions = Object.keys(headers).length ? { headers, credentials: 'include' } : {};
    const manifestUrl = config.manifestUrl || '/person/index.json';
    const indexUrl = config.indexUrl || '/person/search-index.json';

    const [manifest, index] = await Promise.all([
      fetch(manifestUrl, fetchOptions).then((res) => {
        if (!res.ok) throw new Error('Failed to load manifest');
        return res.json();
      }),
      fetch(indexUrl, fetchOptions).then((res) => {
        if (!res.ok) throw new Error('Failed to load search index');
        return res.json();
      }),
    ]);

    sharedManifest = Array.isArray(manifest.people) ? manifest.people : manifest;
    sharedSearchIndex = Array.isArray(index.documents) ? index.documents : [];
    persistSharedCache();
    logSearchDebug("Fetched search data from network.", {
      manifestCount: Array.isArray(sharedManifest) ? sharedManifest.length : 0,
      indexCount: Array.isArray(sharedSearchIndex) ? sharedSearchIndex.length : 0
    });
  }

  function scoreDocument(doc, tokens) {
    if (!tokens.length) {
      return 0;
    }

    const haystack = doc.searchText || '';
    let score = 0;

    tokens.forEach((token) => {
      if (!token) {
        return;
      }
      if (haystack.startsWith(token)) {
        score += 3;
      } else if (haystack.includes(token)) {
        score += 1;
      }
    });

    return score;
  }

  function buildMatch(entry, score) {
    const lifespan = entry.lifespanSummary ? ` · ${entry.lifespanSummary}` : '';
    return {
      grampsId: entry.grampsId,
      handle: entry.handle,
      displayName: entry.displayName,
      isLiving: entry.isLiving,
      lifespanSummary: entry.lifespanSummary || '',
      primaryPhoto: entry.primaryPhoto || null,
      score,
      url: `${config.personUrlBase || '/person/?id='}${encodeURIComponent(entry.grampsId)}`,
    };
  }

  function searchDocuments(query) {
    const tokens = tokenize(query);
    if (!tokens.length || !state.searchIndex.length) {
      return [];
    }

    const matches = [];
    state.searchIndex.forEach((doc) => {
      const score = scoreDocument(doc, tokens);
      if (score <= 0) {
        return;
      }
      const entry = state.store.get(doc.grampsId);
      if (!entry) {
        return;
      }
      matches.push(buildMatch(entry, score));
    });

    matches.sort((a, b) => b.score - a.score || a.displayName.localeCompare(b.displayName));
    return matches.slice(0, SEARCH_LIMIT);
  }

  function clearSuggestions() {
    list.innerHTML = '';
    autocomplete.hidden = true;
    state.activeIndex = -1;
    if (countEl) {
      countEl.textContent = '';
    }
    if (viewAllBtn) {
      viewAllBtn.hidden = true;
    }
  }

  function highlightActiveItem() {
    const items = list.querySelectorAll('[data-search-option]');
    items.forEach((item, index) => {
      if (index === state.activeIndex) {
        item.classList.add('active');
        item.setAttribute('aria-selected', 'true');
      } else {
        item.classList.remove('active');
        item.setAttribute('aria-selected', 'false');
      }
    });
  }

  function renderSuggestions(query) {
    if (!state.ready) {
      state.pendingQuery = query;
      return;
    }

    const matches = searchDocuments(query);

    if (!matches.length) {
      clearSuggestions();
      return;
    }

    list.innerHTML = matches
      .map((match, index) => {
        const status = match.lifespanSummary ? `<span class="text-muted ms-2 small">${match.lifespanSummary}</span>` : '';
        return `
          <li>
            <button type="button" class="search-autocomplete-item" data-search-option data-index="${index}" data-gramps-id="${match.grampsId}" data-url="${match.url}" aria-selected="false">
              <span class="search-autocomplete-name">${match.displayName}</span>
              ${status}
            </button>
          </li>
        `;
      })
      .join('');

    autocomplete.hidden = false;
    state.activeIndex = -1;
    highlightActiveItem();

    if (countEl) {
      countEl.textContent = `${matches.length} result${matches.length === 1 ? '' : 's'}`;
    }
    if (viewAllBtn) {
      viewAllBtn.hidden = false;
      viewAllBtn.dataset.href = buildSearchUrl(input.value.trim());
    }
  }

  function buildSearchUrl(query) {
    const searchPage = config.searchPage || '/search/';
    const trimmed = query.trim();
    if (!trimmed) {
      return searchPage;
    }
    const params = new URLSearchParams({ query: trimmed });
    return `${searchPage}?${params.toString()}`;
  }

  function handleInput(event) {
    const value = event.target.value;
    if (!value.trim()) {
      clearSuggestions();
      return;
    }

    if (!state.ready && !state.loading) {
      loadData();
    }

    if (debounceTimer) {
      clearTimeout(debounceTimer);
    }

    debounceTimer = setTimeout(() => {
      renderSuggestions(value);
    }, DEBOUNCE_MS);
  }

  function handleSubmit(event) {
    event.preventDefault();
    const query = input.value.trim();
    if (!query) {
      input.focus();
      return;
    }

    window.location.href = buildSearchUrl(query);
  }

  function handleKeyDown(event) {
    const items = list.querySelectorAll('[data-search-option]');
    if (!items.length || autocomplete.hidden) {
      return;
    }

    switch (event.key) {
      case 'ArrowDown':
        event.preventDefault();
        state.activeIndex = (state.activeIndex + 1) % items.length;
        highlightActiveItem();
        break;
      case 'ArrowUp':
        event.preventDefault();
        state.activeIndex = state.activeIndex <= 0 ? items.length - 1 : state.activeIndex - 1;
        highlightActiveItem();
        break;
      case 'Enter':
        if (state.activeIndex >= 0 && state.activeIndex < items.length) {
          event.preventDefault();
          const selected = items[state.activeIndex];
          window.location.href = selected.dataset.url;
        }
        break;
      case 'Escape':
        clearSuggestions();
        break;
      default:
        break;
    }
  }

  function handleListClick(event) {
    const option = event.target.closest('[data-search-option]');
    if (!option) {
      return;
    }
    const url = option.dataset.url;
    if (url) {
      window.location.href = url;
    }
  }

  function handleDocumentClick(event) {
    if (!autocomplete.contains(event.target) && event.target !== input) {
      clearSuggestions();
    }
  }

  function handleViewAll() {
    const url = buildSearchUrl(input.value.trim());
    window.location.href = url;
  }

  async function requireAuthenticated() {
    const { token } = await waitForSessionToken({
      timeoutMs: 8000,
      label: "[HFY_SEARCH]"
    });
    if (token) {
      return true;
    }
    logSearchDebug("Session token unavailable; redirecting to login.");
    redirectToLogin();
    return false;
  }

  function hydrateSharedCache() {
    try {
      if (typeof sessionStorage === "undefined") {
        return;
      }
      const raw = sessionStorage.getItem(SEARCH_CACHE_KEY);
      if (!raw) {
        return;
      }
      const parsed = JSON.parse(raw);
      if (Array.isArray(parsed.manifest) && Array.isArray(parsed.searchIndex)) {
        sharedManifest = parsed.manifest;
        sharedSearchIndex = parsed.searchIndex;
        logSearchDebug("Hydrated search cache from sessionStorage.", {
          manifestCount: sharedManifest.length,
          indexCount: sharedSearchIndex.length
        });
      }
    } catch (error) {
      console.warn("[HFY_SEARCH] Unable to hydrate cache", error);
    }
  }

  function persistSharedCache() {
    if (!Array.isArray(sharedManifest) || !Array.isArray(sharedSearchIndex)) {
      return;
    }
    try {
      if (typeof sessionStorage === "undefined") {
        return;
      }
      sessionStorage.setItem(
        SEARCH_CACHE_KEY,
        JSON.stringify({
          manifest: sharedManifest,
          searchIndex: sharedSearchIndex,
          timestamp: Date.now()
        })
      );
    } catch (error) {
      console.warn("[HFY_SEARCH] Unable to persist cache", error);
    }
  }

  function applySharedCacheIfAvailable() {
    if (!Array.isArray(sharedManifest) || !Array.isArray(sharedSearchIndex) || !sharedManifest.length) {
      return false;
    }
    state.manifest = sharedManifest.slice();
    state.searchIndex = sharedSearchIndex.slice();
    state.store = new Map(state.manifest.map((entry) => [entry.grampsId, entry]));
    state.ready = state.manifest.length > 0 && state.searchIndex.length > 0;
    return state.ready;
  }

  async function subscribeToAuthChanges() {
    const auth = await waitForAuth();
    if (!auth || typeof auth.onChange !== "function") {
      return;
    }
    auth.onChange((snapshot) => {
      if (snapshot && snapshot.signedIn) {
        logSearchDebug("Auth change detected; ensuring search assets are loaded.");
        loadData({ eager: true });
      }
    });
    if (typeof auth.isSignedIn === "function" && auth.isSignedIn()) {
      logSearchDebug("Auth already signed in; preloading search assets.");
      loadData({ eager: true });
    }
  }

  async function waitForSessionToken({ timeoutMs = 6000, label = "[HFY_SEARCH]" } = {}) {
    const flags = await waitForFeatureFlags();
    const auth = await waitForAuth();
    const start = Date.now();

    while (Date.now() - start < timeoutMs) {
      const token = flags && typeof flags.requireSessionToken === "function" ? flags.requireSessionToken() : null;
      if (token) {
        return { token, featureFlags: flags, auth };
      }

      const idToken = auth && typeof auth.getLatestIdToken === "function" ? auth.getLatestIdToken() : null;
      if (sessionVerifyPromise) {
        await sessionVerifyPromise.catch(() => {});
        continue;
      }
      if (idToken && flags && typeof flags.verifySession === "function") {
        sessionVerifyPromise = flags
          .verifySession({ googleIdToken: idToken })
          .catch((error) => {
            console.warn(`${label} verifySession attempt failed`, error);
          })
          .finally(() => {
            sessionVerifyPromise = null;
          });
        await sessionVerifyPromise;
        continue;
      }

      await delay(150);
    }

    return { token: null, featureFlags: flags, auth };
  }

  function delay(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  function waitForFeatureFlags(timeoutMs = 6000) {
    if (featureFlags && typeof featureFlags.getState === "function") {
      return Promise.resolve(featureFlags);
    }
    return waitForGlobal(() => window.HFYFeatureFlags, timeoutMs).then((resolved) => {
      if (resolved) {
        featureFlags = resolved;
      }
      return resolved;
    });
  }

  function waitForAuth(timeoutMs = 6000) {
    return waitForGlobal(() => window.HFY_AUTH, timeoutMs);
  }

  function waitForGlobal(getter, timeoutMs) {
    const existing = getter();
    if (existing) {
      return Promise.resolve(existing);
    }
    return new Promise((resolve) => {
      const start = Date.now();
      const interval = setInterval(() => {
        const value = getter();
        if (value) {
          clearInterval(interval);
          resolve(value);
        } else if (Date.now() - start >= timeoutMs) {
          clearInterval(interval);
          resolve(null);
        }
      }, 100);
    });
  }

  function redirectToLogin() {
    const next = window.location.pathname + window.location.search + window.location.hash;
    const target = new URL(loginRedirect, window.location.origin);
    if (next) {
      target.searchParams.set("next", next);
    }
    window.location.replace(target.toString());
  }

  input.addEventListener('input', handleInput);
  input.addEventListener('keydown', handleKeyDown);
  form.addEventListener('submit', handleSubmit);
  list.addEventListener('click', handleListClick);
  document.addEventListener('click', handleDocumentClick);
  if (viewAllBtn) {
    viewAllBtn.addEventListener('click', handleViewAll);
  }

  // Preload search data lazily when input receives focus
  input.addEventListener('focus', () => {
    loadData();
  });
})();
