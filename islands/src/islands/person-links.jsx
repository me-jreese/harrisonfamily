// Profile links on the person page (HFY-TSK-217, flag profileLinks; HFY-PLN-002 surfaces 6.4, D2-22): a labelled "links" section with
// the member's chips, and for the owner an "edit links" (or "add your links") chip to /me/links/. It fills the person page's
// [data-slot="links"] host (HFY-TSK-137, under the lifespan line) and edits nothing else of the page. The hero and its slots are
// rebuilt by every render, so it fills the host again on every hfy:person-rendered; the loader can run after the first render, so it
// also fills the host once if it is already there. A visitor, a signed-out reader, a person with no links, the route answering 404
// (flag off at the API) or any error shows nothing at all.
import "./person-links.css";
import { useEffect, useId, useState } from "react";
import { createRoot } from "react-dom/client";
import { api } from "../lib/api.js";
import { ADD_LINKS, CHIP_REL, EDIT_LINKS, LINKS_PATH, SECTION_TITLE, chipsFrom } from "../lib/profile-links.js";

const reads = new Map();
/** One GET per person per page: a hero rebuild does not ask again. A failed read is forgotten so the next render can retry. */
function readLinks(personId) {
  if (!reads.has(personId)) {
    const p = api.get(`/people/${encodeURIComponent(personId)}/links`).catch(() => {
      reads.delete(personId);
      return null;
    });
    reads.set(personId, p);
  }
  return reads.get(personId);
}

export function Chip({ chip }) {
  return (
    <li>
      <a className="hfy-links__chip" data-platform={chip.platform} href={chip.href} target="_blank" rel={CHIP_REL} referrerPolicy="no-referrer" aria-label={chip.label}>
        <span className="hfy-links__icon" aria-hidden="true" />
        <span className="hfy-links__text">{chip.text}</span>
      </a>
    </li>
  );
}

export function PersonLinks({ personId }) {
  const [data, setData] = useState(null);
  const titleId = useId();
  useEffect(() => {
    let live = true;
    readLinks(personId).then((d) => { if (live) setData(d); });
    return () => { live = false; };
  }, [personId]);

  if (!data || typeof data !== "object") return null;
  const chips = chipsFrom(data.links);
  const owner = data.can?.edit === true;
  if (!chips.length && !owner) return null;
  return (
    <section className="hfy-links" aria-labelledby={titleId}>
      <h2 className="hfy-links__title" id={titleId}>{SECTION_TITLE}</h2>
      <ul className="person-links hfy-links__list" aria-labelledby={titleId}>
        {chips.map((chip) => <Chip key={chip.platform} chip={chip} />)}
        {owner && (
          <li>
            <a className="hfy-links__chip hfy-links__chip--edit" href={LINKS_PATH} data-hfy-links="edit">
              <span className="hfy-links__text">{chips.length ? EDIT_LINKS : ADD_LINKS}</span>
            </a>
          </li>
        )}
      </ul>
    </section>
  );
}

let mounted = null; // { host, root, personId }

function fill(personId) {
  const host = document.querySelector('#person-hero [data-slot="links"], [data-slot="links"]');
  if (!host || !personId) return;
  if (mounted && mounted.host === host && mounted.personId === personId && host.isConnected) return;
  if (mounted) {
    try { mounted.root.unmount(); } catch { /* the old host is gone with the old hero */ }
  }
  const root = createRoot(host);
  root.render(<PersonLinks personId={personId} />);
  mounted = { host, root, personId };
}

document.addEventListener("hfy:person-rendered", (e) => fill(e.detail && e.detail.personId));
fill(new URLSearchParams(location.search).get("id"));
