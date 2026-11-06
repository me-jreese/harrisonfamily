// "add to a family page…" under a comment photo (HFY-TSK-215, R-02; social.md section 10), behind the default-off flag graduateV1.
// The control is drawn through the kit Thread's `renderAttachmentActions` (lib/comments-ui.jsx) for an admin (`can.graduate` from /api/me).
// It opens an inline form under the photo, never a modal: "which page?" (a person picker over the people corpus, defaulting to the thread's
// person), "title" (the alt text), "add to page" and "cancel". On success the photo shows a badge, "on {name}'s page", linking to
// /person/?id=<x>#photos. Under 688 px the form stacks: 16 px inputs, full-width 44 px buttons, the picker's results as a list under the input.
// A reservation still pending after 15 minutes shows "retry". The title, the names and every message are text nodes, never markup.
import "../graduate.css";
import { useCallback, useEffect, useId, useRef, useState } from "react";
import { api } from "./api.js";
import { PersonName } from "./person-name.jsx";
import { COPY, TITLE_MAX, errorLine, graduate, initialTitle, markerState, onPage, photosHref, threadPerson } from "./graduate.js";

// Names the page has learned (a picked row, a lookup), by person id, shared by every control on the page.
const known = new Map();
const nameOf = (id) => known.get(id);

/** The people corpus loads when it is first needed (it is a search engine seeded from the family index). */
async function search(text) {
  const { suggestPeople } = await import("./people-corpus.js");
  return suggestPeople(text);
}

/** The name the family index shows for `id`, or undefined. Never rejects. */
async function lookupName(id) {
  if (known.has(id)) return known.get(id);
  try {
    const hit = (await search(id)).find((r) => r.id === id);
    if (hit?.title) known.set(id, hit.title);
  } catch { /* the badge then says "a family page" */ }
  return known.get(id);
}

function useName(id) {
  const [name, setName] = useState(() => (id ? nameOf(id) : undefined));
  useEffect(() => {
    if (!id) { setName(undefined); return undefined; }
    if (known.has(id)) { setName(known.get(id)); return undefined; }
    let live = true;
    lookupName(id).then((n) => { if (live) setName(n); });
    return () => { live = false; };
  }, [id]);
  return name;
}

/** The badge: "on {name}'s page" (a link to the person's photos). The name is the family index's, or "a family page" when it is not known. */
export function GraduateBadge({ person, name, soon = false }) {
  const shown = useName(name ? null : person);
  const text = name || shown;
  return (
    <p className="hfy-grad__done" data-hfy-grad-done>
      <a className="hfy-grad__badge" href={photosHref(person)} data-hfy-grad-badge>{text ? onPage(text) : "on a family page"}</a>
      {soon && <span className="hfy-grad__soon">{COPY.syncLater}</span>}
    </p>
  );
}

// ---------------------------------------------------------------------------------------------------------------- the person picker
/**
 * "which page?": the box searches as you type, and only a person picked from the list is a value (never the typed text). A pick is
 * `{ id, name }`. The list is a listbox under the input (arrow keys, Enter, Esc).
 */
