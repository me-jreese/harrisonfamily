// The person editor's host widgets (HFY-TSK-156; editing.md section 9.1 "Forms", kit @io-kit/schema_form 0.4.0 host-registered widget ids).
//   givenNames   one input for the given names, with read-only "first" and "middle" read from it (the record keeps one string)
//   callName     the name you go by: a choice among the given-name tokens only
//   grampsDate   a year, then optional month and day (never for a birth), with about / before / after / between and estimated
//   personRef    a person from the family index (suggestPeople): picked from the list, never typed free
//   placeRef     a place the bundle holds, or "not listed", which goes to review as a new place
//   sourceRef    the same for a source
// A widget owns the whole value at its pointer. It reads its sibling values and the lookups through FormCtx, which the form's host provides.
// Markup follows the kit's own (`.io-field`, `.io-label-row`, `.io-adornment`), so the editor's form CSS styles them; the words are lowercase.
import { createContext, useContext, useEffect, useRef, useState } from "react";
import { RECORD_COPY } from "./editor-records.js";
import { SECTION_COPY, MONTHS, MODIFIER, dateFromParts, dateParts, dateText, givenParts, givenTokens, isBirthCode, isWordsDate } from "./editor-sections.js";

/** What a widget reads besides its own value: { live (the form's values now), initial, viewer, lookups, searchPeople, resolvePerson }. */
export const FormCtx = createContext({ live: {}, initial: {}, viewer: {}, lookups: { places: [], sources: [], placeNames: new Map() }, searchPeople: async () => [], resolvePerson: async () => null });
export const useFormCtx = () => useContext(FormCtx);

const descId = (p) => `${p.id}-desc`;
const errId = (p) => `${p.id}-err`;

/** The a11y attributes every text-like control shares (the kit's controlProps). */
function controlProps(p, extra = {}) {
  const hasErr = p.errors.length > 0;
  const described = [p.description ? descId(p) : "", hasErr ? errId(p) : "", extra.describedBy || ""].filter(Boolean).join(" ");
  return {
    id: p.id, name: p.path, "aria-describedby": described || undefined, "aria-invalid": hasErr || undefined, "aria-required": p.required || undefined,
    disabled: p.readOnly || undefined, onBlur: p.onBlur
  };
}

function Errors({ p }) {
  return p.errors.length ? <p id={errId(p)} className="io-error" role="alert">{p.errors.join(" ")}</p> : null;
}

/** A single-control field: label (with the adornment), description, the control, errors. */
function Field({ p, children, never = null }) {
  return (
    <div className="io-field" id={`${p.id}-field`} data-pointer={p.path} data-widget={p.node.widget}>
      {p.adornment
        ? <div className="io-label-row"><label htmlFor={p.id}>{p.label}</label><span className="io-adornment">{p.adornment}</span></div>
        : <label htmlFor={p.id}>{p.label}</label>}
      {p.description ? <p id={descId(p)} className="io-description">{p.description}</p> : null}
      {children}
      {never}
      <Errors p={p} />
    </div>
  );
}

/** A group field: fieldset and legend, for a widget with several controls. */
function Group({ p, children, never = null, extra = {} }) {
  return (
    <fieldset className="io-field" id={p.id} data-pointer={p.path} data-widget={p.node.widget} tabIndex={-1} aria-describedby={[p.description ? descId(p) : "", p.errors.length ? errId(p) : ""].filter(Boolean).join(" ") || undefined} {...extra}>
      <legend>{p.label}{p.adornment ? <span className="io-adornment">{p.adornment}</span> : null}</legend>
      {p.description ? <p id={descId(p)} className="io-description">{p.description}</p> : null}
      {children}
      {never}
      <Errors p={p} />
    </fieldset>
  );
}

const asText = (v) => (typeof v === "string" ? v : "");

// ---- given names and the call name ---------------------------------------------------------------------------------------------------

/** One input for every given name; "first" and "middle" are read-only and read from it (the record holds one string, never two fields). */
export function GivenNames(p) {
  const parts = givenParts(p.value);
  return (
    <Field p={p}>
      <input {...controlProps(p, { describedBy: `${p.id}-parts` })} type="text" autoComplete="off" value={asText(p.value)} onChange={(e) => p.onChange(e.target.value === "" ? undefined : e.target.value)} />
      <p className="hfy-given" id={`${p.id}-parts`} data-hfy-given>
        <span className="hfy-given__part" data-hfy-given-part="first">{SECTION_COPY.first} <strong data-hfy-given-first>{parts.first || "-"}</strong></span>
        <span className="hfy-given__part" data-hfy-given-part="middle">{SECTION_COPY.middle} <strong data-hfy-given-middle>{parts.middle || "-"}</strong></span>
      </p>
    </Field>
  );
}

