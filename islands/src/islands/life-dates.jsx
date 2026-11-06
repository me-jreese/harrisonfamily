// Life dates on the person page (HFY-TSK-388-0D, flag lifeDatesV1; BRD 5.7, D-17..D-28; board B5). LifeDatesLine is one plain line under the
// name; LifeDatesEditor opens in place with Born and Died rows. Both are HFY app islands, not kit packages. Saves go through
// POST /api/life-dates under an Idempotency-Key and are always proposals (D-24), so after a save the sender sees "pending review" and
// everyone else keeps the old line. Signed out, the line is all there is. The page rebuilds its hero on every render, so the block is put
// back after the lifespan line on each hfy:person-rendered.
import "./life-dates.css";
import { useEffect, useId, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import { api } from "../lib/api.js";
import { getMe } from "../lib/me.js";
import { newIdempotencyKey } from "../lib/editor-save.js";
import { editHref } from "../lib/editor-model.js";
import { COPY, buildBody, draftFrom, errorText, lineText, readLife, readReply, sureText, validate, withPending } from "../lib/life-dates-model.js";

const pendingKey = (id) => `hfy:lifedates:pending:${id}`;
function loadPending(id) {
  try { return JSON.parse(sessionStorage.getItem(pendingKey(id)) || "null"); } catch { return null; }
}
function savePending(id, value) {
  try { sessionStorage.setItem(pendingKey(id), JSON.stringify(value)); } catch { /* the line still shows it for this view */ }
}

export function LifeDatesLine({ shown, pending, children }) {
  return (
    <div className="hfy-ld__lines">
      <p className="hfy-ld__line" data-ld="line">{lineText(shown)}</p>
      {pending && <span className="hfy-ld__pend" data-ld="pending">{COPY.pending}</span>}
      {children}
    </div>
  );
}

function Row({ name, label, draft, setDraft, current, error, inputRef }) {
  const id = useId();
  const isDied = name === "death";
  const row = draft[name];
  const precise = Boolean(current && current.precise);
  const unknown = isDied && row.unknown;
  const errId = `${id}-err`;
  const set = (patch) => setDraft({ ...draft, [name]: { ...row, ...patch } });
  return (
    <div className="hfy-ld__row" role="group" aria-label={label}>
      <span className="hfy-ld__rowname" aria-hidden="true">{label}</span>
      {precise ? (
        <div className="hfy-ld__ro">
          <span className="hfy-ld__yr hfy-ld__yr--ro" data-ld={`${name}-ro`}>{current.year}</span>
          <span className="hfy-ld__note">{COPY.preciseNote}</span>
          <a className="hfy-ld__link" href={editHref("Person", draft.__id)}>{COPY.suggest}</a>
        </div>
      ) : (
        <>
          <div className="hfy-ld__inputs">
            <input ref={inputRef} className={`hfy-ld__yr${error ? " hfy-ld__yr--err" : ""}`} type="text" inputMode="numeric" autoComplete="off" maxLength={4} pattern="[0-9]*"
              aria-label={isDied ? COPY.yearDied : COPY.yearBorn} aria-invalid={error ? "true" : undefined} aria-describedby={error ? errId : undefined}
              disabled={unknown} value={unknown ? "" : row.year} onChange={(e) => set({ year: e.target.value.replace(/[^0-9]/g, "") })} data-ld={`${name}-year`} />
            <label className="hfy-ld__check">
              <input type="checkbox" role="switch" aria-label={isDied ? COPY.aboutDied : COPY.aboutBorn} disabled={unknown} checked={!unknown && row.about} onChange={(e) => set({ about: e.target.checked })} data-ld={`${name}-about`} />
              <span>{COPY.about}</span>
            </label>
          </div>
          {isDied && (
            <label className="hfy-ld__check">
              <input type="checkbox" checked={row.unknown} onChange={(e) => set({ unknown: e.target.checked })} data-ld="death-unknown" />
              <span>{COPY.unknown}</span>
            </label>
          )}
        </>
      )}
      {error && <p className="hfy-ld__err" id={errId} role="alert" data-ld={`${name}-error`}>{error}</p>}
    </div>
  );
}

export function LifeDatesEditor({ personId, current, onClose, onSaved }) {
  const [draft, setDraft] = useState(() => ({ ...draftFrom(current), __id: personId }));
  const [errors, setErrors] = useState({});
  const [sure, setSure] = useState(null); // years, when the "are you sure?" step is showing
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");
  const first = useRef(null);
  const attempt = useRef({ json: "", key: "" });
  useEffect(() => { first.current?.focus(); }, []);

  async function send(confirm) {
    const clean = { birth: draft.birth, death: draft.death };
    const v = validate(clean, current);
    setErrors(v.errors);
    setMessage("");
    if (Object.keys(v.errors).length) return;
    if (v.needsSure && !confirm) { setSure(v.years); return; }
    setBusy(true);
    try {
      const rec = await api.get(`/records/Person/by-id/${encodeURIComponent(personId)}`);
      const handle = rec && typeof rec.handle === "string" ? rec.handle : null;
      if (!handle) throw Object.assign(new Error("no handle"), { status: 500 });
      const body = buildBody(handle, clean, current, { confirm });
      if (!body) { setMessage(COPY.noChange); setBusy(false); return; }
      const json = JSON.stringify(body);
      if (attempt.current.json !== json) attempt.current = { json, key: newIdempotencyKey() };
      const res = await api.post("/life-dates", body, { headers: { "Idempotency-Key": attempt.current.key } });
      const reply = readReply(res, body);
      if (reply.confirm) { setSure(reply.years || v.years || MAX_FALLBACK); setBusy(false); return; }
      onSaved(reply);
    } catch (err) {
      setMessage(errorText(err));
      setBusy(false);
    }
  }

  return (
    <form className="hfy-ld__editor" aria-label={COPY.label} noValidate onSubmit={(e) => { e.preventDefault(); send(sure !== null); }}>
      <Row name="birth" label={COPY.born} draft={draft} setDraft={setDraft} current={current.birth} error={errors.birth} inputRef={first} />
      <Row name="death" label={COPY.died} draft={draft} setDraft={setDraft} current={current.death} error={errors.death} />
      {sure !== null && (
        <div className="hfy-ld__sure" role="group" aria-label="are you sure?">
          <p className="hfy-ld__err" role="alert" data-ld="sure">{sureText(sure)}</p>
          <button type="button" className="hfy-ld__btn hfy-ld__btn--primary" disabled={busy} onClick={() => send(true)} data-ld="sure-yes">{COPY.sureYes}</button>
          <button type="button" className="hfy-ld__btn" disabled={busy} onClick={() => setSure(null)} data-ld="sure-no">{COPY.sureNo}</button>
        </div>
      )}
      {message && <p className="hfy-ld__err" role="alert" data-ld="message">{message}</p>}
      {sure === null && (
        <div className="hfy-ld__actions">
          <button type="submit" className="hfy-ld__btn hfy-ld__btn--primary" disabled={busy} data-ld="save">{busy ? COPY.saving : COPY.save}</button>
          <button type="button" className="hfy-ld__btn" disabled={busy} onClick={onClose} data-ld="cancel">{COPY.cancel}</button>
        </div>
      )}
    </form>
  );
}
const MAX_FALLBACK = 121;

export function LifeDates({ personId, person }) {
  const [me, setMe] = useState(null);
  const [open, setOpen] = useState(false);
  const [pending, setPending] = useState(() => loadPending(personId));
  const [notes, setNotes] = useState([]);
  const btn = useRef(null);
  const back = useRef(false);
  useEffect(() => { if (!open && back.current) { back.current = false; btn.current?.focus(); } }, [open]);
  useEffect(() => { let live = true; getMe().then((m) => { if (live) setMe(m); }); return () => { live = false; }; }, []);
  const current = readLife(person);
  const shown = withPending(current, pending);
  const member = Boolean(me && me.id);
  const empty = !current.birth && !current.death;
  function close() { back.current = true; setOpen(false); }
  function saved(reply) {
    setNotes(reply.notes);
    if (Object.keys(reply.saved).length) {
      const next = { ...(pending || {}), ...reply.saved };
      setPending(next);
      savePending(personId, next);
      setNotes([COPY.pendingNote, ...reply.notes]);
    }
    close();
  }
  return (
    <section className="hfy-ld" aria-label={COPY.label} data-ld="block">
      <LifeDatesLine shown={shown} pending={Boolean(pending)}>
        {member && !open && <button ref={btn} type="button" className="hfy-ld__btn" onClick={() => { setNotes([]); setOpen(true); }} data-ld="open">{empty && !pending ? COPY.add : COPY.edit}</button>}
      </LifeDatesLine>
      {open && <LifeDatesEditor personId={personId} current={current} onClose={close} onSaved={saved} />}
      {notes.length > 0 && <div className="hfy-ld__notes" role="status" data-ld="notes">{notes.map((n) => <p key={n} className="hfy-ld__note">{n}</p>)}</div>}
    </section>
  );
}

let mounted = null; // { host, root, personId }

function fill(personId, person) {
  if (!personId || !person) return;
  const hero = document.getElementById("person-hero");
  if (!hero) return;
  let host = hero.querySelector('[data-slot="life-dates"]');
  if (!host) {
    host = document.createElement("div");
    host.setAttribute("data-slot", "life-dates");
    const anchor = hero.querySelector(".person-lifespan") || hero.querySelector("h1");
    if (anchor) anchor.insertAdjacentElement("afterend", host);
    else hero.appendChild(host);
  }
  if (!mounted || mounted.host !== host || !host.isConnected) {
    if (mounted) { try { mounted.root.unmount(); } catch { /* the old hero is gone */ } }
    mounted = { host, root: createRoot(host), personId };
  }
  mounted.root.render(<LifeDates personId={personId} person={person} />);
}

document.addEventListener("hfy:person-rendered", (e) => e.detail && fill(e.detail.personId, e.detail.person));
// The loader can run after the first render: read the person once for that case. Nothing shows if it cannot be read.
(function initial() {
  const id = new URLSearchParams(location.search).get("id");
  if (!id) return;
  setTimeout(() => {
    if (mounted) return;
    fetch(`/person/${encodeURIComponent(id)}.json`, { credentials: "same-origin" }).then((r) => (r.ok ? r.json() : null)).then((p) => { if (p && !mounted) fill(id, p); }, () => {});
  }, 0);
})();
