(() => {
  // HFY design-system pass (legacy area, theme partial 45-person.css): the person page renders the DS PersonRecord anatomy.
  // Hero (portrait, display-serif name, one lifespan line), then the sections in the order life, family, photos, stories;
  // the personV2 island appends its comments as the last child of #person-content. Copy follows the DS voice: lowercase,
  // no IDs, never the word "record"; errors are one banner line. The auth and data paths below are unchanged.
  //
  // MOUNT POINTS (HFY-TSK-137, BRD2 10.2 item 13; documented in 11ty/README.md). This file is edited only by the task that owns
  // these hosts and events and by the W6 Graphviz removal; every other person-page task fills them from islands:
  //   events   hfy:person-rendered {personId, person, sections}  after every render
  //            hfy:lightbox-media  {index, media, img, box}      whenever the lightbox shows an image
  //   hosts    [data-slot="hero-actions"] > [data-slot=edit|follow|presence]   (hero, in that order)
  //            [data-slot="heading-chips"] > [data-slot=contributions|links]   (under the lifespan line)
  //            [data-slot="tree-link"]                                         (family section, after the tree)
  //            #hfy-person-social                                              (last child of #person-content, hidden until filled)
  //   hook     person JSON {mergedInto: "<id>"} redirects to ?id=<new id>
  // The hero and its slots are rebuilt by every render, so an island refills them on each hfy:person-rendered.
  const VOICE = {
    loading: "loading…",
    error: "that didn't work. try again, or text J.",
    photoError: "that photo didn't load. try again.",
    noPhoto: "no photo yet.",
    noPhotos: ["no photos yet.", "a phone photo counts."],
    noStories: ["no stories yet.", "can you write a chapter?"],
    noFamily: ["no connections yet.", "add a parent or a spouse to start the tree."],
    event: "event",
    dateUnknown: "date unknown",
    download: "download",
    living: "living"
  };
  // #person-content order (contract with islands/src/islands/person.jsx, which appends #hfy-person-comments last).
  const SECTION_ORDER = [
    ["person-hero-section", null],
    ["person-events-section", "life"],
    ["person-family-section", "family"],
    ["person-media-section", "photos"],
    ["person-stories-section", "stories"]
  ];
  const TREE_LEGEND = [
    ["focus", "this person"],
    ["parent", "parents"],
    ["grandparent", "grandparents"],
    ["sibling", "siblings"],
    ["spouse", "spouse"],
    ["child", "children"],
    ["grandchild", "grandchildren"]
  ];
  // Stop-gap until the ETL emits role classes (upstream: scripts/etl/build_family_tree_media.py writes each node's role only as
  // a fill colour, rewritten to var(--bs-*), with fontcolor var(--bs-white|dark) and Inter 14). The role is read back from the
  // shape's fill so the bs-bridge `.tree .<role>` rules can drive both the fill and the label ink. The ETL colours spouse with
  // --bs-info, which equals --bs-primary in main.css, so its colour map rewrites both to var(--bs-primary): the focus node is the
  // one whose link points at this page, any other --bs-primary node is a spouse.
  const TREE_FILL_ROLES = {
    "--bs-secondary": "parent",
    "--bs-dark": "grandparent",
    "--bs-warning": "sibling",
    "--bs-info": "spouse",
    "--bs-light": "child",
    "--bs-info-bg-subtle": "grandchild"
  };
  const TREE_ZOOM = { min: 0.4, max: 3, step: 1.25 };
  // DS type floor: the first view only opens in "fit" when every node label stays at least this size (CSS px).
  const TREE_LABEL_FLOOR = 16;
  const SWIPE_MIN = 80;

  paintLoadingSkeleton();

  window.addEventListener("error", (event) => {
    // Only while the page is still loading: once the person rendered, a late error elsewhere is not this page's to report.
    const content = document.getElementById("person-content");
    if (content && !content.classList.contains("d-none")) {
      return;
    }
    console.error("[HFY_PERSON] Unexpected error while loading:", event.error || event.message);
    showError(VOICE.error, { loading: document.getElementById("person-loading"), error: document.getElementById("person-error") });
  });

  const config = window.HFY_PERSON_CONFIG || {};
  const state = {
    env: config.env || "dev",
    dataBase: normalizeBase(config.dataBase || "/person/"),
    mediaBase: normalizeBase(config.mediaBase || "/media/"),
    lastDataUrl: null
  };
  const loginRedirect = config.loginRedirect || "/family-login/";
  const lightboxState = {
    items: [],
    modal: null,
    currentIndex: 0,
    listenersBound: false,
    keyHandler: null,
    lastTrigger: null,
    loadToken: 0,
    elements: {}
  };
  let currentFamilyTreeMarkup = "";
  let currentPersonName = "";
  let treeState = null;

  document.addEventListener("DOMContentLoaded", () => {
    const app = document.getElementById("person-app");
    const loading = document.getElementById("person-loading");
    const content = document.getElementById("person-content");
    const error = document.getElementById("person-error");

    if (!app || !loading || !content || !error) {
      return;
    }

    const params = new URLSearchParams(window.location.search);
    const personId = params.get("id");

    (async () => {
      if (!personId) {
        // /person/ without an id has nothing to show: it is the family route (HFYFeatureFlags.goToFamily, same as /private/).
        // Signed in it goes to the member's own page, otherwise to the sign-in, which returns to the own page. Only a page
        // that cannot decide where to go (no feature-flags.js, a session without a gramps id) shows the error line.
        const featureFlags = await waitForFeatureFlags();
        const url = featureFlags && typeof featureFlags.goToFamily === "function" ? await featureFlags.goToFamily() : null;
        if (!url) {
          console.error("[HFY_PERSON] Missing required person id (?id=<GRAMPS_ID>).");
          showError(VOICE.error, { loading, error });
        }
        return;
      }

    const authorized = await requireAuthenticated({ loading, error });
    if (!authorized) {
      return;
    }

    fetchPerson(personId)
        .then((person) => {
          if (redirectIfMerged(person, personId)) {
            return;
          }
          try {
            renderPerson(person, personId);
            hideLoading(loading);
            error.classList.add("d-none");
            content.classList.remove("d-none");
          } catch (err) {
            console.error("[ERROR] Failed to render person profile:", err);
            showError(VOICE.error, { loading, error });
          }
        })
        .catch((err) => {
          console.error("[ERROR] Failed to load person:", err);
          if (err && err.signInUrl) {
            showSignIn(err.signInUrl, { loading, error });
            return;
          }
          showError(VOICE.error, { loading, error });
        });
    })();
  });

  // Bootstrap dialogs must be direct children of <body>: inside the shell's scroller they sit in its stacking context, under
  // the backdrop Bootstrap appends to <body>, and the backdrop then swallows every click (close, next) in the dialog.
  document.addEventListener("show.bs.modal", (event) => {
    if (event.target && event.target.classList && event.target.classList.contains("modal")) {
      reparentModal(event.target);
    }
  });

  function reparentModal(modalEl) {
    if (modalEl && modalEl.parentElement !== document.body) {
      document.body.appendChild(modalEl);
    }
  }

  function paintLoadingSkeleton() {
    // Runs as soon as this script is parsed (it follows #person-loading), so the first paint is the skeleton, never a spinner.
    const loading = document.getElementById("person-loading");
    if (!loading || loading.getAttribute("data-hfy-skeleton")) {
      return;
    }
    loading.setAttribute("data-hfy-skeleton", "1");
    loading.className = "person-loading";
    loading.setAttribute("role", "status");
    loading.innerHTML = `
      <div class="person-skeleton" aria-hidden="true">
        <div class="person-skeleton__portrait"></div>
        <div class="person-skeleton__lines">
          <div class="person-skeleton__line person-skeleton__line--name"></div>
          <div class="person-skeleton__line person-skeleton__line--meta"></div>
        </div>
      </div>
      <div class="person-skeleton__block" aria-hidden="true"></div>
      <p class="person-loading__text">${VOICE.loading}</p>
    `;
  }

  function hideLoading(loadingEl) {
    if (loadingEl) {
      loadingEl.classList.add("d-none");
      loadingEl.setAttribute("aria-hidden", "true");
      loadingEl.hidden = true;
      loadingEl.style.display = "none";
    }
  }

  function showError(message, { loading, error }) {
    hideLoading(loading);
    if (error) {
      error.textContent = message;
      error.classList.remove("d-none");
    }
  }

  // HFY-R66: the edge session could not be recovered and the automatic sign-in redirect was skipped (this tab was just sent
  // there), so offer the sign-in as a link instead of looping.
  function showSignIn(url, { loading, error }) {
    hideLoading(loading);
    if (!error) {
      return;
    }
    error.textContent = "Your sign-in has expired. ";
    const link = document.createElement("a");
    link.href = url;
    link.textContent = "Sign in again";
    error.appendChild(link);
    error.appendChild(document.createTextNode(" to see this page."));
    error.classList.remove("d-none");
  }

  async function fetchPerson(personId) {
    const dataUrl = buildDataUrl(personId);
    state.lastDataUrl = dataUrl;

    const fetchOptions = await buildAuthorizedFetchOptions();
    const response = await dataFetch(dataUrl, fetchOptions);
    if (response.status === 401 && (await edgeSessionInit())) {
      const featureFlags = window.HFYFeatureFlags;
      const err = new Error("Your sign-in has expired.");
      err.signInUrl = featureFlags && typeof featureFlags.signInUrl === "function" ? featureFlags.signInUrl() : "/auth/login";
      throw err;
    }
    if (!response.ok) {
      throw new Error(`Person ${personId} not found (HTTP ${response.status}).`);
    }

    return response.json();
  }

  // HFY-R66: data requests go through HFYFeatureFlags.dataFetch. authV2 off: exactly fetch(url, init). authV2 on: the edge
  // session is refreshed once if it lapsed, a gate 401 is refreshed and retried once, and only an interactive load that still
  // fails goes to /auth/login. Without feature-flags.js on the page this is a plain fetch.
  async function dataFetch(url, init, options) {
    const featureFlags = await waitForFeatureFlags();
    if (featureFlags && typeof featureFlags.dataFetch === "function") {
      return featureFlags.dataFetch(url, init, options);
    }
    return fetch(url, init);
  }

  // HFY-TSK-080: true when authV2 is on, i.e. data requests carry the io_id cookie and the edge gate decides access.
  async function edgeSessionInit() {
    const featureFlags = await waitForFeatureFlags();
    return featureFlags && typeof featureFlags.dataFetchInit === "function" ? featureFlags.dataFetchInit() : null;
  }

  async function requireAuthenticated() {
    if (await edgeSessionInit()) {
      return true; // no legacy token under authV2; dataFetch refreshes on a gate 401 and only then sends the visitor to /auth/login
    }
    const { token } = await waitForSessionToken({
      timeoutMs: 8000,
      label: "[HFY_PERSON]"
    });
    if (token) {
      return true;
    }
    console.warn("[HFY_PERSON] Unable to obtain session token before timeout; redirecting to login.");
    redirectToLogin();
    return false;
  }

  function renderPerson(person, personId) {
    if (!person) {
      throw new Error("No person data returned.");
    }

    currentPersonName = person.displayName || "";
    updateDocumentTitle(person);
    renderHero(person);
    const hasEvents = renderEvents(person);
    const hasFamilyList = renderFamily(person);
    const hasFamilyVisualization = renderFamilyVisualization(person, personId);
    if (!hasFamilyList && !hasFamilyVisualization) {
      const familyData = document.getElementById("person-family-data");
      if (familyData) {
        familyData.innerHTML = renderEmptyState(VOICE.noFamily);
      }
    }
    renderMediaGallery(person);
    renderStories(person);
    toggleSection("person-events-section", hasEvents);
    toggleSection("person-family-section", true);
    toggleSection("person-media-section", true);
    toggleSection("person-stories-section", true);
    orderSections();
    announceRendered(person, personId);
  }

  // Mount point: a merged person's JSON is the stub {mergedInto: "<id>"} (SYNC-10). Send the visitor to the new id, keeping the
  // other query parameters and the hash. A malformed id, or the id already shown, is not followed (no redirect loop).
  function redirectIfMerged(person, personId) {
    const target = person && typeof person === "object" ? person.mergedInto : null;
    if (typeof target !== "string" || !/^[A-Za-z0-9_-]{1,32}$/.test(target) || target === personId) {
      return false;
    }
    const url = new URL(window.location.href);
    url.searchParams.set("id", target);
    window.location.replace(url.toString());
    return true;
  }

  // Mount point: islands listen for this and fill the hosts. detail.sections lists the ids of the sections now shown.
  function announceRendered(person, personId) {
    const sections = SECTION_ORDER.map(([id]) => id).filter((id) => {
      const el = document.getElementById(id);
      return el && !el.classList.contains("d-none");
    });
    document.dispatchEvent(new CustomEvent("hfy:person-rendered", { detail: { personId, person, sections } }));
  }

  // Mount point: #hfy-person-social is the last child of #person-content and stays hidden until an island fills it. The
  // [data-slot="tree-link"] host follows the tree in the family section. Both survive re-renders (only the hero is rebuilt).
  function ensureHosts(content) {
    let social = document.getElementById("hfy-person-social");
    if (!social) {
      social = document.createElement("div");
      social.id = "hfy-person-social";
      social.hidden = true;
    }
    content.appendChild(social);
    if (!document.querySelector('[data-slot="tree-link"]')) {
      const tree = document.getElementById("person-family-visualization");
      if (tree && tree.parentElement) {
        const host = document.createElement("div");
        host.setAttribute("data-slot", "tree-link");
        tree.insertAdjacentElement("afterend", host);
      }
    }
  }

  // Sections in DS order with their lowercase headings; the Eleventy spacer divs are dropped.
  function orderSections() {
    const content = document.getElementById("person-content");
    if (!content) {
      return;
    }
    ensureHosts(content);
    const comments = document.getElementById("hfy-person-comments");
    const social = document.getElementById("hfy-person-social");
    SECTION_ORDER.forEach(([id, heading]) => {
      const section = document.getElementById(id);
      if (!section) {
        return;
      }
      section.classList.add("person-section");
      section.querySelectorAll(".section-spacer").forEach((spacer) => spacer.remove());
      const h2 = heading ? section.querySelector("h2") : null;
      if (h2) {
        h2.textContent = heading;
      }
      const anchor = [comments, social].find((el) => el && el.parentElement === content);
      content.insertBefore(section, anchor || null);
    });
    content.appendChild(social); // an island may have appended after it; the social host is always last
  }

  function updateDocumentTitle(person) {
    if (person.displayName) {
      document.title = `${person.displayName} | Harrison Family`;
    }
  }

  function renderHero(person) {
    const section = document.getElementById("person-hero-section");
    const container = document.getElementById("person-hero");

    if (!section || !container) {
      return;
    }

    const photoUrl = resolveMediaPath(person.primaryPhoto);
    const placeholder = person.primaryPhoto && person.primaryPhoto.placeholderImage;

    container.innerHTML = `
      <div class="person-hero-grid">
        <div class="person-portrait">
          ${photoUrl ? renderPhotoTag(photoUrl, person.displayName, placeholder) : renderPhotoPlaceholder()}
        </div>
        <div class="person-heading">
          <h1>${escapeHtml(person.displayName || "name unknown")}</h1>
          ${renderLifespan(person)}
          <div class="person-chips" data-slot="heading-chips"><span data-slot="contributions"></span><span data-slot="links"></span></div>
          <div class="person-actions" data-slot="hero-actions"><span data-slot="edit"></span><span data-slot="follow"></span><span data-slot="presence"></span></div>
        </div>
      </div>
    `;

    section.classList.remove("d-none");
  }

  // "1874 – 1951 · Pointe Coupee Parish" in text.dim; living people get the word "living" after it, never a badge.
  function renderLifespan(person) {
    const life = person.lifespan || {};
    const living = person.isLiving === true;
    const born = yearOf(life.birth);
    const died = living ? null : yearOf(life.death);
    let years = "";
    if (born && died) {
      years = `${born} – ${died}`;
    } else if (born) {
      years = living ? born : `${born} –`;
    } else if (died) {
      years = `– ${died}`;
    }
    const place = placeOf(life.birth) || placeOf(life.death);
    const parts = [years, place].filter(Boolean).map(escapeHtml);
    if (living) {
      parts.push(`<span class="person-living">${VOICE.living}</span>`);
    }
    return parts.length ? `<p class="person-lifespan">${parts.join(" · ")}</p>` : "";
  }

  function yearOf(moment) {
    return moment && moment.year ? String(moment.year) : "";
  }

  function placeOf(moment) {
    return moment && moment.place && moment.place.displayName ? moment.place.displayName : "";
  }

  function waitForFeatureFlags(timeoutMs = 6000) {
    return waitForGlobal(() => window.HFYFeatureFlags, timeoutMs);
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

  async function buildAuthorizedFetchOptions() {
    const edgeInit = await edgeSessionInit();
    if (edgeInit) {
      return edgeInit; // authV2: cookie only, no X-HFY-Session
    }
    const { token } = await waitForSessionToken({
      timeoutMs: 2000,
      label: "[HFY_PERSON] fetchPerson"
    });
    if (token) {
      return {
        credentials: "include",
        headers: {
          "X-HFY-Session": token
        }
      };
    }
    return { credentials: "include" };
  }

  async function waitForSessionToken({ timeoutMs = 6000, label = "[HFY_SESSION]" } = {}) {
    const featureFlags = await waitForFeatureFlags();
    const auth = await waitForAuth();

    // Fast path: session token already available (e.g., restored from sessionStorage)
    const immediateToken =
      featureFlags && typeof featureFlags.requireSessionToken === "function"
        ? featureFlags.requireSessionToken()
        : null;
    if (immediateToken) {
      return { token: immediateToken, featureFlags, auth };
    }

    // Event-driven path: subscribe to auth change events, resolve when token appears
    return new Promise((resolve) => {
      let resolved = false;
      let unsubscribe = null;
      let fallbackTimer = null;
      const deadline = Date.now() + timeoutMs;

      function checkToken() {
        if (resolved) {
          return;
        }
        const token =
          featureFlags && typeof featureFlags.requireSessionToken === "function"
            ? featureFlags.requireSessionToken()
            : null;
        if (token) {
          resolved = true;
          if (unsubscribe) {
            unsubscribe();
          }
          clearInterval(fallbackTimer);
          resolve({ token, featureFlags, auth });
        }
      }

      if (auth && typeof auth.onChange === "function") {
        unsubscribe = auth.onChange(() => checkToken());
      }

      // Slow fallback poll (500ms) guards against edge cases where onChange is unavailable
      fallbackTimer = setInterval(() => {
        if (Date.now() >= deadline) {
          if (!resolved) {
            resolved = true;
            if (unsubscribe) {
              unsubscribe();
            }
            clearInterval(fallbackTimer);
            resolve({ token: null, featureFlags, auth });
          }
          return;
        }
        checkToken();
      }, 500);
    });
  }

  // The portrait carries no inline styles: 45-person.css sizes it (120 / 160 / 200, radius.lg, 1px border).
  function renderPhotoTag(url, displayName, fallback) {
    const safeName = escapeHtml(displayName || "portrait");
    const safeFallback = fallback ? escapeHtml(fallback) : "";
    return `
      <img
        src="${escapeHtml(url)}"
        alt="${safeName}"
        class="person-photo"
        ${safeFallback ? `onerror="this.src='${safeFallback}'"` : ""}
      >
    `;
  }

  function renderPhotoPlaceholder() {
    return `<div class="person-photo-placeholder"><span>${VOICE.noPhoto}</span></div>`;
  }

  // One empty-state pattern (DS): a display-serif line and one sentence in text.dim.
  function renderEmptyState([title, text]) {
    return `
      <div class="person-empty">
        <p class="person-empty__title">${title}</p>
        <p class="person-empty__text">${text}</p>
      </div>
    `;
  }

  // Stories: the notes panel (class kept, the personV2 island swaps its contents for the markdown notes) in its own section.
  function renderStories(person) {
    const content = document.getElementById("person-content");
    if (!content) {
      return;
    }
    let section = document.getElementById("person-stories-section");
    if (!section) {
      section = document.createElement("section");
      section.id = "person-stories-section";
      section.className = "person-stories d-none";
      section.innerHTML = `<div class="container"><div class="notes-panel"><h2>stories</h2></div></div>`;
      content.appendChild(section);
    }
    const panel = section.querySelector(".notes-panel");
    Array.from(panel.children).forEach((el) => {
      if (el.tagName !== "H2") {
        el.remove();
      }
    });
    const notes = Array.isArray(person.notes) ? person.notes : [];
    const stories = notes
      .map((note) => {
        if (note && note.html) {
          return `<article class="story">${note.html}</article>`;
        }
        if (note && note.raw) {
          return `<article class="story"><p>${escapeHtml(note.raw)}</p></article>`;
        }
        return "";
      })
      .filter(Boolean);
    panel.insertAdjacentHTML("beforeend", stories.length ? stories.join("") : renderEmptyState(VOICE.noStories));
  }

  function renderMediaGallery(person) {
    const grid = document.getElementById("person-media-grid");
    if (!grid) {
      return false;
    }

    const items = Array.isArray(person.mediaGallery) ? person.mediaGallery : [];
    if (!items.length) {
      grid.innerHTML = `<div class="col-12">${renderEmptyState(VOICE.noPhotos)}</div>`;
      return false;
    }

    const markup = items.map((media, index) => {
      const url = resolveMediaPath(media);
      const placeholder = media && media.placeholderImage ? escapeHtml(media.placeholderImage) : "";
      const title = media && media.title ? escapeHtml(media.title) : "";
      const alt = title || "photo";
      const picture = url
        ? `
          <button type="button" class="media-lightbox-trigger" data-media-index="${index}" aria-label="open ${alt}">
            <img
              src="${escapeHtml(url)}"
              class="gallery-photo"
              alt="${alt}"
              loading="lazy"
              ${placeholder ? `onerror="this.src='${placeholder}'"` : ""}
            >
          </button>`
        : `<div class="gallery-photo gallery-photo--missing"><span>${VOICE.noPhoto}</span></div>`;

      return `
        <div class="col-12 col-md-6 col-lg-4">
          <figure class="gallery-item">
            ${picture}
            ${title ? `<figcaption class="gallery-caption">${title}</figcaption>` : ""}
          </figure>
        </div>
      `;
    }).join("");

    grid.innerHTML = markup;
    initializeLightbox(items);
    return true;
  }

  function renderFamily(person) {
    const container = document.getElementById("person-family-data");
    if (!container) {
      return false;
    }

    const tree = person.familyTree || {};
    const parentFamilies = Array.isArray(tree.parentFamilies) ? tree.parentFamilies : [];
    const spouseFamilies = Array.isArray(tree.spouseFamilies) ? tree.spouseFamilies : [];

    const categories = {
      parents: new Map(),
      siblings: new Map(),
      spouses: new Map(),
      children: new Map()
    };

    const personHandle = person.handle;

    const addRelative = (bucket, relative, label) => {
      if (!relative || !relative.displayName) {
        return;
      }
      if (relative.handle && relative.handle === personHandle) {
        return;
      }
      const key = relative.handle || `${label || ""}:${relative.displayName}`;
      if (!bucket.has(key)) {
        bucket.set(key, { relative, label });
      }
    };

    parentFamilies.forEach((family) => {
      addRelative(categories.parents, family.father, "father");
      addRelative(categories.parents, family.mother, "mother");
      (Array.isArray(family.children) ? family.children : []).forEach((child) => {
        addRelative(categories.siblings, child);
      });
    });

    spouseFamilies.forEach((family) => {
      [family.father, family.mother].forEach((relative) => {
        if (!relative) return;
        addRelative(categories.spouses, relative);
      });
      (Array.isArray(family.children) ? family.children : []).forEach((child) => {
        addRelative(categories.children, child);
      });
    });

    const orderedCategories = [
      { key: "parents", heading: "parents" },
      { key: "siblings", heading: "siblings" },
      { key: "spouses", heading: "spouse" },
      { key: "children", heading: "children" }
    ];

    const groups = orderedCategories
      .map(({ key, heading }) => {
        const entries = Array.from(categories[key].values());
        if (!entries.length) {
          return "";
        }
        const items = entries
          .map(({ relative, label }) => renderFamilyRelative(relative, label))
          .join("");
        return `
          <div class="family-group">
            <h3 class="family-group__title">${heading}</h3>
            <ul class="family-list">${items}</ul>
          </div>
        `;
      })
      .filter(Boolean);

    if (!groups.length) {
      container.innerHTML = "";
      return false;
    }

    container.innerHTML = `<div class="family-groups">${groups.join("")}</div>`;
    return true;
  }

  function renderFamilyRelative(relative, label) {
    const name = escapeHtml(relative.displayName);
    const link = relative.grampsId
      ? `<a href="/person/?id=${encodeURIComponent(relative.grampsId)}" class="family-link">${name}</a>`
      : `<span class="family-name">${name}</span>`;
    const meta = [label, relative.isLiving === true ? VOICE.living : ""].filter(Boolean);
    return `<li class="family-member">${link}${meta.length ? `<span class="family-meta">${meta.join(" · ")}</span>` : ""}</li>`;
  }

  // FamilyTree (DS): the frame (.family-tree-visualization) holds a 4-button toolbar and the pannable SVG viewport
  // (.family-tree-embed.tree); the legend follows the frame. The SVG renders at its natural size; "fit" toggles width 100%.
  function renderFamilyVisualization(person, personId) {
    const container = document.getElementById("person-family-visualization");
    if (!container) {
      return false;
    }

    const media = person.familyTreeMedia;
    const svgUrl = media && media.path ? resolveMediaAssetPath(media.path) : null;
    if (!svgUrl) {
      container.innerHTML = "";
      container.classList.add("d-none");
      toggleLegend(container, false);
      return false;
    }

    treeState = null;
    currentFamilyTreeMarkup = "";
    container.classList.remove("d-none", "is-fit");
    container.classList.add("is-loading");
    container.setAttribute("aria-busy", "true");
    container.innerHTML = `
      <div class="tree-toolbar" role="toolbar" aria-label="family tree controls">
        <button type="button" class="tree-btn" data-tree-action="zoom-out" aria-label="zoom out" title="zoom out" disabled><span aria-hidden="true">−</span></button>
        <button type="button" class="tree-btn" data-tree-action="zoom-in" aria-label="zoom in" title="zoom in" disabled><span aria-hidden="true">+</span></button>
        <button type="button" class="tree-btn" data-tree-action="fit" aria-label="fit the tree to the frame" title="fit" aria-pressed="false" disabled><span aria-hidden="true">⤢</span></button>
        <button type="button" class="tree-btn" data-tree-action="download" aria-label="download the family tree" title="download" disabled><span aria-hidden="true">↓</span></button>
      </div>
      <div class="family-tree-embed tree" tabindex="0" role="region" aria-label="family tree">
        <div class="tree-skeleton" aria-hidden="true"></div>
        <p class="tree-status">${VOICE.loading}</p>
      </div>
    `;
    toggleLegend(container, true);
    bindTreeControls(container);
    const viewport = container.querySelector(".family-tree-embed");
    bindTreePan(viewport);

    // Background load: under authV2 a lapsed session is refreshed and retried, but a failure never redirects (the page shows).
    dataFetch(svgUrl, { credentials: "same-origin" }, { interactive: false })
      .then((response) => {
        if (!response.ok) {
          throw new Error(`Unable to load SVG (HTTP ${response.status})`);
        }
        return response.text();
      })
      .then((svgMarkup) => {
        viewport.innerHTML = svgMarkup;
        const svg = viewport.querySelector("svg");
        if (!svg) {
          throw new Error("The family tree file holds no SVG.");
        }
        currentFamilyTreeMarkup = svgMarkup;
        tagTreeRoles(svg, personId);
        treeState = { container, viewport, svg, natural: naturalSize(svg), scale: 1, fit: false };
        container.classList.remove("is-loading");
        container.removeAttribute("aria-busy");
        container.querySelectorAll("[data-tree-action]").forEach((btn) => {
          btn.disabled = false;
        });
        applyTreeZoom();
        // The first view needs the viewport's size: the SVG often arrives while the person content is still hidden (0 x 0), when
        // neither the fit decision nor the centring can work, so it runs on the first frame the viewport has a size.
        treeState.pendingFirstView = true;
        firstTreeView(treeState);
        watchTreeViewport(treeState);
      })
      .catch((error) => {
        console.error("[ERROR] Failed to load family tree visualization:", error);
        treeState = null;
        container.classList.remove("is-loading");
        container.removeAttribute("aria-busy");
        viewport.innerHTML = `<div class="alert alert-danger tree-error" role="alert">${VOICE.error}</div>`;
      });

    return true;
  }

  function toggleLegend(container, show) {
    let legend = document.getElementById("person-family-legend");
    if (!show) {
      if (legend) {
        legend.classList.add("d-none");
      }
      return;
    }
    if (!legend) {
      legend = document.createElement("ul");
      legend.id = "person-family-legend";
      legend.className = "tree-legend";
      legend.setAttribute("aria-label", "who is who in the family tree");
      container.insertAdjacentElement("afterend", legend);
    }
    legend.innerHTML = TREE_LEGEND
      .map(([role, label]) => `<li><span class="tree"><i class="${role}" aria-hidden="true"></i>${label}</span></li>`)
      .join("");
    legend.classList.remove("d-none");
  }

  function tagTreeRoles(svg, personId) {
    svg.querySelectorAll("g.node").forEach((node) => {
      const shape = node.querySelector("path, polygon, ellipse, rect");
      const match = shape ? /var\(\s*(--bs-[\w-]+)\s*\)/.exec(shape.getAttribute("fill") || "") : null;
      if (!match) {
        return;
      }
      let role = TREE_FILL_ROLES[match[1]];
      if (match[1] === "--bs-primary") {
        role = nodeLinkId(node) === personId ? "focus" : "spouse";
      }
      if (role) {
        node.classList.add(role);
        node.setAttribute("data-role", role);
      }
    });
  }

  function nodeLinkId(node) {
    const link = node.querySelector("a");
    if (!link) {
      return null;
    }
    const href = link.getAttribute("href") || link.getAttributeNS("http://www.w3.org/1999/xlink", "href") || link.getAttribute("xlink:href");
    if (!href) {
      return null;
    }
    try {
      return new URL(href, window.location.origin).searchParams.get("id");
    } catch (err) {
      return null;
    }
  }

  // Natural size in CSS px: Graphviz writes width/height in pt (1pt = 4/3 px) plus a viewBox in the same units.
  function naturalSize(svg) {
    const parse = (value) => {
      const m = /^\s*([\d.]+)\s*(pt|px)?\s*$/.exec(value || "");
      return m ? parseFloat(m[1]) * (m[2] === "pt" ? 4 / 3 : 1) : 0;
    };
    let w = parse(svg.getAttribute("width"));
    let h = parse(svg.getAttribute("height"));
    const box = svg.viewBox && svg.viewBox.baseVal;
    if ((!w || !h) && box && box.width && box.height) {
      w = box.width;
      h = box.height;
    }
    if (!svg.getAttribute("viewBox") && w && h) {
      svg.setAttribute("viewBox", `0 0 ${w} ${h}`);
    }
    return { w: w || 600, h: h || 400 };
  }

  // "fit" shows the whole drawing: the largest scale at which it fits the viewport both ways (contain), never above natural size x 3.
  function treeFitScale(t) {
    const w = t.viewport.clientWidth;
    const h = t.viewport.clientHeight;
    if (!w || !h) {
      return 1;
    }
    return Math.min(TREE_ZOOM.max, w / t.natural.w, h / t.natural.h);
  }

  // The smallest node label at natural size, in CSS px (Graphviz writes font-size in viewBox units).
  function treeLabelPx(svg, natural) {
    const box = svg.viewBox && svg.viewBox.baseVal;
    const unit = box && box.width ? natural.w / box.width : 4 / 3;
    let min = Infinity;
    svg.querySelectorAll("g.node text").forEach((text) => {
      const size = parseFloat(text.getAttribute("font-size") || "");
      if (size > 0) {
        min = Math.min(min, size);
      }
    });
    return (Number.isFinite(min) ? min : 14) * unit;
  }

  // First view: the whole tree ("fit") when it is larger than the viewport and fitting keeps every label at the 16px floor (DS
  // type floor); otherwise its natural size, scrolled so the focus person is centred (pan and zoom reach the rest).
  function firstTreeView(t) {
    if (!t.pendingFirstView || !t.viewport.clientWidth || !t.viewport.clientHeight) {
      return;
    }
    t.pendingFirstView = false;
    const fitScale = treeFitScale(t);
    t.fit = fitScale < 1 && treeLabelPx(t.svg, t.natural) * fitScale >= TREE_LABEL_FLOOR;
    applyTreeZoom();
    if (!t.fit) {
      centerTreeOnFocus();
      keepTreeCentred(t);
    }
  }

  // Moving a scroll container in the DOM resets its scroll offset, and shellV2 moves the whole page into its scroller once it
  // mounts, often after the tree has drawn: until the member pans, zooms or scrolls the tree, put the focus person back in the
  // centre after such a move.
  function keepTreeCentred(t) {
    if (typeof MutationObserver !== "function" || t.keepCentred) {
      return;
    }
    const mo = new MutationObserver(() => {
      if (treeState !== t || !t.keepCentred) {
        mo.disconnect();
        return;
      }
      requestAnimationFrame(() => {
        if (treeState === t && t.keepCentred && !t.fit) {
          centerTreeOnFocus();
        }
      });
    });
    const stop = () => {
      t.keepCentred = false;
      mo.disconnect();
      ["pointerdown", "wheel", "keydown", "touchstart"].forEach((type) => t.viewport.removeEventListener(type, stop));
    };
    t.keepCentred = true;
    mo.observe(document.body, { childList: true });
    ["pointerdown", "wheel", "keydown", "touchstart"].forEach((type) => t.viewport.addEventListener(type, stop, { passive: true }));
    t.stopCentring = stop;
  }

  // In "fit", follow the viewport (rotation, window resize, the 688 / 1024 frame heights); run the first view once it has a size.
  function watchTreeViewport(t) {
    if (typeof ResizeObserver !== "function") {
      return;
    }
    const ro = new ResizeObserver(() => {
      if (treeState !== t) {
        ro.disconnect();
        return;
      }
      if (t.pendingFirstView) {
        firstTreeView(t);
      } else if (t.fit) {
        applyTreeZoom();
      }
    });
    ro.observe(t.viewport);
  }

  function applyTreeZoom() {
    const t = treeState;
    if (!t) {
      return;
    }
    const { svg, natural } = t;
    svg.style.aspectRatio = `${natural.w} / ${natural.h}`;
    if (t.fit) {
      const s = treeFitScale(t);
      svg.style.width = `${Math.floor(natural.w * s)}px`;
      svg.style.height = `${Math.floor(natural.h * s)}px`;
    } else {
      svg.style.width = `${Math.round(natural.w * t.scale)}px`;
      svg.style.height = `${Math.round(natural.h * t.scale)}px`;
    }
    t.container.classList.toggle("is-fit", t.fit);
    const button = (action) => t.container.querySelector(`[data-tree-action="${action}"]`);
    button("fit").setAttribute("aria-pressed", String(t.fit));
    button("zoom-out").disabled = !t.fit && t.scale <= TREE_ZOOM.min + 0.001;
    button("zoom-in").disabled = !t.fit && t.scale >= TREE_ZOOM.max - 0.001;
  }

  function zoomTree(direction) {
    const t = treeState;
    if (!t) {
      return;
    }
    const v = t.viewport;
    const cx = (v.scrollLeft + v.clientWidth / 2) / Math.max(v.scrollWidth, 1);
    const cy = (v.scrollTop + v.clientHeight / 2) / Math.max(v.scrollHeight, 1);
    if (t.fit) {
      t.scale = t.svg.getBoundingClientRect().width / t.natural.w || 1;
      t.fit = false;
    }
    const next = direction > 0 ? t.scale * TREE_ZOOM.step : t.scale / TREE_ZOOM.step;
    t.scale = Math.min(TREE_ZOOM.max, Math.max(TREE_ZOOM.min, next));
    applyTreeZoom();
    v.scrollLeft = cx * v.scrollWidth - v.clientWidth / 2;
    v.scrollTop = cy * v.scrollHeight - v.clientHeight / 2;
  }

  function centerTreeOnFocus() {
    const t = treeState;
    const focus = t && t.svg.querySelector("g.node.focus");
    if (!focus) {
      return;
    }
    const frame = t.viewport.getBoundingClientRect();
    const node = focus.getBoundingClientRect();
    t.viewport.scrollLeft += node.left + node.width / 2 - (frame.left + frame.width / 2);
    t.viewport.scrollTop += node.top + node.height / 2 - (frame.top + frame.height / 2);
  }

  function downloadTree() {
    if (!currentFamilyTreeMarkup) {
      return;
    }
    const slug = (currentPersonName || "family").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "") || "family";
    const url = URL.createObjectURL(new Blob([currentFamilyTreeMarkup], { type: "image/svg+xml" }));
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = `${slug}-family-tree.svg`;
    document.body.appendChild(anchor);
    anchor.click();
    anchor.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }

  function bindTreeControls(container) {
    if (container.getAttribute("data-tree-bound")) {
      return;
    }
    container.setAttribute("data-tree-bound", "1");
    container.addEventListener("click", (event) => {
      const button = event.target.closest("[data-tree-action]");
      if (!button || button.disabled || !treeState) {
        return;
      }
      treeState.pendingFirstView = false; // the member has taken over the view
      if (treeState.stopCentring) {
        treeState.stopCentring();
      }
      const action = button.getAttribute("data-tree-action");
      if (action === "zoom-in") {
        zoomTree(1);
      } else if (action === "zoom-out") {
        zoomTree(-1);
      } else if (action === "fit") {
        treeState.fit = !treeState.fit;
        applyTreeZoom();
        if (!treeState.fit) {
          centerTreeOnFocus();
        }
      } else if (action === "download") {
        downloadTree();
      }
    });
  }

  // Mouse drag pans the frame (touch and keyboard pan it natively: overflow auto, tabindex 0). A drag never follows a node link.
  function bindTreePan(viewport) {
    let drag = null;
    let suppressClick = false;
    viewport.addEventListener("pointerdown", (event) => {
      if (event.pointerType !== "mouse" || event.button !== 0) {
        return;
      }
      drag = { x: event.clientX, y: event.clientY, left: viewport.scrollLeft, top: viewport.scrollTop, moved: false };
    });
    viewport.addEventListener("pointermove", (event) => {
      if (!drag) {
        return;
      }
      const dx = event.clientX - drag.x;
      const dy = event.clientY - drag.y;
      if (!drag.moved && Math.abs(dx) + Math.abs(dy) < 6) {
        return;
      }
      if (!drag.moved) {
        drag.moved = true;
        viewport.classList.add("is-panning");
      }
      viewport.scrollLeft = drag.left - dx;
      viewport.scrollTop = drag.top - dy;
    });
    const end = () => {
      if (!drag) {
        return;
      }
      suppressClick = drag.moved;
      drag = null;
      viewport.classList.remove("is-panning");
    };
    viewport.addEventListener("pointerup", end);
    viewport.addEventListener("pointercancel", end);
    viewport.addEventListener("pointerleave", end);
    viewport.addEventListener("dragstart", (event) => event.preventDefault());
    viewport.addEventListener("click", (event) => {
      if (suppressClick) {
        suppressClick = false;
        event.preventDefault();
        event.stopPropagation();
      }
    }, true);
  }

  // Life (DS timeline): one row per event, date in mono text.dim, the event, the place in text.dim. Dates as the archive has them.
  function renderEvents(person) {
    const container = document.getElementById("person-events");
    if (!container) {
      return false;
    }

    const events = Array.isArray(person.events) ? person.events : [];
    if (!events.length) {
      container.innerHTML = "";
      return false;
    }

    const rows = events.map((event) => {
      const label = event.label && event.label !== "Event" ? escapeHtml(String(event.label).toLowerCase()) : VOICE.event;
      const description = event.description ? `<span class="timeline-note">${escapeHtml(event.description)}</span>` : "";
      const place = event.place && event.place.displayName ? `<span class="timeline-place">${escapeHtml(event.place.displayName)}</span>` : "";
      const date = event.date && event.date.text ? escapeHtml(event.date.text) : VOICE.dateUnknown;
      return `
        <li class="timeline-row">
          <span class="timeline-date">${date}</span>
          <span class="timeline-event">${label}</span>
          ${description}
          ${place}
        </li>
      `;
    }).join("");

    container.innerHTML = `<ol class="timeline-rows">${rows}</ol>`;
    return true;
  }

  function toggleSection(sectionId, shouldShow) {
    const section = document.getElementById(sectionId);
    if (!section) {
      return;
    }

    if (shouldShow) {
      section.classList.remove("d-none");
    } else {
      section.classList.add("d-none");
    }
  }

  function buildDataUrl(personId) {
    const filename = `${encodeURIComponent(personId)}.json`;

    if (state.dataBase.startsWith("http://") || state.dataBase.startsWith("https://")) {
      return `${state.dataBase}${filename}`;
    }

    return `${state.dataBase}${filename}`;
  }

  function resolveMediaPath(media) {
    if (!media) {
      return null;
    }

    const filename = deriveMediaFilename(media);
    if (!filename) {
      return null;
    }

    if (state.mediaBase.startsWith("http://") || state.mediaBase.startsWith("https://")) {
      return `${state.mediaBase}${filename}`;
    }

    return `${state.mediaBase}${filename}`;
  }

  function resolveMediaAssetPath(pathname) {
    if (!pathname) {
      return null;
    }

    if (/^https?:\/\//i.test(pathname)) {
      return pathname;
    }

    const trimmedPath = pathname.startsWith("/") ? pathname.slice(1) : pathname;
    if (state.mediaBase.startsWith("http://") || state.mediaBase.startsWith("https://")) {
      return `${state.mediaBase}${trimmedPath}`;
    }

    const normalizedBase = state.mediaBase.endsWith("/") ? state.mediaBase : `${state.mediaBase}/`;
    return `${normalizedBase}${trimmedPath}`;
  }

  function deriveMediaFilename(media) {
    if (media.s3Key) {
      const parts = media.s3Key.split("/");
      const name = parts[parts.length - 1];
      if (name) {
        return name;
      }
    }

    if (media.handle) {
      const ext = mimeToExtension(media.mime);
      return ext ? `${media.handle}${ext}` : media.handle;
    }

    return null;
  }

  function mimeToExtension(mime) {
    if (!mime) {
      return ".jpg";
    }

    const map = {
      "image/jpeg": ".jpg",
      "image/png": ".png",
      "image/webp": ".webp",
      "image/gif": ".gif"
    };

    return map[mime] || ".jpg";
  }

  function normalizeBase(value) {
    if (!value) {
      return "/";
    }

    let normalized = String(value).trim();
    if (!normalized.length) {
      return "/";
    }

    if (!normalized.endsWith("/")) {
      normalized += "/";
    }

    if (!/^https?:\/\//.test(normalized) && !normalized.startsWith("/")) {
      normalized = `/${normalized}`;
    }

    return normalized;
  }

  function escapeHtml(value) {
    if (value === null || value === undefined) {
      return "";
    }

    return String(value)
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;")
      .replace(/'/g, "&#39;");
  }

  function initializeLightbox(items) {
    lightboxState.items = items;
    const grid = document.getElementById("person-media-grid");
    const modalEl = document.getElementById("mediaLightbox");
    if (!grid || !modalEl) {
      return;
    }

    if (!lightboxState.elements.modalEl) {
      lightboxState.elements = {
        modalEl,
        image: document.getElementById("mediaLightboxImage"),
        caption: document.getElementById("mediaLightboxCaption"),
        meta: document.getElementById("mediaLightboxMeta"),
        counter: document.getElementById("mediaLightboxCounter"),
        spinner: document.getElementById("mediaLightboxSpinner"),
        download: document.getElementById("mediaLightboxDownload"),
        prevBtn: modalEl.querySelector(".lightbox-prev"),
        nextBtn: modalEl.querySelector(".lightbox-next")
      };
      arrangeLightboxChrome(modalEl);
    }

    if (!lightboxState.listenersBound) {
      grid.addEventListener("click", handleMediaTriggerClick);
      bindLightboxControls();
      lightboxState.listenersBound = true;
    }
  }

  // Lightbox (DS): one top row — counter "3 of 12" left, download and close (44 x 44) right — over the photo, then the caption
  // and "date · place". The Eleventy markup puts the counter and download in a footer; they are moved once, here.
  function arrangeLightboxChrome(modalEl) {
    const { counter, download, spinner, meta } = lightboxState.elements;
    const header = modalEl.querySelector(".modal-header");
    const close = modalEl.querySelector(".lightbox-close");
    const title = modalEl.querySelector(".modal-title");
    if (title) {
      title.textContent = "photo";
      title.classList.add("visually-hidden");
    }
    if (header) {
      const actions = document.createElement("div");
      actions.className = "lightbox-actions";
      if (download) {
        download.textContent = VOICE.download;
        actions.appendChild(download);
      }
      if (close) {
        actions.appendChild(close);
      }
      if (counter) {
        counter.className = "lightbox-counter";
        header.appendChild(counter);
      }
      header.appendChild(actions);
    }
    const footer = modalEl.querySelector(".modal-footer");
    if (footer) {
      footer.classList.add("d-none");
      footer.hidden = true;
    }
    if (spinner) {
      const text = spinner.querySelector("p");
      if (text) {
        text.textContent = VOICE.loading;
      }
    }
    if (meta) {
      meta.className = "lightbox-meta";
    }
    const body = modalEl.querySelector(".modal-body");
    if (body && !body.querySelector(".lightbox-error")) {
      const banner = document.createElement("div");
      banner.className = "alert alert-danger lightbox-error d-none";
      banner.setAttribute("role", "alert");
      banner.textContent = VOICE.photoError;
      body.insertBefore(banner, body.firstChild);
      lightboxState.elements.errorBanner = banner;
    }
    bindLightboxSwipe(body || modalEl);
  }

  // Below 688px there are no side arrows: swipe left/right steps, swipe down closes (threshold 80px).
  function bindLightboxSwipe(surface) {
    let start = null;
    surface.addEventListener("touchstart", (event) => {
      start = event.touches.length === 1 ? { x: event.touches[0].clientX, y: event.touches[0].clientY } : null;
    }, { passive: true });
    surface.addEventListener("touchend", (event) => {
      if (!start || !event.changedTouches.length) {
        start = null;
        return;
      }
      const dx = event.changedTouches[0].clientX - start.x;
      const dy = event.changedTouches[0].clientY - start.y;
      start = null;
      if (Math.abs(dx) >= SWIPE_MIN && Math.abs(dx) > Math.abs(dy)) {
        stepLightbox(dx < 0 ? 1 : -1);
      } else if (dy >= SWIPE_MIN && dy > Math.abs(dx) && lightboxState.modal) {
        lightboxState.modal.hide();
      }
    }, { passive: true });
  }

  function handleMediaTriggerClick(event) {
    const trigger = event.target.closest(".media-lightbox-trigger");
    if (!trigger) {
      return;
    }
    event.preventDefault();
    const index = Number(trigger.getAttribute("data-media-index"));
    if (Number.isNaN(index)) {
      return;
    }
    lightboxState.lastTrigger = trigger;
    openLightbox(index);
  }

  function bindLightboxControls() {
    const { modalEl, prevBtn, nextBtn } = lightboxState.elements;
    if (prevBtn) {
      prevBtn.addEventListener("click", () => stepLightbox(-1));
    }
    if (nextBtn) {
      nextBtn.addEventListener("click", () => stepLightbox(1));
    }
    if (modalEl) {
      modalEl.addEventListener("shown.bs.modal", attachLightboxKeyboard);
      modalEl.addEventListener("hidden.bs.modal", detachLightboxKeyboard);
    }
  }

  function attachLightboxKeyboard() {
    lightboxState.keyHandler = (event) => {
      if (event.key === "ArrowRight") {
        stepLightbox(1);
      } else if (event.key === "ArrowLeft") {
        stepLightbox(-1);
      }
    };
    document.addEventListener("keydown", lightboxState.keyHandler);
  }

  function detachLightboxKeyboard() {
    if (lightboxState.keyHandler) {
      document.removeEventListener("keydown", lightboxState.keyHandler);
      lightboxState.keyHandler = null;
    }
    if (lightboxState.lastTrigger && typeof lightboxState.lastTrigger.focus === "function") {
      lightboxState.lastTrigger.focus();
    }
  }

  function stepLightbox(delta) {
    const nextIndex = lightboxState.currentIndex + delta;
    if (nextIndex < 0 || nextIndex >= lightboxState.items.length) {
      return;
    }
    openLightbox(nextIndex, { reopen: true });
  }

  function openLightbox(index, options = {}) {
    const items = lightboxState.items || [];
    if (!items.length || !items[index]) {
      return;
    }
    lightboxState.currentIndex = index;

    const modal = ensureLightboxModal();
    if (!modal) {
      const fallbackUrl = resolveMediaPath(items[index]);
      if (fallbackUrl) {
        window.open(fallbackUrl, "_blank", "noopener");
      }
      return;
    }

    renderLightboxContent(items[index]);
    if (!options.reopen) {
      reparentModal(lightboxState.elements.modalEl);
      modal.show();
    }
  }

  function ensureLightboxModal() {
    if (!lightboxState.elements.modalEl) {
      return null;
    }
    if (!lightboxState.modal) {
      const ModalCtor = window.bootstrap && window.bootstrap.Modal;
      if (!ModalCtor) {
        return null;
      }
      lightboxState.modal = new ModalCtor(lightboxState.elements.modalEl, {
        keyboard: true,
        focus: true,
        backdrop: true
      });
    }
    return lightboxState.modal;
  }

  function renderLightboxContent(media) {
    const {
      image,
      caption,
      meta,
      counter,
      spinner,
      download,
      prevBtn,
      nextBtn,
      errorBanner
    } = lightboxState.elements;
    if (!image || !caption || !meta || !counter || !spinner) {
      return;
    }

    const token = ++lightboxState.loadToken;
    toggleSpinner(true);
    image.classList.add("d-none");
    if (errorBanner) {
      errorBanner.classList.add("d-none");
    }
    caption.textContent = media.title || "";
    caption.hidden = !media.title;
    const metaText = buildLightboxMeta(media);
    meta.textContent = metaText;
    meta.hidden = !metaText;
    counter.textContent = `${lightboxState.currentIndex + 1} of ${lightboxState.items.length}`;

    const mediaUrl = resolveMediaPath(media);
    setDownload(download, mediaUrl);

    if (prevBtn && nextBtn) {
      prevBtn.classList.toggle("d-none", lightboxState.items.length <= 1);
      nextBtn.classList.toggle("d-none", lightboxState.items.length <= 1);
      prevBtn.disabled = lightboxState.currentIndex === 0;
      nextBtn.disabled = lightboxState.currentIndex >= lightboxState.items.length - 1;
    }

    if (!mediaUrl) {
      toggleSpinner(false);
      showLightboxError();
      return;
    }

    const loader = new Image();
    loader.onload = () => {
      if (token !== lightboxState.loadToken) {
        return;
      }
      image.src = mediaUrl;
      image.alt = media.title || "photo";
      toggleSpinner(false);
      image.classList.remove("d-none");
      document.dispatchEvent(new CustomEvent("hfy:lightbox-media", { detail: { index: lightboxState.currentIndex, media, img: image, box: image.parentElement } }));
    };
    loader.onerror = () => {
      if (token !== lightboxState.loadToken) {
        return;
      }
      toggleSpinner(false);
      setDownload(download, null);
      showLightboxError();
    };
    loader.src = mediaUrl;
  }

  function setDownload(download, url) {
    if (!download) {
      return;
    }
    if (url) {
      download.classList.remove("disabled");
      download.removeAttribute("aria-disabled");
      download.href = url;
    } else {
      download.classList.add("disabled");
      download.setAttribute("aria-disabled", "true");
      download.removeAttribute("href");
    }
  }

  function showLightboxError() {
    const { errorBanner } = lightboxState.elements;
    if (errorBanner) {
      errorBanner.classList.remove("d-none");
    }
  }

  // "date · place" in text.dim, as the archive has them (never relative). Media items carry neither today; the line stays hidden.
  function buildLightboxMeta(media) {
    const date = media.date && typeof media.date === "object" ? media.date.text : media.date;
    const place = media.place && typeof media.place === "object" ? media.place.displayName : media.place;
    return [date, place].filter((part) => typeof part === "string" && part.trim()).join(" · ");
  }

  function toggleSpinner(show) {
    const { spinner } = lightboxState.elements;
    if (!spinner) {
      return;
    }
    spinner.classList.toggle("d-none", !show);
    spinner.setAttribute("aria-hidden", show ? "false" : "true");
    spinner.hidden = !show;
    spinner.style.display = show ? "" : "none";
  }
})();