/** The name you go by: only the given names offered, and it follows them (a name taken out of the given names is cleared). */
export function CallName(p) {
  const { live, initial } = useFormCtx();
  const tokens = givenTokens(live.first_name);
  const value = asText(p.value);
  const stale = value !== "" && !tokens.includes(value);
  const edited = asText(live.first_name) !== asText(initial.first_name);
  const { onChange } = p;
  // A call name that is no longer one of the given names the member has just changed is cleared with them; a stored one is left as it is.
  useEffect(() => { if (stale && edited) onChange(undefined); }, [stale, edited, onChange]);
  return (
    <Field p={p}>
      <select {...controlProps(p)} value={stale ? "" : value} onChange={(e) => p.onChange(e.target.value === "" ? undefined : e.target.value)} data-hfy-call>
        <option value="">{SECTION_COPY.callNone}</option>
        {tokens.map((t) => <option key={t} value={t}>{t}</option>)}
      </select>
      <p className="io-description">{SECTION_COPY.callHint}</p>
    </Field>
  );
}

// ---- dates ---------------------------------------------------------------------------------------------------------------------------

const numberOf = (text, max) => {
  const n = Number.parseInt(String(text).replace(/\D/g, "").slice(0, 4), 10);
  return Number.isInteger(n) && n > 0 && n <= max ? n : 0;
};
const MODS = [
  [MODIFIER.NONE, "modExact"], [MODIFIER.ABOUT, "modAbout"], [MODIFIER.BEFORE, "modBefore"], [MODIFIER.AFTER, "modAfter"], [MODIFIER.RANGE, "modBetween"]
];

/**
 * A date: kind (exactly, about, before, after, between), year, and for anything but a birth a month and a day, and an "estimated" box.
 * A birth shows the kind and the year only, with the line that says why (DEC-E4); "between" adds the end year.
 */
export function GrampsDate(p) {
  const { live } = useFormCtx();
  const birth = isBirthCode(live.type);
  const parts = dateParts(p.value);
  // A date kept as text, or as a from-to span, has no parts to edit: it is shown as it is, so changing nothing can never drop its words.
  if (isWordsDate(p.value)) {
    return (
      <Group p={p} extra={{ "data-hfy-date": "words" }}>
        {!birth && <p className="hfy-date__words" data-hfy-date-words>{dateText(p.value)}</p>}
        <p className="io-description">{SECTION_COPY.dateWords}</p>
      </Group>
    );
  }
  const between = parts.modifier === MODIFIER.RANGE;
  const set = (patch) => p.onChange(dateFromParts({ ...parts, ...patch }, p.value ?? null, { birth }));
  const id = (s) => `${p.id}-${s}`;
  const dis = p.readOnly || undefined;
  const never = birth ? <p className="io-description" data-hfy-never="birth-date">{SECTION_COPY.birthYearOnly}</p> : null;
  const month = (field, value) => (
    <div className="hfy-date__cell">
      <label htmlFor={id(field)}>{SECTION_COPY.dateMonth}</label>
      <select id={id(field)} disabled={dis} value={value ? String(value) : ""} onChange={(e) => set({ [field]: Number(e.target.value) || 0 })}>
        <option value="">{SECTION_COPY.monthNone}</option>
        {MONTHS.map((m, i) => <option key={m} value={String(i + 1)}>{m}</option>)}
      </select>
    </div>
  );
  const day = (field, value) => (
    <div className="hfy-date__cell hfy-date__cell--narrow">
      <label htmlFor={id(field)}>{SECTION_COPY.dateDay}</label>
      <input id={id(field)} type="text" inputMode="numeric" autoComplete="off" maxLength={2} disabled={dis} value={value ? String(value) : ""} onChange={(e) => set({ [field]: numberOf(e.target.value, 31) })} />
    </div>
  );
  const year = (field, value, label) => (
    <div className="hfy-date__cell hfy-date__cell--narrow">
      <label htmlFor={id(field)}>{label}</label>
      <input id={id(field)} type="text" inputMode="numeric" autoComplete="off" maxLength={4} disabled={dis} value={value ? String(value) : ""} onChange={(e) => set({ [field]: numberOf(e.target.value, 9999) })} />
    </div>
  );
  return (
    <Group p={p} never={never} extra={{ "data-hfy-date": birth ? "birth" : "date" }}>
      <div className="hfy-date">
        <div className="hfy-date__cell">
          <label htmlFor={id("modifier")}>{SECTION_COPY.dateKind}</label>
          <select id={id("modifier")} disabled={dis} value={String(parts.modifier === 5 ? 0 : parts.modifier)} onChange={(e) => set({ modifier: Number(e.target.value) })}>
            {MODS.map(([v, k]) => <option key={v} value={String(v)}>{SECTION_COPY[k]}</option>)}
          </select>
        </div>
        {year("year", parts.year, SECTION_COPY.dateYear)}
        {!birth && month("month", parts.month)}
        {!birth && day("day", parts.day)}
        {between && year("year2", parts.year2, SECTION_COPY.dateEndYear)}
        {between && !birth && month("month2", parts.month2)}
        {between && !birth && day("day2", parts.day2)}
      </div>
      {!birth && (
        <label className="hfy-check" htmlFor={id("estimated")}>
          <input id={id("estimated")} type="checkbox" disabled={dis} checked={parts.quality === 1} onChange={(e) => set({ quality: e.target.checked ? 1 : 0 })} />
          <span>{SECTION_COPY.dateEstimated}</span>
        </label>
      )}
    </Group>
  );
}

