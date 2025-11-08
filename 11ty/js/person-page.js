(() => {
  window.addEventListener("error", (event) => {
    const errorContainer = document.getElementById("person-error");
    const loading = document.getElementById("person-loading");
    if (errorContainer) {
      errorContainer.textContent = event.error ? event.error.message : (event.message || "Unexpected error rendering profile.");
      errorContainer.classList.remove("d-none");
    }
    if (loading) {
      loading.classList.add("d-none");
    }
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
    elements: {}
  };
  let currentFamilyTreeMarkup = "";
  const FAMILY_TREE_MODAL_ID = "familyTreeModal";
  const FAMILY_TREE_MODAL_CONTENT_ID = "familyTreeModalContent";

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
        showError("Missing required person id. Use ?id=<GRAMPS_ID> in the URL.", { loading, error });
        return;
      }

      const authorized = await requireAuthenticated({ loading, error });
      if (!authorized) {
        return;
      }

      fetchPerson(personId)
        .then((person) => {
          try {
            renderPerson(person, personId);
            hideLoading(loading);
            content.classList.remove("d-none");
          } catch (err) {
            console.error("[ERROR] Failed to render person profile:", err);
            showError(err.message || "Unable to render person profile.", { loading, error });
          }
        })
        .catch((err) => {
          console.error("[ERROR] Failed to load person record:", err);
          showError(err.message || "Unable to load person record.", { loading, error });
        });
    })();
  });

  document.addEventListener("click", (event) => {
    const zoomTrigger = event.target.closest("[data-family-tree-zoom]");
    if (!zoomTrigger) {
      return;
    }
    if (!currentFamilyTreeMarkup) {
      return;
    }
    const modalContent = document.getElementById(FAMILY_TREE_MODAL_CONTENT_ID);
    if (modalContent) {
      modalContent.innerHTML = `<div class="family-tree-embed family-tree-embed--modal">${currentFamilyTreeMarkup}</div>`;
    }
  });

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

  async function fetchPerson(personId) {
    const dataUrl = buildDataUrl(personId);
    state.lastDataUrl = dataUrl;

    const response = await fetch(dataUrl, { credentials: "same-origin" });
    if (!response.ok) {
      throw new Error(`Person record ${personId} not found (HTTP ${response.status}).`);
    }

    return response.json();
  }

  async function requireAuthenticated() {
    const featureFlags = await waitForFeatureFlags();
    const auth = await waitForAuth();

    const flagState = featureFlags && typeof featureFlags.getState === "function" ? featureFlags.getState() : {};
    if (flagState.loggedIn && flagState.sessionToken) {
      return true;
    }

    const token = auth && typeof auth.getLatestIdToken === "function" ? auth.getLatestIdToken() : null;

    if (featureFlags && typeof featureFlags.verifySession === "function" && token) {
      try {
        const result = await featureFlags.verifySession({ googleIdToken: token });
        if (result && result.allowed) {
          return true;
        }
      } catch (err) {
        console.error("[HFY_PERSON] verifySession failed", err);
      }
    }

    redirectToLogin();
    return false;
  }

  function renderPerson(person, personId) {
    if (!person) {
      throw new Error("No person data returned.");
    }

    updateDocumentTitle(person);
    renderHero(person);
    const hasMedia = renderMediaGallery(person);
    const hasFamilyList = renderFamily(person);
    const hasFamilyVisualization = renderFamilyVisualization(person);
    toggleSection("person-media-section", hasMedia);
    toggleSection("person-family-section", hasFamilyList || hasFamilyVisualization);
    toggleSection("person-events-section", renderEvents(person));
    // Debug section removed for production experience.
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
    const lifespan = buildLifespan(person);
    const notesMarkup = buildNotesMarkup(person);

    container.innerHTML = `
      <div class="row align-items-start gy-4">
        <div class="col-lg-4 text-center mb-4 mb-lg-0">
          ${photoUrl ? renderPhotoTag(photoUrl, person.displayName, placeholder) : renderPhotoPlaceholder()}
        </div>
        <div class="col-lg-8">
          <div class="person-details">
            <h1 class="display-4 mb-3">${escapeHtml(person.displayName || "Unknown Person")}</h1>
            ${renderLivingBadge(person.isLiving)}
            <div class="person-metadata">
              ${lifespan.birth ? `<p class="mb-2"><strong>Born:</strong> ${lifespan.birth}</p>` : ""}
              ${lifespan.death ? `<p class="mb-2"><strong>Died:</strong> ${lifespan.death}</p>` : ""}
              ${person.gender ? `<p class="mb-2"><strong>Gender:</strong> ${escapeHtml(capitalize(person.gender))}</p>` : ""}
              <p class="text-muted small mb-0">ID: ${escapeHtml(person.grampsId || "Unknown")}</p>
            </div>
          </div>
          ${notesMarkup}
        </div>
      </div>
    `;

    section.classList.remove("d-none");
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

  function renderPhotoTag(url, displayName, fallback) {
    const safeName = escapeHtml(displayName || "Person photo");
    const safeFallback = fallback ? escapeHtml(fallback) : "";
    return `
      <img
        src="${url}"
        alt="${safeName}"
        class="person-photo img-fluid rounded"
        style="max-width: 320px; width: 100%;"
        ${safeFallback ? `onerror="this.src='${safeFallback}'"` : ""}
      >
    `;
  }

  function buildNotesMarkup(person) {
    const notes = Array.isArray(person.notes) ? person.notes : [];
    const heading = `<h2 class="h4 mb-3">Notes &amp; Biography</h2>`;

    if (!notes.length) {
      return `
        <div class="notes-panel mt-4">
          ${heading}
          <p class="text-muted mb-0">No notes available.</p>
        </div>
      `;
    }

    const noteCards = notes.map((note) => {
      if (note && note.html) {
        return `<div class="card mb-3"><div class="card-body">${note.html}</div></div>`;
      }
      const raw = note && note.raw ? escapeHtml(note.raw) : "Note content unavailable.";
      return `<div class="card mb-3"><div class="card-body"><p class="mb-0">${raw}</p></div></div>`;
    }).join("");

    return `
      <div class="notes-panel mt-4">
        ${heading}
        ${noteCards}
      </div>
    `;
  }

  function renderPhotoPlaceholder() {
    return `
      <div class="person-photo-placeholder bg-secondary rounded d-flex align-items-center justify-content-center" style="width: 320px; height: 400px;">
        <span class="text-white">No Photo Available</span>
      </div>
    `;
  }

  function renderLivingBadge(isLiving) {
    if (isLiving === true) {
      return `<span class="badge bg-success mb-3">Living</span>`;
    }
    if (isLiving === false) {
      return `<span class="badge bg-secondary mb-3">Deceased</span>`;
    }
    return "";
  }

  function renderRelationBadge(isLiving) {
    if (isLiving === true) {
      return ` <span class="badge bg-success badge-sm">Living</span>`;
    }
    if (isLiving === false) {
      return ` <span class="badge bg-secondary badge-sm">Deceased</span>`;
    }
    return "";
  }

  function buildLifespan(person) {
    const birth = person.lifespan && person.lifespan.birth ? formatEventMoment(person.lifespan.birth) : null;
    const death = person.isLiving === true ? null : (person.lifespan && person.lifespan.death ? formatEventMoment(person.lifespan.death) : null);
    return { birth, death };
  }

  function formatEventMoment(moment) {
    if (!moment) return "";

    const year = moment.year ? escapeHtml(String(moment.year)) : null;
    const place = moment.place && moment.place.displayName ? ` in ${escapeHtml(moment.place.displayName)}` : "";

    return `${year || "Unknown"}${place}`;
  }

  function renderMediaGallery(person) {
    const grid = document.getElementById("person-media-grid");
    if (!grid) {
      return false;
    }

    const items = Array.isArray(person.mediaGallery) ? person.mediaGallery : [];
    if (!items.length) {
      grid.innerHTML = `<p class="text-muted mb-0">No media available.</p>`;
      return false;
    }

    const markup = items.map((media, index) => {
      const url = resolveMediaPath(media);
      const placeholder = media && media.placeholderImage ? escapeHtml(media.placeholderImage) : "";
      const title = media && media.title ? escapeHtml(media.title) : "";
      const alt = title || "Media item";
      const hasUrl = Boolean(url);
      const triggerStart = hasUrl
        ? `<button type="button" class="media-lightbox-trigger" data-media-index="${index}" aria-label="View ${alt} in lightbox">`
        : `<div>`;
      const triggerEnd = hasUrl ? `</button>` : `</div>`;

      return `
        <div class="col-6 col-md-4 col-lg-2">
          <div class="card h-100">
            ${url ? `
              ${triggerStart}
                <img
                  src="${url}"
                  class="card-img-top"
                  alt="${alt}"
                  ${placeholder ? `onerror="this.src='${placeholder}'"` : ""}
                >
              ${triggerEnd}
            ` : `
              <div class="card-img-top bg-secondary d-flex align-items-center justify-content-center" style="height: 170px;">
                <span class="text-white small">Media missing</span>
              </div>
            `}
            ${title ? `<div class="card-body"><p class="card-text small mb-0">${title}</p></div>` : ""}
          </div>
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
      addRelative(categories.parents, family.father, "Father");
      addRelative(categories.parents, family.mother, "Mother");
      (Array.isArray(family.children) ? family.children : []).forEach((child) => {
        addRelative(categories.siblings, child);
      });
    });

    spouseFamilies.forEach((family) => {
      const possibleParents = [family.father, family.mother];
      possibleParents.forEach((relative) => {
        if (!relative) return;
        const label = "Spouse";
        addRelative(categories.spouses, relative, label);
      });
      (Array.isArray(family.children) ? family.children : []).forEach((child) => {
        addRelative(categories.children, child);
      });
    });

    const orderedCategories = [
      { key: "parents", heading: "Parents" },
      { key: "siblings", heading: "Siblings" },
      { key: "spouses", heading: "Spouses" },
      { key: "children", heading: "Children" }
    ];

    const sections = orderedCategories
      .map(({ key, heading }) => {
        const entries = Array.from(categories[key].values());
        if (!entries.length) {
          return "";
        }
        const items = entries
          .map(({ relative, label }) => renderFamilyRelative(relative, label))
          .join("");
        return `
          <li class="mb-3">
            <strong class="d-block mb-2">${heading}</strong>
            <ul class="list-unstyled mb-0 ms-3">
              ${items}
            </ul>
          </li>
        `;
      })
      .filter(Boolean);

    if (!sections.length) {
      container.innerHTML = `<p class="text-muted mb-0">No family data available.</p>`;
      return false;
    }

    container.innerHTML = `
      <ul class="list-unstyled family-list mb-0">
        ${sections.join("")}
      </ul>
    `;

    return true;
  }

  function renderFamilyVisualization(person) {
    const container = document.getElementById("person-family-visualization");
    if (!container) {
      return false;
    }

    const media = person.familyTreeMedia;
    if (!media || !media.path) {
      container.innerHTML = "";
      container.classList.add("d-none");
      return false;
    }

    const svgUrl = resolveMediaAssetPath(media.path);
    if (!svgUrl) {
      container.innerHTML = "";
      container.classList.add("d-none");
      return false;
    }

    container.innerHTML = `<div class="text-muted small py-4 text-center">Loading family tree…</div>`;
    container.classList.remove("d-none");

    fetch(svgUrl, { credentials: "same-origin" })
      .then((response) => {
        if (!response.ok) {
          throw new Error(`Unable to load SVG (HTTP ${response.status})`);
        }
        return response.text();
      })
      .then((svgMarkup) => {
        currentFamilyTreeMarkup = svgMarkup;
        const zoomButton = `
          <div class="text-end mt-5 pt-2">
            <button type="button"
                    class="btn btn-outline-light btn-sm"
                    data-family-tree-zoom
                    data-bs-toggle="modal"
                    data-bs-target="#${FAMILY_TREE_MODAL_ID}">
              Zoom in
            </button>
          </div>
        `;
        container.innerHTML = `<div class="family-tree-embed">${svgMarkup}</div>${zoomButton}`;
      })
      .catch((error) => {
        console.error("[ERROR] Failed to load family tree visualization:", error);
        container.innerHTML = `<p class="text-muted small mb-0">Unable to load family tree visualization.</p>`;
      });

    return true;
  }

  function renderFamilyRelative(relative, label) {
    const name = escapeHtml(relative.displayName);
    const link = relative.grampsId
      ? `<a href="/person/?id=${encodeURIComponent(relative.grampsId)}" class="link-primary text-decoration-none">${name}</a>`
      : name;
    const badge = renderRelationBadge(relative.isLiving);
    const labelPrefix = label ? `<span class="text-muted small me-2">${escapeHtml(label)}: </span>` : "";
    return `<li class="mb-1">${labelPrefix}${link}${badge}</li>`;
  }

  function renderEvents(person) {
    const container = document.getElementById("person-events");
    if (!container) {
      return false;
    }

    const events = Array.isArray(person.events) ? person.events : [];
    if (!events.length) {
      container.innerHTML = `<p class="text-muted mb-0">No events recorded.</p>`;
      return false;
    }

    container.innerHTML = events.map((event) => {
      const title = escapeHtml(event.label || "Event");
      const description = event.description ? `<p class="card-text">${escapeHtml(event.description)}</p>` : "";
      const place = event.place && event.place.displayName ? `<p class="card-text"><small class="text-muted"><i class="bi bi-geo-alt"></i> ${escapeHtml(event.place.displayName)}</small></p>` : "";
      const date = event.date && event.date.text ? escapeHtml(event.date.text) : "Date unknown";
      const showUnknownBadge = event.label === "Event" ? `<span class="badge bg-warning text-dark">Type Unknown</span>` : "";

      return `
        <div class="timeline-item mb-4">
          <div class="card">
            <div class="card-body">
              <div class="d-flex justify-content-between align-items-start">
                <div>
                  <h5 class="card-title">${title} ${showUnknownBadge}</h5>
                  ${description}
                  ${place}
                </div>
                <div class="text-end">
                  <span class="badge bg-primary">${date}</span>
                </div>
              </div>
            </div>
          </div>
        </div>
      `;
    }).join("");

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

  function capitalize(value) {
    if (!value) {
      return "";
    }

    const str = String(value);
    return str.charAt(0).toUpperCase() + str.slice(1);
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
    }

    if (!lightboxState.listenersBound) {
      grid.addEventListener("click", handleMediaTriggerClick);
      bindLightboxControls();
      lightboxState.listenersBound = true;
    }
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
      nextBtn
    } = lightboxState.elements;
    if (!image || !caption || !meta || !counter || !spinner) {
      return;
    }

    toggleSpinner(true);
    image.classList.add("d-none");
    caption.textContent = media.title || "Untitled media";
    meta.innerHTML = buildLightboxMeta(media);
    counter.textContent = `Media ${lightboxState.currentIndex + 1} of ${lightboxState.items.length}`;

    const mediaUrl = resolveMediaPath(media);
    if (download) {
      if (mediaUrl) {
        download.classList.remove("disabled");
        download.href = mediaUrl;
      } else {
        download.classList.add("disabled");
        download.removeAttribute("href");
      }
    }

    if (prevBtn && nextBtn) {
      prevBtn.classList.toggle("d-none", lightboxState.items.length <= 1);
      nextBtn.classList.toggle("d-none", lightboxState.items.length <= 1);
      prevBtn.disabled = lightboxState.currentIndex === 0;
      nextBtn.disabled = lightboxState.currentIndex >= lightboxState.items.length - 1;
    }

    if (!mediaUrl) {
      toggleSpinner(false);
      caption.textContent = `${caption.textContent} (media unavailable)`;
      return;
    }

    const loader = new Image();
    loader.onload = () => {
      image.src = mediaUrl;
      image.alt = media.title || "Media preview";
      toggleSpinner(false);
      image.classList.remove("d-none");
    };
    loader.onerror = () => {
      toggleSpinner(false);
      caption.textContent = `${caption.textContent} (failed to load media)`;
    };
    loader.src = mediaUrl;
  }

  function buildLightboxMeta(media) {
    const chips = [];
    if (media.grampsId) {
      chips.push(`<span class="badge bg-secondary">ID ${escapeHtml(media.grampsId)}</span>`);
    }
    if (media.mime) {
      chips.push(`<span class="badge bg-dark text-uppercase">${escapeHtml(media.mime)}</span>`);
    }
    if (media.handle) {
      chips.push(`<span class="badge bg-dark">${escapeHtml(media.handle)}</span>`);
    }
    return chips.join("");
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