function PagePicker({ value, onChange, disabled, inputRef }) {
  const id = useId();
  const [query, setQuery] = useState(value?.name ?? "");
  const [results, setResults] = useState([]);
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(-1);
  const [status, setStatus] = useState("idle");
  const seq = useRef(0);
  // The thread's person starts as a bare id; the name arrives from the index and replaces it unless the admin has typed something else.
  const lastName = useRef(value?.name ?? "");
  useEffect(() => {
    if (value && value.name && query === lastName.current && value.name !== query) setQuery(value.name);
    lastName.current = value?.name ?? lastName.current;
  }, [value]); // eslint-disable-line react-hooks/exhaustive-deps
  const run = async (q) => {
    const n = (seq.current += 1);
    if (!q.trim()) { setResults([]); setActive(-1); setStatus("idle"); return; }
    setStatus("loading");
    try {
      const found = await search(q);
      if (n !== seq.current) return;
      setResults(found);
      setActive(found.length ? 0 : -1);
      setStatus(found.length ? "idle" : "none");
    } catch {
      if (n === seq.current) { setResults([]); setStatus("none"); }
    }
  };
  const choose = (o) => {
    const name = o.title || o.id;
    known.set(o.id, name);
    setOpen(false);
    setResults([]);
    setQuery(name);
    lastName.current = name;
    onChange({ id: o.id, name });
  };
  const onKey = (e) => {
    if (e.key === "ArrowDown") { e.preventDefault(); setOpen(true); setActive((a) => Math.min(results.length - 1, a + 1)); }
    else if (e.key === "ArrowUp") { e.preventDefault(); setActive((a) => Math.max(0, a - 1)); }
    else if (e.key === "Escape" && open) { e.preventDefault(); e.stopPropagation(); setOpen(false); }
    else if (e.key === "Enter" && open && results[active]) { e.preventDefault(); choose(results[active]); }
  };
  const shown = open && results.length > 0;
  return (
    <div className="hfy-grad__field hfy-grad__pick">
      <label htmlFor={`${id}-input`}>{COPY.which}</label>
      <input
        id={`${id}-input`} ref={inputRef} className="hfy-grad__input" type="text" role="combobox" autoComplete="off" aria-autocomplete="list" disabled={disabled}
        aria-expanded={shown} aria-controls={`${id}-list`} aria-describedby={`${id}-hint`} aria-activedescendant={shown && active >= 0 ? `${id}-opt-${active}` : undefined}
        value={query}
        onChange={(e) => { setQuery(e.target.value); onChange(null); setOpen(true); run(e.target.value); }}
        onKeyDown={onKey}
      />
      <p className="hfy-grad__hint" id={`${id}-hint`}>{status === "loading" ? COPY.searching : status === "none" ? COPY.none : COPY.whichHint}</p>
      <ul id={`${id}-list`} role="listbox" aria-label={COPY.which} className="hfy-grad__list" hidden={!shown}>
        {results.map((o, i) => (
          <li key={o.id} id={`${id}-opt-${i}`} role="option" aria-selected={i === active} className="hfy-grad__option" onMouseDown={(e) => { e.preventDefault(); choose(o); }}>
            {o.title}{o.subtitle ? ` (${o.subtitle})` : ""}
          </li>
        ))}
      </ul>
    </div>
  );
}

// ---------------------------------------------------------------------------------------------------------------- the control
/**
 * `comment` and `attachment` are the thread's items, `subject` its id (person:<id> | post:<ulid>). `onAdded(name)` tells the thread to say so.
 * `client` is the API client (tests inject one).
 */