// ---- a person from the family index --------------------------------------------------------------------------------------------------------

/**
 * A person picked from the family index. The box searches as you type; only a person picked from the list is a value (free text is never one),
 * and picking asks the records API for the person's handle, which the ops need. The value is `{ id, name, handle }`.
 */
export function PersonRef(p) {
  const { searchPeople, resolvePerson, lookups } = useFormCtx();
  const [query, setQuery] = useState("");
  const [results, setResults] = useState([]);
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(-1);
  const [status, setStatus] = useState("idle");
  const seq = useRef(0);
  const pick = useRef(0); // the latest pick wins: an earlier resolve that lands late is dropped
  const picked = p.value && typeof p.value === "object" && p.value.handle ? p.value : null;
  const listId = `${p.id}-list`;
  const run = async (q) => {
    const n = (seq.current += 1);
    setStatus("loading");
    try {
      const r = await searchPeople(q);
      if (n !== seq.current) return;
      // This page's own person is never offered (a person is not connected to themselves).
      const shown = r.filter((o) => !lookups.selfId || o.id !== lookups.selfId);
      setResults(shown);
      setActive(shown.length ? 0 : -1);
      setStatus("idle");
    } catch {
      if (n === seq.current) setStatus("error");
    }
  };
  const choose = async (opt) => {
    const n = (pick.current += 1);
    setOpen(false);
    setStatus("resolving");
    try {
      const found = await resolvePerson(opt.id);
      if (n !== pick.current) return;
      if (!found || !found.handle) throw new Error("no handle");
      if (found.handle === lookups.selfHandle || opt.id === lookups.selfId) { setStatus("self"); return; }
      if (lookups.connected && lookups.connected.has(found.handle)) { setStatus("already"); return; }
      p.onChange({ id: opt.id, name: opt.label, handle: found.handle });
      setQuery("");
      setResults([]);
      setStatus("idle");
    } catch {
      if (n === pick.current) setStatus("failed");
    }
  };
  const onKey = (e) => {
    if (e.key === "ArrowDown") { e.preventDefault(); setOpen(true); setActive((a) => Math.min(results.length - 1, a + 1)); }
    else if (e.key === "ArrowUp") { e.preventDefault(); setActive((a) => Math.max(0, a - 1)); }
    else if (e.key === "Escape") setOpen(false);
    else if (e.key === "Enter") { e.preventDefault(); if (open && results[active]) choose(results[active]); }
  };
  const note = status === "failed" ? SECTION_COPY.personResolveFailed : status === "self" ? SECTION_COPY.personSelf : status === "already" ? SECTION_COPY.personAlready : status === "error" ? SECTION_COPY.personNoMatch : "";
  if (picked) {
    return (
      <Field p={p}>
        <p className="hfy-ref__picked" data-hfy-person-picked>
          <span>{SECTION_COPY.personPicked} <strong>{picked.name}</strong></span>
          <button type="button" id={p.id} disabled={p.readOnly || undefined} onClick={() => p.onChange(undefined)}>{SECTION_COPY.personRemove}</button>
        </p>
      </Field>
    );
  }
  return (
    <Field p={p}>
      <input
        {...controlProps(p, { describedBy: `${p.id}-hint` })} type="text" role="combobox" autoComplete="off" aria-autocomplete="list" aria-expanded={open && results.length > 0}
        aria-controls={listId} aria-activedescendant={open && active >= 0 ? `${p.id}-opt-${active}` : undefined} value={query}
        onChange={(e) => { setQuery(e.target.value); setOpen(true); run(e.target.value); }} onKeyDown={onKey} onFocus={() => { if (query) run(query); }}
      />
      <p className="io-description" id={`${p.id}-hint`} data-hfy-person-hint>{SECTION_COPY.personPick}</p>
      <ul id={listId} role="listbox" aria-label={p.label} className="hfy-ref__list" hidden={!(open && results.length > 0)}>
        {results.map((o, i) => (
          <li key={o.id} id={`${p.id}-opt-${i}`} role="option" aria-selected={i === active} onMouseDown={(e) => { e.preventDefault(); choose(o); }}>
            {o.label}{o.status ? ` (${o.status})` : ""}
          </li>
        ))}
      </ul>
      <p className="io-sr" role="status" aria-live="polite">{status === "loading" || status === "resolving" ? SECTION_COPY.personSearching : note}</p>
    </Field>
  );
}

