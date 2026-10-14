// The relationship wizard's parts (HFY-TSK-158; editing.md section 8.3): the choice target, the person search, the "not on the site yet" form,
// the year and place questions, the sentence lines. Every part is one thing on one screen: the choice targets are 56 px tall (data-hfy-choice),
// the inputs are 16 px (the theme's --io-control-input-min-font), and a person's name in a sentence is the shared PersonName link (P2-R46).
// The screens that use them are in islands/family.jsx.
import { useEffect, useId, useRef, useState } from "react";
import { PersonName } from "./person-name.jsx";
import { EDIT_GUARD_COPY, editGuard } from "./edit-guard.js";
import { COPY, refWho, validateStubForm } from "./wizard-model.js";

/** A choice: a big button that does one thing. `pressed` marks a chosen one (never by colour alone: the check mark). */
export function Choice({ children, onClick, pressed, disabled, hint, ...rest }) {
  return (
    <button type="button" className="hfy-wiz__choice" data-hfy-choice aria-pressed={pressed === undefined ? undefined : pressed} disabled={disabled} onClick={onClick} {...rest}>
      <span className="hfy-wiz__choice-text">{children}</span>
      {hint ? <span className="hfy-wiz__choice-hint">{hint}</span> : null}
    </button>
  );
}

/** A plain button (back, undo, continue, send): the same 56 px target. */
export function Action({ children, onClick, primary, disabled, type = "button", ...rest }) {
  return (
    <button type={type} className={`hfy-wiz__action${primary ? " hfy-wiz__action--primary" : ""}`} data-hfy-action disabled={disabled} onClick={onClick} {...rest}>
      {children}
    </button>
  );
}

/** "more choices": the main choices, then the rare ones behind a button. */
export function ChoiceList({ main, more, value, onPick, label }) {
  const [open, setOpen] = useState(false);
  const shown = open ? [...main, ...more] : main;
  return (
    <div className="hfy-wiz__choices" role="group" aria-label={label}>
      {shown.map((c) => <Choice key={c.value} onClick={() => onPick(c.value)} pressed={value === undefined ? undefined : value === c.value} data-hfy-value={c.value}>{c.label}</Choice>)}
      {more && more.length > 0 && (
        <Action onClick={() => setOpen(!open)} aria-expanded={open} data-hfy-more>{open ? COPY.fewer : COPY.more}</Action>
      )}
    </div>
  );
}

/** One sentence: text parts and person names (links when the person has a page). */
export function Sentence({ parts }) {
  return (
    <>
      {parts.map((p, i) => (p.text !== undefined ? <span key={i}>{p.text}</span> : <PersonName key={i} id={p.id || undefined} name={p.name} />))}
    </>
  );
}

// ---- the person search ------------------------------------------------------------------------------------------------------------

/**
 * Search the family for someone who is already on the site, or choose "not on the site yet". A row is a big button; picking one asks the records
 * API for the person's handle (the intent names handles) and calls `onPick(who)`. `skip` lists Gramps ids not to offer (the member's own, people already chosen).
 */
export function PersonPicker({ onPick, onNew, newLabel, resolve, skip = [], search }) {
  const inputId = useId();
  const helpId = useId();
  const [q, setQ] = useState("");
  const [rows, setRows] = useState([]);
  const [status, setStatus] = useState("idle"); // idle | loading | ready | failed
  const [busy, setBusy] = useState(null);
  const [problem, setProblem] = useState("");
  const seq = useRef(0);
  const live = useRef(true);
  useEffect(() => { live.current = true; return () => { live.current = false; }; }, []);

  useEffect(() => {
    const text = q.trim();
    if (text.length < 2) { setRows([]); setStatus("idle"); return undefined; }
    const mine = ++seq.current;
    setStatus("loading");
    const timer = setTimeout(async () => {
      try {
        const found = await (search || (async (x) => (await import("./people-corpus.js")).findPeople(x)))(text);
        if (mine !== seq.current || !live.current) return;
        setRows(found.filter((r) => !skip.includes(r.id)));
        setStatus("ready");
      } catch {
        if (mine !== seq.current || !live.current) return;
        setRows([]);
        setStatus("failed");
      }
    }, 200);
    return () => clearTimeout(timer);
  }, [q, skip.join("|"), search]); // eslint-disable-line react-hooks/exhaustive-deps

  const pick = async (row) => {
    setBusy(row.id);
    setProblem("");
    try {
      const r = await resolve(row.id);
      if (!live.current) return;
      if (!r) { setProblem(COPY.searchNone); setBusy(null); return; }
      setBusy(null);
      onPick(refWho({ handle: r.handle, gid: r.gid || row.id, name: row.title || r.name, lifespan: row.lifespan }));
    } catch {
      if (live.current) { setProblem(COPY.loadFailed); setBusy(null); }
    }
  };

  return (
    <div className="hfy-wiz__picker" data-hfy-picker>
      <div className="hfy-wiz__field">
        <label className="hfy-wiz__label" htmlFor={inputId}>{COPY.search}</label>
        <input id={inputId} className="hfy-wiz__input" type="search" autoComplete="off" autoCapitalize="words" spellCheck={false} maxLength={80}
          value={q} onChange={(e) => setQ(e.target.value)} aria-describedby={helpId} data-hfy-search />
        <p className="hfy-wiz__hint" id={helpId}>{COPY.searchHelp}</p>
      </div>
      <div className="hfy-wiz__results" role="region" aria-label={COPY.search} aria-live="polite">
        {status === "loading" && <p className="hfy-wiz__hint" role="status">{COPY.searchLoading}</p>}
        {status === "failed" && <p className="hfy-wiz__hint" role="status">{COPY.searchFailed}</p>}
        {status === "ready" && rows.length === 0 && <p className="hfy-wiz__hint" role="status" data-hfy-none>{COPY.searchNone}</p>}
        {problem && <p className="hfy-wiz__problem" role="alert">{problem}</p>}
        {rows.length > 0 && (
          <ul className="hfy-wiz__rows" data-hfy-results>
            {rows.map((r) => (
              <li key={r.id}>
                <button type="button" className="hfy-wiz__choice hfy-wiz__person" data-hfy-choice data-hfy-person={r.id} disabled={busy !== null} onClick={() => pick(r)}>
                  {r.photo ? <img className="hfy-wiz__photo" src={r.photo} alt="" width="40" height="40" loading="lazy" /> : <span className="hfy-wiz__photo hfy-wiz__photo--none" aria-hidden="true">{(r.title || "").trim().charAt(0)}</span>}
                  <span className="hfy-wiz__person-text">
                    <span className="hfy-wiz__person-name">{r.title}</span>
                    {r.lifespan ? <span className="hfy-wiz__choice-hint">{r.lifespan}</span> : null}
                  </span>
                </button>
              </li>
            ))}
          </ul>
        )}
      </div>
      <Choice onClick={onNew} data-hfy-new>{newLabel || COPY.notOnSite}</Choice>
    </div>
  );
}