export function GraduateControl({ comment, attachment, subject, onAdded, client = api }) {
  const id = useId();
  const marker = markerState(attachment?.graduated);
  const home = threadPerson(subject);
  const homeName = useName(home);
  const [open, setOpen] = useState(false);
  const [person, setPerson] = useState(home ? { id: home, name: homeName ?? home } : null);
  const [title, setTitle] = useState(() => initialTitle(attachment));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const [done, setDone] = useState(null); // { person, name } after this control added the photo
  const trigger = useRef(null);
  const picker = useRef(null);
  const live = useRef(true);
  useEffect(() => { live.current = true; return () => { live.current = false; }; }, []);
  // The thread person's name resolves after the first paint: it replaces the bare id while the pick is still the default.
  useEffect(() => { if (home && homeName) setPerson((p) => (p && p.id === home && p.name === home ? { id: home, name: homeName } : p)); }, [home, homeName]);
  useEffect(() => { if (open) picker.current?.focus(); }, [open]);

  const close = useCallback((refocus = true) => {
    setOpen(false);
    setError(null);
    if (refocus) requestAnimationFrame(() => trigger.current?.focus());
  }, []);

  const send = useCallback(async (target, text) => {
    setBusy(true);
    setError(null);
    try {
      const r = await graduate(client, { commentId: comment.id, attachmentId: attachment.id, subject, person: target.id, title: text });
      if (!live.current) return;
      const pid = r?.person ?? target.id;
      if (target.name && target.name !== target.id) known.set(pid, target.name);
      setDone({ person: pid, name: nameOf(pid) });
      setOpen(false);
      onAdded?.();
    } catch (e) {
      if (!live.current) return;
      const line = errorLine(e, nameOf);
      // E18 names a page the photo is already on: a person id the index may not know yet.
      if (e?.code === "already_graduated" && e.details?.person && !known.has(e.details.person)) {
        const n = await lookupName(e.details.person);
        if (!live.current) return;
        setError(errorLine(e, () => n));
      } else setError(line);
    } finally {
      if (live.current) setBusy(false);
    }
  }, [client, comment.id, attachment.id, subject, onAdded]);

  if (done) return <GraduateBadge person={done.person} name={done.name} />;
  if (marker.kind === "done") return <GraduateBadge person={marker.person} />;

  const submit = (e) => {
    e.preventDefault();
    if (busy) return;
    if (!person) { setError({ text: COPY.needPerson }); return; }
    if (title.trim().length > TITLE_MAX) { setError({ text: COPY.titleLong, field: "title" }); return; }
    send(person, title);
  };

  if (marker.kind === "pending" && !open) {
    return (
      <div className="hfy-grad" data-hfy-grad data-state="pending">
        {marker.stale ? (
          <>
            <button type="button" className="hfy-btn hfy-btn--quiet hfy-grad__trigger" data-hfy-grad-retry disabled={busy} onClick={() => send({ id: marker.person }, marker.title ?? initialTitle(attachment))}>{busy ? COPY.adding : COPY.retry}</button>
            {error && <p className="hfy-grad__error" role="alert" data-hfy-grad-error>{error.text}</p>}
          </>
        ) : <p className="hfy-grad__status" role="status" data-hfy-grad-pending>{COPY.pending}</p>}
      </div>
    );
  }

  const titleId = `${id}-title`;
  const titleBad = error?.field === "title";
  return (
    <div className="hfy-grad" data-hfy-grad data-open={open ? "" : undefined}>
      {!open && <button type="button" className="hfy-btn hfy-btn--quiet hfy-grad__trigger" ref={trigger} aria-expanded="false" aria-controls={`${id}-form`} onClick={() => setOpen(true)}>{COPY.trigger}</button>}
      {open && (
        <form id={`${id}-form`} className="hfy-grad__form" onSubmit={submit} onKeyDown={(e) => { if (e.key === "Escape" && !busy) { e.preventDefault(); close(); } }} data-hfy-grad-form noValidate>
          <PagePicker value={person} onChange={setPerson} disabled={busy} inputRef={picker} />
          <div className="hfy-grad__field">
            <label htmlFor={titleId}>{COPY.title}</label>
            <input id={titleId} className="hfy-grad__input" type="text" value={title} disabled={busy} aria-invalid={titleBad ? "true" : undefined} aria-describedby={titleBad ? `${titleId}-err` : undefined} onChange={(e) => setTitle(e.target.value)} />
            {titleBad && <p className="hfy-grad__error" id={`${titleId}-err`} role="alert" data-hfy-grad-error>{error.text}</p>}
          </div>
          {error && !titleBad && <p className="hfy-grad__error" role="alert" data-hfy-grad-error>{error.text}</p>}
          <div className="hfy-grad__actions">
            <button type="submit" className="hfy-btn hfy-btn--primary" disabled={busy}>{busy ? COPY.adding : COPY.add}</button>
            <button type="button" className="hfy-btn" disabled={busy} onClick={() => close()}>{COPY.cancel}</button>
          </div>
        </form>
      )}
    </div>
  );
}

export { PersonName };