// ---- a place or a source the bundle holds -----------------------------------------------------------------------------------------------------

const NEW = "__new";

function PickOrNew({ p, items, none, notListed, newLabel, newHint, kind }) {
  const value = p.value && typeof p.value === "object" ? p.value : { ref: "", name: "" };
  const [mode, setMode] = useState(value.name ? "new" : "pick");
  const known = items.some((i) => i.ref === value.ref);
  const selected = mode === "new" ? NEW : value.ref;
  const nameId = `${p.id}-new`;
  return (
    <Field p={p}>
      <select {...controlProps(p)} value={selected} onChange={(e) => {
        // "not listed" keeps the place already chosen until a name is typed: choosing it alone changes nothing.
        if (e.target.value === NEW) { setMode("new"); p.onChange({ ref: value.ref, name: value.name || "" }); } else { setMode("pick"); p.onChange({ ref: e.target.value, name: "" }); }
      }} data-hfy-ref={kind}>
        <option value="">{none}</option>
        {value.ref && !known ? <option value={value.ref}>{kind === "place" ? "current place" : "current source"}</option> : null}
        {items.map((i) => <option key={i.ref} value={i.ref}>{i.name}</option>)}
        <option value={NEW}>{notListed}</option>
      </select>
      {mode === "new" && (
        <div className="hfy-ref__new">
          <label htmlFor={nameId}>{newLabel}</label>
          <input id={nameId} type="text" autoComplete="off" maxLength={200} disabled={p.readOnly || undefined} value={value.name || ""} aria-describedby={`${nameId}-hint`} onChange={(e) => p.onChange({ ref: "", name: e.target.value })} data-hfy-new={kind} />
          <p className="io-description" id={`${nameId}-hint`} data-hfy-review-route={kind}>{newHint}</p>
        </div>
      )}
    </Field>
  );
}

/** A place from the places the bundle holds, or "not listed" with a name, which creates a new place and goes to review. Value `{ ref, name }`. */
export function PlaceRef(p) {
  const { lookups } = useFormCtx();
  return <PickOrNew p={p} kind="place" items={lookups.places} none={SECTION_COPY.placeNone} notListed={SECTION_COPY.placeNotListed} newLabel={SECTION_COPY.placeNewLabel} newHint={SECTION_COPY.placeNewHint} />;
}

/** A source from the sources the bundle holds, or "not listed" with a title. Value `{ ref, name }`. */
export function SourceRef(p) {
  const { lookups } = useFormCtx();
  return <PickOrNew p={p} kind="source" items={lookups.sources} none={SECTION_COPY.sourceNone} notListed={SECTION_COPY.sourceNotListed} newLabel={SECTION_COPY.sourceNewLabel} newHint={SECTION_COPY.sourceNewHint} />;
}

// ---- tags -----------------------------------------------------------------------------------------------------------------------------

/** Tags from the ones that already exist: a checkbox for each, never a typed new one. Value: the array of tag handles. */
export function TagPick(p) {
  const { lookups } = useFormCtx();
  const have = Array.isArray(p.value) ? p.value.filter((t) => typeof t === "string") : [];
  const items = lookups.tags || [];
  const known = new Set(items.map((t) => t.handle));
  const shown = [...items, ...have.filter((h) => !known.has(h)).map((h) => ({ handle: h, name: "a tag" }))];
  const flip = (handle) => p.onChange(have.includes(handle) ? have.filter((h) => h !== handle) : [...have, handle]);
  return (
    <Group p={p} extra={{ "data-hfy-tags": "" }}>
      <p className="io-description" data-hfy-tags-hint>{shown.length ? RECORD_COPY.tagsHint : RECORD_COPY.tagsNone}</p>
      <ul className="hfy-tags">
        {shown.map((t) => (
          <li key={t.handle}>
            <label className="hfy-tags__item">
              <input type="checkbox" checked={have.includes(t.handle)} disabled={p.readOnly || undefined} onChange={() => flip(t.handle)} data-hfy-tag={t.handle} />
              <span>{t.name}</span>
            </label>
          </li>
        ))}
      </ul>
    </Group>
  );
}

/** The registry handed to SchemaForm `widgets`. */
export const EDITOR_WIDGETS = Object.freeze({ tagPick: TagPick, givenNames: GivenNames, callName: CallName, grampsDate: GrampsDate, personRef: PersonRef, placeRef: PlaceRef, sourceRef: SourceRef });