// ---- "not on the site yet" -------------------------------------------------------------------------------------------------------

/** What the edit guard (R-18/R-19) finds in the names: the words for each kind, once each. Never the matched text. */
export function guardMessages(values) {
  const found = editGuard.checkValue(values, "stub");
  return [...new Set(found.map((f) => EDIT_GUARD_COPY[f.code]).filter(Boolean))];
}

/** The short form for someone who is not on the site yet. `onSubmit(form)` is called with a valid form (see validateStubForm). */
export function NewPersonForm({ gender, nowYear, onSubmit, initial, surnameLabel }) {
  const id = useId();
  const [f, setF] = useState(() => ({ given: "", surname: "", birthYear: "", living: "unknown", deathYear: "", ...(initial || {}) }));
  const [errors, setErrors] = useState({});
  const set = (k) => (e) => setF({ ...f, [k]: e.target.value });
  const blocked = guardMessages({ given: f.given, surname: f.surname });
  const submit = (e) => {
    e.preventDefault();
    if (blocked.length) return;
    const v = validateStubForm({ ...f, gender }, { nowYear });
    setErrors(v.errors);
    if (!v.ok) {
      const first = Object.keys(v.errors)[0];
      const el = document.getElementById(`${id}-${first}`);
      if (el) el.focus();
      return;
    }
    onSubmit({ ...f, gender });
  };
  const err = (k) => (errors[k] ? <p className="hfy-wiz__problem" id={`${id}-${k}-err`} role="alert">{errors[k]}</p> : null);
  const invalid = (k) => (errors[k] ? { "aria-invalid": true, "aria-describedby": `${id}-${k}-err` } : {});
  return (
    <form className="hfy-wiz__form" onSubmit={submit} noValidate data-hfy-new-form>
      <div className="hfy-wiz__field">
        <label className="hfy-wiz__label" htmlFor={`${id}-given`}>{COPY.newGiven}</label>
        <input id={`${id}-given`} className="hfy-wiz__input" type="text" autoComplete="off" maxLength={120} value={f.given} onChange={set("given")} data-hfy-given {...invalid("given")} />
        {err("given")}
      </div>
      <div className="hfy-wiz__field">
        <label className="hfy-wiz__label" htmlFor={`${id}-surname`}>{surnameLabel || COPY.newSurname}</label>
        <input id={`${id}-surname`} className="hfy-wiz__input" type="text" autoComplete="off" maxLength={120} value={f.surname} onChange={set("surname")} data-hfy-surname {...invalid("surname")} />
        {err("surname")}
      </div>
      {blocked.map((m) => <p key={m} className="hfy-wiz__problem" role="alert" data-hfy-guard>{m}</p>)}
      <div className="hfy-wiz__field">
        <label className="hfy-wiz__label" htmlFor={`${id}-birthYear`}>{COPY.newBirthYear}</label>
        <input id={`${id}-birthYear`} className="hfy-wiz__input" type="text" inputMode="numeric" autoComplete="off" maxLength={4} value={f.birthYear} onChange={set("birthYear")} data-hfy-birth-year {...invalid("birthYear")} />
        <p className="hfy-wiz__hint">{COPY.yearHelp}</p>
        {err("birthYear")}
      </div>
      <fieldset className="hfy-wiz__fieldset">
        <legend className="hfy-wiz__label">{COPY.newLiving}</legend>
        {[["yes", COPY.livingYes], ["no", COPY.livingNo], ["unknown", COPY.livingUnknown]].map(([v, label]) => (
          <label key={v} className="hfy-wiz__radio" data-hfy-choice>
            <input type="radio" name={`${id}-living`} value={v} checked={f.living === v} onChange={() => setF({ ...f, living: v })} data-hfy-living={v} />
            <span>{label}</span>
          </label>
        ))}
      </fieldset>
      {f.living === "no" && (
        <div className="hfy-wiz__field">
          <label className="hfy-wiz__label" htmlFor={`${id}-deathYear`}>{COPY.newDeathYear}</label>
          <input id={`${id}-deathYear`} className="hfy-wiz__input" type="text" inputMode="numeric" autoComplete="off" maxLength={4} value={f.deathYear} onChange={set("deathYear")} data-hfy-death-year {...invalid("deathYear")} />
          <p className="hfy-wiz__hint">{COPY.yearHelp}</p>
          {err("deathYear")}
        </div>
      )}
      <Action type="submit" primary disabled={blocked.length > 0} data-hfy-continue>{COPY.continue}</Action>
    </form>
  );
}

