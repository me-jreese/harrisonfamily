// /me/links/: the profile links editor (HFY-TSK-217, flag profileLinks; HFY-PLN-002 surfaces 6.4). Seven labelled 16px inputs in the
// order facebook, instagram, snapchat, tiktok, linktree, linkedin, website; each checks on blur with the shared validator (the API's),
// then the save sends the changed fields and the API's per-field 422 shows under its input. A wrong-platform link offers "move it".
// Every field has "remove". "saved" pings after a save; a 409 reloads the latest version with a line saying so.
// The page loads this bundle only with profileLinks (feature-flags.js), so flag off the page keeps its "not available yet" note.
import "./links-editor.css";
import { useEffect, useId, useRef, useState } from "react";
import { api } from "../lib/api.js";
import { getMe } from "../lib/me.js";
import { memberSub, useEdgeSession } from "../lib/edge-session.js";
import {
  EDITOR_COPY as COPY, PLATFORMS, PLATFORM_LABEL, changesFrom, checkField, errorLine, fieldErrors, valuesFromLinks
} from "../lib/profile-links.js";
import { mountIsland } from "../lib/mount.jsx";

export const SIGN_IN_HREF = "/auth/login?returnTo=%2Fme%2Flinks%2F";
const blank = () => Object.fromEntries(PLATFORMS.map((p) => [p, ""]));

function Field({ platform, value, error, onChange, onBlur, onRemove, onMove, inputRef }) {
  const id = useId();
  const hintId = `${id}-hint`;
  const errId = `${id}-err`;
  const label = PLATFORM_LABEL[platform];
  const suggest = error && error.code === "wrong_platform" && error.suggest && PLATFORMS.includes(error.suggest) ? error.suggest : null;
  return (
    <li className="hfy-links-editor__field" data-field={platform}>
      <label className="hfy-links-editor__label" htmlFor={id}>{label}</label>
      <div className="hfy-links-editor__row">
        <input
          id={id}
          ref={inputRef}
          className="hfy-links-editor__input"
          type="text"
          inputMode="url"
          autoCapitalize="none"
          autoComplete="off"
          autoCorrect="off"
          spellCheck="false"
          value={value}
          aria-invalid={error ? "true" : undefined}
          aria-describedby={error ? `${hintId} ${errId}` : hintId}
          onChange={(e) => onChange(platform, e.target.value)}
          onBlur={() => onBlur(platform)}
        />
        {value.trim() !== "" && (
          <button type="button" className="hfy-links-editor__btn" aria-label={`remove ${label}`} onClick={() => onRemove(platform)}>{COPY.remove}</button>
        )}
      </div>
      <p className="hfy-links-editor__hint" id={hintId}>{platform === "website" ? "the link to your website" : COPY.hint}</p>
      {error && (
        <p className="hfy-links-editor__error" id={errId} data-error={error.code}>
          <span>{errorLine(error)}</span>
          {suggest && <button type="button" className="hfy-links-editor__btn hfy-links-editor__btn--move" onClick={() => onMove(platform, suggest)}>{COPY.moveIt}</button>}
        </p>
      )}
    </li>
  );
}

