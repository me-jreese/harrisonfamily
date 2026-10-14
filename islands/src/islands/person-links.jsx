// Profile links on the person page (HFY-TSK-217, flag profileLinks; HFY-PLN-002 surfaces 6.4, D2-22): a labelled "links" section with
// the member's chips, and for the owner an "edit links" (or "add your links") chip to /me/links/. It fills the person page's
// [data-slot="links"] host (HFY-TSK-137, under the lifespan line) and edits nothing else of the page. The hero and its slots are
// rebuilt by every render, so it fills the host again on every hfy:person-rendered; the loader can run after the first render, so it
// also fills the host once if it is already there. A visitor, a signed-out reader, a person with no links, the route answering 404
// (flag off at the API) or any error shows nothing at all.
import "./person-links.css";
import { useEffect, useId, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import { api } from "../lib/api.js";
import { getMe } from "../lib/me.js";
import { ADD_LINKS, CHIP_REL, CLEAR_COPY, EDIT_LINKS, LINKS_PATH, SECTION_TITLE, chipsFrom, clearBody } from "../lib/profile-links.js";

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

/** The hfy-admin's clear-only control (HFY-TSK-329): one button, a confirmation, then PUT with `null` for every set platform. */
function ClearLinks({ personId, data, onData }) {
  const [phase, setPhase] = useState("idle"); // idle | ask | busy
  const [note, setNote] = useState("");
  const askRef = useRef(null);
  useEffect(() => { if (phase === "ask") askRef.current?.focus(); }, [phase]);
  const url = `/people/${encodeURIComponent(personId)}/links`;
  const refresh = (d) => {
    reads.set(personId, Promise.resolve(d));
    onData(d);
  };
  async function clear() {
    setPhase("busy");
    setNote("");
    try {
      const res = await api.put(url, clearBody(data.links, data.version));
      refresh({ ...data, links: res?.links ?? {}, version: res?.version ?? data.version });
      setNote(CLEAR_COPY.done);
    } catch (err) {
      if (err && err.status === 409) {
        try { refresh(await api.get(url)); } catch { /* the latest could not be fetched: keep what is shown */ }
        setNote(CLEAR_COPY.conflict);
      } else setNote(CLEAR_COPY.failed);
    }
    setPhase("idle");
  }
  return (
    <div className="hfy-links__admin" data-hfy-links="admin">
      {phase === "idle" && chipsFrom(data.links).length > 0 && (
        <button type="button" className="hfy-links__clear" data-hfy-links="clear" onClick={() => setPhase("ask")}>{CLEAR_COPY.clear}</button>
      )}
      {phase !== "idle" && (
        <div className="hfy-links__confirm" role="group" aria-label={CLEAR_COPY.clear}>
          <p className="hfy-links__ask">{CLEAR_COPY.ask}</p>
          <button type="button" className="hfy-links__clear hfy-links__clear--confirm" data-hfy-links="confirm" ref={askRef} disabled={phase === "busy"} onClick={clear}>
            {phase === "busy" ? CLEAR_COPY.clearing : CLEAR_COPY.confirm}
          </button>
          <button type="button" className="hfy-links__clear" data-hfy-links="cancel" disabled={phase === "busy"} onClick={() => setPhase("idle")}>{CLEAR_COPY.cancel}</button>
        </div>
      )}
      <p className="hfy-links__note" role="status">{note}</p>
    </div>
  );
}

export function PersonLinks({ personId }) {
  const [data, setData] = useState(null);
  const [admin, setAdmin] = useState(false);
  const titleId = useId();
  useEffect(() => {
    let live = true;
    readLinks(personId).then((d) => { if (live) setData(d); });
    getMe().then((me) => { if (live) setAdmin(me?.admin === true); });
    return () => { live = false; };
  }, [personId]);

  if (!data || typeof data !== "object") return null;
  const chips = chipsFrom(data.links);
  const owner = data.can?.edit === true;
  // An admin on someone else's page may only clear (the API's 403 for anything else); the control stays after a clear to say so.
  const canClear = admin && !owner;
  if (!chips.length && !owner && !canClear) return null;
  if (!chips.length && canClear && !data.cleared) return null;
  return (
    <section className="hfy-links" aria-labelledby={titleId}>
      <h2 className="hfy-links__title" id={titleId}>{SECTION_TITLE}</h2>
      {(chips.length > 0 || owner) && <ul className="person-links hfy-links__list" aria-labelledby={titleId}>
        {chips.map((chip) => <Chip key={chip.platform} chip={chip} />)}
        {owner && (
          <li>
            <a className="hfy-links__chip hfy-links__chip--edit" href={LINKS_PATH} data-hfy-links="edit">
              <span className="hfy-links__text">{chips.length ? EDIT_LINKS : ADD_LINKS}</span>
            </a>
          </li>
        )}
      </ul>}
      {canClear && <ClearLinks personId={personId} data={data} onData={(d) => setData({ ...d, cleared: true })} />}
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