// ---- a year, and a place ---------------------------------------------------------------------------------------------------------

/** "What year did you marry?": a four-digit year, "about this year", and "skip this". `onSubmit({ year, about })`; `year` is null when skipped. */
export function YearForm({ label, help, aboutLabel, nowYear, onSubmit, onSkip, allowAbout = true }) {
  const id = useId();
  const [text, setText] = useState("");
  const [about, setAbout] = useState(false);
  const [error, setError] = useState("");
  const submit = (e) => {
    e.preventDefault();
    const t = text.trim();
    if (!t) { onSkip(); return; }
    if (!/^\d{4}$/.test(t) || Number(t) < 1000) { setError(COPY.badYear); return; }
    if (Number(t) > nowYear) { setError(COPY.futureYear); return; }
    onSubmit({ year: Number(t), about });
  };
  return (
    <form className="hfy-wiz__form" onSubmit={submit} noValidate data-hfy-year-form>
      <div className="hfy-wiz__field">
        <label className="hfy-wiz__label" htmlFor={id}>{label}</label>
        <input id={id} className="hfy-wiz__input" type="text" inputMode="numeric" autoComplete="off" maxLength={4} value={text} onChange={(e) => { setText(e.target.value); setError(""); }}
          aria-describedby={`${id}-help`} {...(error ? { "aria-invalid": true } : {})} data-hfy-year />
        <p className="hfy-wiz__hint" id={`${id}-help`}>{help || COPY.yearHelp}</p>
        {error && <p className="hfy-wiz__problem" role="alert">{error}</p>}
      </div>
      {allowAbout && (
        <label className="hfy-wiz__radio" data-hfy-choice>
          <input type="checkbox" checked={about} onChange={(e) => setAbout(e.target.checked)} data-hfy-about />
          <span>{aboutLabel || COPY.sAbout}</span>
        </label>
      )}
      <Action type="submit" primary data-hfy-continue>{text.trim() ? COPY.continue : COPY.skip}</Action>
    </form>
  );
}

/** "Where did you marry?": the places the site already has for the member, or one typed in (a town or city). `onPick(place | null)`. */
export function PlaceStep({ places, onPick }) {
  const id = useId();
  const [typing, setTyping] = useState(false);
  const [name, setName] = useState("");
  const guard = guardMessages({ name });
  const submit = (e) => {
    e.preventDefault();
    const clean = name.replace(/\s+/g, " ").trim();
    if (!clean || clean.length > 100 || guard.length) return;
    onPick({ name: clean });
  };
  return (
    <div className="hfy-wiz__choices" data-hfy-places>
      {places.map((p) => <Choice key={p.ref} onClick={() => onPick({ ref: p.ref, name: p.name })} data-hfy-place={p.ref}>{p.name}</Choice>)}
      {!typing && <Choice onClick={() => setTyping(true)} data-hfy-place-other>{COPY.sPlaceNone}</Choice>}
      {typing && (
        <form className="hfy-wiz__form" onSubmit={submit} noValidate>
          <div className="hfy-wiz__field">
            <label className="hfy-wiz__label" htmlFor={id}>{COPY.sPlaceName}</label>
            <input id={id} className="hfy-wiz__input" type="text" autoComplete="off" maxLength={100} value={name} onChange={(e) => setName(e.target.value)} data-hfy-place-name />
          </div>
          {guard.map((m) => <p key={m} className="hfy-wiz__problem" role="alert" data-hfy-guard>{m}</p>)}
          <Action type="submit" primary disabled={!name.trim() || guard.length > 0} data-hfy-continue>{COPY.continue}</Action>
        </form>
      )}
      <Action onClick={() => onPick(null)} data-hfy-skip>{COPY.skip}</Action>
    </div>
  );
}
