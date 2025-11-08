(() => {
  const config = window.HFY_SEARCH_CONFIG || {};
  let featureFlags = window.HFYFeatureFlags;
  const pageSection = document.querySelector('[data-search-page]');
  const resultsContainer = document.querySelector('[data-search-results]');
  const resultsList = document.querySelector('[data-search-results-list]');
  const statusEl = document.querySelector('[data-search-status]');
  const form = document.querySelector('[data-search-page-form]');
  const input = form ? form.querySelector('[data-search-page-input]') : null;

  if (!resultsContainer || !resultsList || !form || !input) {
    return;
  }

  const loginRedirect = config.loginRedirect || "/family-login/";

  const state = {
    manifest: [],
    searchIndex: [],
    store: new Map(),
    ready: false,
    loading: false,
  };

  function normalize(text) {
    return (text || '').toLowerCase();
  }

  function tokenize(text) {
    return normalize(text)
      .split(/\s+/)
      .map((token) => token.trim())
      .filter(Boolean);
  }

  function buildMatch(entry, score) {
    return {
      grampsId: entry.grampsId,
      displayName: entry.displayName,
      isLiving: entry.isLiving,
      lifespanSummary: entry.lifespanSummary || '',
      primaryPhoto: entry.primaryPhoto || null,
      score,
      url: `${config.personUrlBase || '/person/?id='}${encodeURIComponent(entry.grampsId)}`,
    };
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

  function search(query) {
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
    return matches;
  }

  function renderResults(query, matches) {
    resultsList.innerHTML = '';

    if (!query.trim()) {
      statusEl.textContent = 'Enter a name to search the family records.';
      return;
    }

    if (!matches.length) {
      statusEl.textContent = `No results for “${query}”.`;
      return;
    }

    statusEl.textContent = `${matches.length} result${matches.length === 1 ? '' : 's'} for “${query}”.`;

    resultsList.innerHTML = matches
      .map((match) => {
        const lifespan = match.lifespanSummary ? `<p class="mb-0 text-muted small">${match.lifespanSummary}</p>` : '';
        const badge = match.isLiving
          ? '<span class="badge bg-success">Living</span>'
          : '<span class="badge bg-secondary">Deceased</span>';
        const photo = match.primaryPhoto
          ? `<img src="${match.primaryPhoto}" alt="${match.displayName}" class="search-result-photo" />`
          : '<div class="search-result-placeholder">No photo</div>';
        return `
          <li class="search-result-item">
            <a href="${match.url}" class="search-result-card">
              <div class="search-result-media">
                ${photo}
              </div>
              <div class="search-result-body">
                <h2 class="h5 mb-2">${match.displayName}</h2>
                <div class="mb-2">${badge}</div>
                ${lifespan}
              </div>
            </a>
          </li>
        `;
      })
      .join('');
  }

  function setQueryFromUrl() {
    const params = new URLSearchParams(window.location.search);
    const query = params.get('query') || params.get('q') || '';
    input.value = query;
    return query;
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
      label: "[HFY_SEARCH_PAGE] buildAuthHeaders"
    });
    if (!token) {
      throw new Error('Unable to obtain session token for search assets.');
    }
    return { 'X-HFY-Session': token };
  }

  async function loadData() {
    if (state.loading || state.ready) {
      return;
    }

    state.loading = true;

    const manifestUrl = config.manifestUrl || '/person/index.json';
    const indexUrl = config.indexUrl || '/person/search-index.json';

    try {
      const authorized = await requireAuthenticated();
      if (!authorized) {
        state.loading = false;
        return;
      }
      const headers = await buildAuthHeaders();
      const fetchOptions = Object.keys(headers).length ? { headers, credentials: 'include' } : {};

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

      state.manifest = Array.isArray(manifest.people) ? manifest.people : manifest;
      state.searchIndex = Array.isArray(index.documents) ? index.documents : [];
      state.store = new Map(state.manifest.map((entry) => [entry.grampsId, entry]));
      state.ready = true;
      state.loading = false;
    } catch (err) {
      console.error('[Search] Failed to load search data:', err);
      state.loading = false;
      statusEl.textContent = 'Unable to load search data. Please try again later.';
    }
  }

  async function requireAuthenticated() {
    const { token } = await waitForSessionToken({
      timeoutMs: 8000,
      label: "[HFY_SEARCH_PAGE]"
    });
    if (token) {
      return true;
    }
    console.warn("[HFY_SEARCH_PAGE] Unable to obtain session token; redirecting to login.");
    redirectToLogin();
    return false;
  }

  let sessionVerifyPromise = null;

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

  async function waitForSessionToken({ timeoutMs = 6000, label = "[HFY_SEARCH_PAGE]" } = {}) {
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

  function redirectToLogin() {
    const next = window.location.pathname + window.location.search + window.location.hash;
    const target = new URL(loginRedirect, window.location.origin);
    if (next) {
      target.searchParams.set("next", next);
    }
    window.location.replace(target.toString());
  }

  function executeSearch(query) {
    if (!query.trim()) {
      renderResults('', []);
      return;
    }

    if (!state.ready) {
      loadData().then(() => {
        if (state.ready) {
          renderResults(query, search(query));
        }
      });
      return;
    }

    renderResults(query, search(query));
  }

  form.addEventListener('submit', (event) => {
    event.preventDefault();
    const query = input.value.trim();
    const url = new URL(window.location.href);
    if (query) {
      url.searchParams.set('query', query);
    } else {
      url.searchParams.delete('query');
    }
    window.history.replaceState({}, '', url.toString());
    executeSearch(query);
  });

  bootstrap();

  async function bootstrap() {
    const authorized = await requireAuthenticated();
    if (!authorized) {
      return;
    }

    if (pageSection) {
      pageSection.removeAttribute("hidden");
      pageSection.classList.remove("d-none");
    }

    const initialQuery = setQueryFromUrl();
    if (initialQuery) {
      executeSearch(initialQuery);
    } else {
      statusEl.textContent = 'Enter a name to search the family records.';
    }
  }
})();
