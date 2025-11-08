(() => {
  const config = window.HFY_SEARCH_CONFIG || {};
  const featureFlags = window.HFYFeatureFlags;
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

  const SEARCH_LIMIT = 6;
  const DEBOUNCE_MS = 120;
  let debounceTimer = null;

  function normalize(text) {
    return (text || '').toLowerCase();
  }

  function tokenize(text) {
    return normalize(text)
      .split(/\s+/)
      .map((token) => token.trim())
      .filter(Boolean);
  }

  function getLatestGoogleIdToken() {
    if (window.HFY_AUTH && typeof window.HFY_AUTH.getLatestIdToken === 'function') {
      return window.HFY_AUTH.getLatestIdToken();
    }
    return undefined;
  }

  async function buildAuthHeaders() {
    if (!featureFlags) {
      return {};
    }

    const ffConfig = featureFlags.config || {};
    const gateway = ffConfig.gateway || {};
    const enforcementEnabled = gateway.enforceAssets === true;
    const existingToken = featureFlags.requireSessionToken && featureFlags.requireSessionToken();

    if (!enforcementEnabled) {
      return existingToken ? { 'X-HFY-Session': existingToken } : {};
    }

    if (existingToken) {
      return { 'X-HFY-Session': existingToken };
    }

    await featureFlags.verifySession({
      googleIdToken: getLatestGoogleIdToken()
    });
    const refreshedToken = featureFlags.requireSessionToken && featureFlags.requireSessionToken();
    if (!refreshedToken) {
      throw new Error('Unable to obtain session token for search assets.');
    }
    return { 'X-HFY-Session': refreshedToken };
  }

  async function loadData() {
    if (state.loading || state.ready) {
      return state.ready;
    }

    state.loading = true;

    const manifestUrl = config.manifestUrl || '/person/index.json';
    const indexUrl = config.indexUrl || '/person/search-index.json';

    try {
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
      if (state.pendingQuery) {
        renderSuggestions(state.pendingQuery);
      }
    } catch (err) {
      console.error('[Search] Failed to load search data:', err);
      state.loading = false;
    }

    return state.ready;
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