export function Editor({ personId }) {
  const [state, setState] = useState("loading"); // loading | ready | off | failed
  const [stored, setStored] = useState(blank());
  const [version, setVersion] = useState(0);
  const [values, setValues] = useState(blank());
  const [errors, setErrors] = useState({});
  const [note, setNote] = useState(""); // the status line under the form: saved, the conflict line, a failure
  const [busy, setBusy] = useState(false);
  const refs = useRef({});

  const adopt = (data) => {
    const v = valuesFromLinks(data.links);
    setStored(v);
    setValues(v);
    setVersion(Number.isInteger(data.version) ? data.version : 0);
    setErrors({});
  };

  useEffect(() => {
    let live = true;
    api.get(`/people/${encodeURIComponent(personId)}/links`).then(
      (data) => { if (live) { adopt(data); setState("ready"); } },
      (e) => { if (live) setState(e && e.status === 404 ? "off" : "failed"); }
    );
    return () => { live = false; };
  }, [personId]);

  const setValue = (field, text) => {
    setValues((v) => ({ ...v, [field]: text }));
    setNote("");
  };
  const onChange = (field, text) => {
    setValue(field, text);
    if (errors[field]) setErrors(({ [field]: _gone, ...rest }) => rest);
  };
  const onBlur = (field) => {
    const err = checkField(field, values[field]);
    setErrors(({ [field]: _old, ...rest }) => (err ? { ...rest, [field]: err } : rest));
  };
  const onRemove = (field) => {
    setValue(field, "");
    setErrors(({ [field]: _gone, ...rest }) => rest);
    refs.current[field]?.focus();
  };
  const onMove = (from, to) => {
    const text = values[from];
    setValues((v) => ({ ...v, [from]: "", [to]: text }));
    setNote("");
    const err = checkField(to, text);
    setErrors(({ [from]: _a, [to]: _b, ...rest }) => (err ? { ...rest, [to]: err } : rest));
    refs.current[to]?.focus();
  };

  async function save(e) {
    e.preventDefault();
    if (busy) return;
    const links = changesFrom(values, stored);
    // The fields the API would refuse are shown before the request; the API stays the authority.
    const local = {};
    for (const field of Object.keys(links)) {
      const err = links[field] === null ? null : checkField(field, links[field]);
      if (err) local[field] = err;
    }
    if (Object.keys(local).length) {
      setErrors(local);
      setNote("");
      refs.current[PLATFORMS.find((p) => local[p])]?.focus();
      return;
    }
    setBusy(true);
    setNote("");
    try {
      const data = await api.put(`/people/${encodeURIComponent(personId)}/links`, { links, version });
      adopt(data);
      setNote(COPY.saved);
    } catch (err) {
      if (err && err.status === 409) {
        const cur = err.details && err.details.current;
        if (cur && typeof cur === "object") adopt(cur);
        else {
          try { adopt(await api.get(`/people/${encodeURIComponent(personId)}/links`)); } catch { /* keep what is typed */ }
        }
        setNote(COPY.conflict);
      } else if (err && err.status === 422) {
        const byField = fieldErrors(err.fields);
        setErrors(byField);
        refs.current[PLATFORMS.find((p) => byField[p])]?.focus();
      } else if (err && err.status === 403) setNote(COPY.forbidden);
      else if (err && err.status === 401) setNote(COPY.signedOut);
      else setNote(COPY.failed);
    } finally {
      setBusy(false);
    }
  }

  if (state === "loading") return <div className="hfy-links-editor__skeleton" role="status" aria-label={COPY.loading} />;
  if (state === "off") return <p className="hfy-links-editor__note" role="status">{COPY.off}</p>;
  if (state === "failed") return <p className="hfy-links-editor__note" role="status">{COPY.loadFailed}</p>;
  return (
    <form className="hfy-links-editor__form" onSubmit={save} noValidate>
      <p className="hfy-links-editor__lede">{COPY.lede}</p>
      <ul className="hfy-links-editor__fields">
        {PLATFORMS.map((p) => (
          <Field key={p} platform={p} value={values[p]} error={errors[p]} onChange={onChange} onBlur={onBlur} onRemove={onRemove} onMove={onMove} inputRef={(el) => { refs.current[p] = el; }} />
        ))}
      </ul>
      <div className="hfy-links-editor__actions">
        <button type="submit" className="hfy-links-editor__save" disabled={busy} aria-disabled={busy}>{busy ? COPY.saving : COPY.save}</button>
        <p className="hfy-links-editor__status" role="status" data-hfy-ping={note === COPY.saved ? "saved" : undefined}>{note}</p>
      </div>
    </form>
  );
}

function SignInGate() {
  return (
    <div className="hfy-links-editor__gate" role="status" data-hfy-gate>
      <p>{COPY.signedOut}</p>
      <a className="hfy-links-editor__signin" href={SIGN_IN_HREF}>sign in</a>
    </div>
  );
}

function LinksPage() {
  const session = useEdgeSession();
  const sub = memberSub(session);
  const [personId, setPersonId] = useState(undefined); // undefined while asking, null when nobody can be named
  useEffect(() => {
    if (!sub) return undefined;
    let live = true;
    getMe().then((me) => { if (live) setPersonId(typeof me.id === "string" && me.id ? me.id : sub); });
    return () => { live = false; };
  }, [sub]);
  const pending = session === undefined || (sub && personId === undefined);
  return (
    <section className="hfy-links-editor" aria-busy={Boolean(pending)}>
      {session === undefined && <div className="hfy-links-editor__skeleton" role="status" aria-label={COPY.loading} />}
      {session !== undefined && !sub && <SignInGate />}
      {sub && personId === undefined && <div className="hfy-links-editor__skeleton" role="status" aria-label={COPY.loading} />}
      {sub && personId && <Editor personId={personId} />}
    </section>
  );
}

const off = document.querySelector("[data-links-off]");
if (off) off.remove();
mountIsland("links-editor", LinksPage);
