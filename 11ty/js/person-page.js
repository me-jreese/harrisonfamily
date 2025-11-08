(() => {
  const config = window.HFY_PERSON_CONFIG || {};
  const state = {
    env: config.env || "dev",
    dataBase: normalizeBase(config.dataBase || "/person/"),
    mediaBase: normalizeBase(config.mediaBase || "/media/"),
    lastDataUrl: null
  };

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

    if (!personId) {
      showError("Missing required person id. Use ?id=<GRAMPS_ID> in the URL.", { loading, error });
      return;
    }

    fetchPerson(personId)
      .then((person) => {
        hideLoading(loading);
        renderPerson(person, personId);
        content.classList.remove("d-none");
      })
      .catch((err) => {
        console.error("[ERROR] Failed to load person record:", err);
        showError(err.message || "Unable to load person record.", { loading, error });
      });
  });

  function hideLoading(loadingEl) {
    if (loadingEl) {
      loadingEl.classList.add("d-none");
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

  function renderPerson(person, personId) {
    if (!person) {
      throw new Error("No person data returned.");
    }

    updateDocumentTitle(person);
    renderHero(person);
    toggleSection("person-media-section", renderMediaGallery(person));
    toggleSection("person-notes-section", renderNotes(person));
    toggleSection("person-family-section", renderFamily(person));
    toggleSection("person-events-section", renderEvents(person));
    renderDebug(person, personId);
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

    container.innerHTML = `
      <div class="row align-items-center">
        <div class="col-md-4 text-center mb-4 mb-md-0">
          ${photoUrl ? renderPhotoTag(photoUrl, person.displayName, placeholder) : renderPhotoPlaceholder()}
        </div>
        <div class="col-md-8">
          <h1 class="display-4 mb-3">${escapeHtml(person.displayName || "Unknown Person")}</h1>
          ${renderLivingBadge(person.isLiving)}
          <div class="person-metadata">
            ${lifespan.birth ? `<p class="mb-2"><strong>Born:</strong> ${lifespan.birth}</p>` : ""}
            ${lifespan.death ? `<p class="mb-2"><strong>Died:</strong> ${lifespan.death}</p>` : ""}
            ${person.gender ? `<p class="mb-2"><strong>Gender:</strong> ${escapeHtml(capitalize(person.gender))}</p>` : ""}
            <p class="text-muted small mb-0">ID: ${escapeHtml(person.grampsId || "Unknown")}</p>
          </div>
        </div>
      </div>
    `;

    section.classList.remove("d-none");
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

    const markup = items.map((media) => {
      const url = resolveMediaPath(media);
      const placeholder = media && media.placeholderImage ? escapeHtml(media.placeholderImage) : "";
      const title = media && media.title ? escapeHtml(media.title) : "";
      const alt = title || "Media item";

      return `
        <div class="col-md-4 col-sm-6">
          <div class="card h-100">
            ${url ? `
              <img
                src="${url}"
                class="card-img-top"
                alt="${alt}"
                ${placeholder ? `onerror="this.src='${placeholder}'"` : ""}
              >
            ` : `
              <div class="card-img-top bg-secondary d-flex align-items-center justify-content-center" style="height: 200px;">
                <span class="text-white small">Media missing</span>
              </div>
            `}
            ${title ? `<div class="card-body"><p class="card-text small mb-0">${title}</p></div>` : ""}
          </div>
        </div>
      `;
    }).join("");

    grid.innerHTML = markup;
    return true;
  }

  function renderNotes(person) {
    const container = document.getElementById("person-notes");
    if (!container) {
      return false;
    }

    const notes = Array.isArray(person.notes) ? person.notes : [];
    if (!notes.length) {
      container.innerHTML = `<p class="text-muted mb-0">No notes available.</p>`;
      return false;
    }

    container.innerHTML = notes.map((note) => {
      if (note && note.html) {
        return `<div class="card mb-3"><div class="card-body">${note.html}</div></div>`;
      }

      const raw = note && note.raw ? escapeHtml(note.raw) : "Note content unavailable.";
      return `<div class="card mb-3"><div class="card-body"><p class="mb-0">${raw}</p></div></div>`;
    }).join("");

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

    const sections = [];

    if (parentFamilies.length) {
      const markup = parentFamilies.map((family) => {
        const father = renderRelativeLine("Father", family.father);
        const mother = renderRelativeLine("Mother", family.mother);
        const siblings = renderSiblingList(person, family.children);
        const listItems = [father, mother, siblings].filter(Boolean).join("");

        if (!listItems.length) {
          return "";
        }

        return `
          <div class="mb-4">
            <ul class="list-unstyled ms-3">
              ${listItems}
            </ul>
          </div>
        `;
      }).filter(Boolean).join("");

      if (markup.length) {
        sections.push(`<h4>Parents</h4>${markup}`);
      }
    }

    if (spouseFamilies.length) {
      const markup = spouseFamilies.map((family) => {
        const spouse = renderRelativeLine("Spouse", family.spouse || family.partner);
        const childrenList = renderChildrenList(family.children);
        const content = [];

        if (spouse) {
          content.push(spouse);
        }

        if (!spouse && !childrenList) {
          content.push(`<p class="text-muted mb-2"><em>Spouse data not available.</em></p>`);
        }

        if (childrenList) {
          content.push(childrenList);
        }

        if (!content.length) {
          return "";
        }

        return `
          <div class="mb-3">
            ${content.join("")}
          </div>
        `;
      }).filter(Boolean).join("");

      if (markup.length) {
        sections.push(`<h4 class="mt-4">Spouse &amp; Children</h4>${markup}`);
      }
    }

    container.innerHTML = sections.length ? sections.join("") : `<p class="text-muted mb-0">No family data available.</p>`;
    return sections.length > 0;
  }

  function renderRelativeLine(label, relative) {
    if (!relative || !relative.displayName) {
      return "";
    }

    const displayValue = escapeHtml(relative.displayName);
    const link = relative.grampsId ? `<a href="/person/?id=${encodeURIComponent(relative.grampsId)}" class="link-primary text-decoration-none">${displayValue}</a>` : displayValue;
    const badge = relative.isLiving ? ` <span class="badge bg-success badge-sm">Living</span>` : "";

    return `<li><strong>${label}:</strong> ${link}${badge}</li>`;
  }

  function renderSiblingList(person, siblings) {
    const items = (Array.isArray(siblings) ? siblings : []).filter((sibling) => sibling && sibling.handle !== person.handle && sibling.displayName);

    if (!items.length) {
      return "";
    }

    const markup = items.map((sibling) => {
      const name = escapeHtml(sibling.displayName);
      const badge = sibling.isLiving ? ` <span class="badge bg-success badge-sm">Living</span>` : "";
      const link = sibling.grampsId ? `<a href="/person/?id=${encodeURIComponent(sibling.grampsId)}" class="link-primary text-decoration-none">${name}</a>` : name;
      return `<li>${link}${badge}</li>`;
    }).join("");

    return `
      <li class="mt-2">
        <strong>Siblings:</strong>
        <ul class="mb-0">
          ${markup}
        </ul>
      </li>
    `;
  }

  function renderChildrenList(children) {
    const items = (Array.isArray(children) ? children : []).filter((child) => child && child.displayName);
    if (!items.length) {
      return "";
    }

    const markup = items.map((child) => {
      const name = escapeHtml(child.displayName);
      const badge = child.isLiving ? ` <span class="badge bg-success badge-sm">Living</span>` : "";
      const link = child.grampsId ? `<a href="/person/?id=${encodeURIComponent(child.grampsId)}" class="link-primary text-decoration-none">${name}</a>` : name;
      return `<li>${link}${badge}</li>`;
    }).join("");

    return `
      <p class="mb-2"><strong>Children:</strong></p>
      <ul class="mb-0 ms-3">
        ${markup}
      </ul>
    `;
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

  function renderDebug(person, personId) {
    const debug = document.getElementById("person-debug");
    if (!debug) {
      return;
    }

    const lines = [
      `Person ID: ${personId}`,
      `Handle: ${person.handle || "Unknown"}`,
      `Data source: ${state.lastDataUrl || "Unknown"}`,
      `Environment: ${state.env}`
    ];

    debug.textContent = lines.join("\n");
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
})();
