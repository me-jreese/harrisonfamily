// /join/: ask to join the family site (HFY-TSK-140, flag accessRequests; HFY-PLN-002 surfaces 7.10). Three steps, one at a time:
//   1  email + Turnstile + honeypot     -> POST /auth/access-request/start   (202 always; the edge emails a 6-digit code)
//   2  the 6-digit code                  -> POST /auth/access-request/verify  (200 {ticket}: the mailbox is proved)
//   3  the Legacy Form + "about me"      -> POST /auth/access-request         (201: received)
// Focus moves to each step's heading. Errors are one summary (role=alert) that links to the fields; each field's error is tied to it
// with aria-describedby. The answers of step 3 are kept in sessionStorage["hfy:join-draft"] (never the code, the ticket or the email) and
// cleared on success; an expired ticket sends the visitor back to step 1 with the answers still in the form.
// The page loads this bundle only with accessRequests (feature-flags.js); flag off, it keeps its static "isn't open yet" note.
import "./join.css";
import { useEffect, useId, useRef, useState } from "react";
import { mountIsland } from "../lib/mount.jsx";
import { TURNSTILE_ACTION, loadTurnstile } from "../lib/turnstile.js";
import {
  COPY, FIELD_UI, RESEND_AFTER_SECONDS, STEPS,
  checkForm, clearDraft, createJoinApi, errorLine, formBody, formFields, loadDraft, readConfig, saveDraft,
  startOutcome, submitOutcome, summaryItems, verifyOutcome
} from "../lib/join.js";

const api = createJoinApi();
export const SIGN_IN_HREF = "/auth/login";
const fieldId = (key) => `join-f-${key}`;

/** The Turnstile widget. Its token is single-use: a change of `resetKey` asks for a fresh one. `onFail` is a load or widget error. */
function Check({ siteKey, onToken, onFail, resetKey }) {
  const host = useRef(null);
  const widget = useRef(null);
  const cb = useRef({ onToken, onFail });
  cb.current = { onToken, onFail };
  useEffect(() => {
    let live = true;
    loadTurnstile().then((ts) => {
      if (!live || !host.current) return;
      widget.current = ts.render(host.current, {
        sitekey: siteKey,
        action: TURNSTILE_ACTION,
        theme: "dark",
        callback: (t) => cb.current.onToken(t),
        "expired-callback": () => cb.current.onToken(""),
        "error-callback": () => { cb.current.onToken(""); cb.current.onFail(); }
      });
    }, () => { if (live) cb.current.onFail(); });
    return () => {
      live = false;
      try { if (widget.current != null && window.turnstile) window.turnstile.remove(widget.current); } catch { /* already gone */ }
      widget.current = null;
    };
  }, [siteKey]);
  useEffect(() => {
    if (!resetKey) return;
    cb.current.onToken("");
    try { if (widget.current != null && window.turnstile) window.turnstile.reset(widget.current); } catch { /* the widget is not up yet */ }
  }, [resetKey]);
  return <div className="hfy-join__check" ref={host} data-join-check />;
}

/** The hidden trap for bots: out of the tab order and the accessibility tree; a person never fills it. */
function Trap({ value, onChange }) {
  return (
    <div className="hfy-join__trap" aria-hidden="true">
      <label>company<input type="text" name="company" tabIndex={-1} autoComplete="off" value={value} onChange={(e) => onChange(e.target.value)} /></label>
    </div>
  );
}

/** The error summary: role=alert, focusable, each item a link that moves focus to its field. */
function Summary({ heading, items, innerRef }) {
  if (!items.length) return null;
  const go = (e, id) => {
    e.preventDefault();
    const el = document.getElementById(id);
    if (!el) return;
    const target = el.matches("input, select, textarea") ? el : el.querySelector("input, select, textarea");
    (target || el).focus();
  };
  return (
    <div className="hfy-join__summary" role="alert" tabIndex={-1} ref={innerRef} data-join-summary>
      <p className="hfy-join__summary-h">{heading}</p>
      <ul>
        {items.map((it) => <li key={it.field}><a href={`#${it.id}`} onClick={(e) => go(e, it.id)}>{it.text}</a></li>)}
      </ul>
    </div>
  );
}

function Heading({ step, innerRef, children }) {
  return (
    <h2 className="hfy-join__h" tabIndex={-1} ref={innerRef} data-join-step={step ? String(step) : undefined}>
      {step ? <span className="hfy-join__step">{COPY.stepOf(step)}</span> : null}
      <span>{children}</span>
    </h2>
  );
}

function Text({ name, value, onChange, error, required, ...rest }) {
  const ui = FIELD_UI[name];
  const hintId = `${fieldId(name)}-hint`;
  const errId = `${fieldId(name)}-err`;
  const describedBy = [ui.hint ? hintId : "", error ? errId : ""].filter(Boolean).join(" ") || undefined;
  return (
    <div className="hfy-join__field" data-field={name}>
      <label className="hfy-join__label" htmlFor={fieldId(name)}>{ui.label}</label>
      {ui.hint ? <p className="hfy-join__hint" id={hintId}>{ui.hint}</p> : null}
      <input
        id={fieldId(name)}
        className="hfy-join__input"
        type="text"
        name={name}
        value={value}
        autoComplete="off"
        spellCheck="false"
        aria-required={required ? "true" : undefined}
        aria-invalid={error ? "true" : undefined}
        aria-describedby={describedBy}
        onChange={(e) => onChange(name, e.target.value)}
        {...(ui.numeric ? { inputMode: "numeric", maxLength: 4 } : {})}
        {...rest}
      />
      {error ? <p className="hfy-join__error" id={errId}>{error}</p> : null}
    </div>
  );
}

function Radios({ name, value, onChange, error, required }) {
  const ui = FIELD_UI[name];
  const errId = `${fieldId(name)}-err`;
  return (
    <fieldset className="hfy-join__radios" role="radiogroup" id={fieldId(name)} data-field={name} aria-required={required ? "true" : undefined} aria-invalid={error ? "true" : undefined} aria-describedby={error ? errId : undefined}>
      <legend className="hfy-join__label">{ui.label}</legend>
      {ui.hint ? <p className="hfy-join__hint">{ui.hint}</p> : null}
      {ui.options.map(([v, label]) => (
        <label className="hfy-join__radio" key={v}>
          <input type="radio" name={name} value={v} checked={value === v} onChange={() => onChange(name, v)} />
          <span>{label}</span>
        </label>
      ))}
      {error ? <p className="hfy-join__error" id={errId}>{error}</p> : null}
    </fieldset>
  );
}

function Field({ spec, values, lines, onChange }) {
  const common = { name: spec.key, value: values[spec.key], onChange, error: lines[spec.key], required: spec.required };
  return FIELD_UI[spec.key].options ? <Radios {...common} /> : <Text {...common} />;
}

function Join() {
  const [phase, setPhase] = useState("loading"); // loading | closed | unavailable | email | code | form | done | settled
  const [siteKey, setSiteKey] = useState("");
  const [email, setEmail] = useState("");
  const [code, setCode] = useState("");
  const [ticket, setTicket] = useState("");
  const [values, setValues] = useState(loadDraft);
  const [lines, setLines] = useState({}); // step 3: { field: line }
  const [fieldError, setFieldError] = useState(null); // steps 1 and 2: { field: "email" | "code", text }
  const [failure, setFailure] = useState(""); // a line that belongs to no field
  const [notice, setNotice] = useState(""); // a status line (role=status)
  const [token, setToken] = useState("");
  const [resetKey, setResetKey] = useState(0);
  const [trap, setTrap] = useState("");
  const [busy, setBusy] = useState(false);
  const [resendAt, setResendAt] = useState(0); // ms; the next "send another" is allowed at this time
  const [now, setNow] = useState(() => Date.now());
  const resendIn = Math.max(0, Math.ceil((resendAt - now) / 1000));
  const [settled, setSettled] = useState("requested");
  const [closedMid, setClosedMid] = useState(false); // the edge closed while the visitor was part-way through
  const heading = useRef(null);
  const summary = useRef(null);
  const interacted = useRef(false);
  const emailId = useId();
  const codeId = useId();

  const reload = () => {
    setPhase("loading");
    api.config().then((res) => {
      const c = readConfig(res);
      if (c.state === "open") { setSiteKey(c.siteKey); setPhase("email"); } else setPhase(c.state);
    });
  };
  useEffect(reload, []);

  // Focus follows the step, but never on the first paint: the visitor has not asked for anything yet.
  useEffect(() => {
    if (interacted.current && heading.current) heading.current.focus();
  }, [phase]);

  // The summary takes focus when it appears with something to fix.
  const [tick, setTick] = useState(0);
  useEffect(() => {
    if (tick && summary.current) summary.current.focus();
  }, [tick]);
  const flag = () => setTick((n) => n + 1);

  useEffect(() => { if (phase === "form") saveDraft(values); }, [phase, values]);

  // The wait is a deadline, not a count of ticks, so a throttled background tab still opens the button on time.
  const waiting = phase === "code" && resendAt > now;
  useEffect(() => {
    if (!waiting) return undefined;
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, [waiting]);
  const holdResend = () => { const t = Date.now(); setNow(t); setResendAt(t + RESEND_AFTER_SECONDS * 1000); };

  const go = (next) => { interacted.current = true; setFailure(""); setFieldError(null); setLines({}); setPhase(next); };
  const spent = () => { setToken(""); setResetKey((k) => k + 1); }; // a Turnstile token is good for one request
  const needToken = () => {
    if (token) return false;
    setFailure(COPY.checkWait);
    return true;
  };
  const apply = (out, { spend = true } = {}) => {
    if (out.kind === "closed") { setClosedMid(true); go("closed"); return; }
    if (out.kind === "field") { setFieldError({ field: out.field, text: out.text }); flag(); } else setFailure(out.text);
    if (spend) spent();
  };

  async function onStart(e) {
    e.preventDefault();
    if (busy) return;
    const typed = email.trim();
    setFailure(""); setFieldError(null); setNotice("");
    if (!typed || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(typed)) { setFieldError({ field: "email", text: COPY.badEmail }); flag(); return; }
    if (needToken()) return;
    setBusy(true);
    const out = startOutcome(await api.start({ email: typed, turnstileToken: token, company: trap }));
    setBusy(false);
    if (!out.ok) { apply(out); return; }
    setEmail(typed); setCode(""); holdResend(); spent();
    go("code");
  }

  async function onResend() {
    if (busy || resendIn > 0) return;
    setFailure(""); setFieldError(null);
    if (needToken()) return;
    setBusy(true);
    const out = startOutcome(await api.start({ email, turnstileToken: token, company: trap }));
    setBusy(false);
    if (!out.ok) { apply(out); return; }
    setNotice(COPY.sentAnother); holdResend(); setCode(""); spent();
  }

  async function onVerify(e) {
    e.preventDefault();
    if (busy) return;
    const digits = code.replace(/\s+/g, "");
    setFailure(""); setFieldError(null); setNotice("");
    if (!/^\d{6}$/.test(digits)) { setFieldError({ field: "code", text: COPY.codeShape }); flag(); return; }
    setBusy(true);
    const out = verifyOutcome(await api.verify({ email, code: digits }));
    setBusy(false);
    if (!out.ok) {
      if (out.resend) setResendAt(0);
      apply(out, { spend: false });
      return;
    }
    setTicket(out.ticket); setCode(""); spent();
    go("form");
  }

  async function onSubmit(e) {
    e.preventDefault();
    if (busy) return;
    setFailure(""); setFieldError(null); setNotice("");
    const issues = checkForm(values, email);
    if (issues.length) {
      const next = {};
      for (const i of issues) next[i.field] ??= errorLine(i.field, i.code);
      setLines(next);
      flag();
      return;
    }
    setLines({});
    if (needToken()) return;
    setBusy(true);
    const out = submitOutcome(await api.submit({ ticket, form: formBody(values), turnstileToken: token, company: trap }));
    setBusy(false);
    if (out.ok || out.settled) {
      clearDraft(); setValues(loadDraft()); setTicket(""); setSettled(out.settled || "requested");
      go(out.ok ? "done" : "settled");
      return;
    }
    if (out.kind === "ticket") {
      setTicket(""); setCode(""); spent();
      go("email");
      setNotice(COPY.expired);
      return;
    }
    if (out.kind === "fields") {
      setLines(out.lines);
      if (Object.keys(out.lines).length) flag(); else setFailure(COPY.unavailable);
      spent();
      return;
    }
    apply(out);
  }

  const change = (name, v) => {
    setValues((cur) => ({ ...cur, [name]: v }));
    setLines((cur) => { if (!cur[name]) return cur; const { [name]: _gone, ...rest } = cur; return rest; });
  };

  const status = notice ? <p className="hfy-join__notice" role="status" data-join-notice>{notice}</p> : null;
  const alert = failure ? <p className="hfy-join__failure" role="alert" data-join-failure>{failure}</p> : null;
  const checkProps = { siteKey, onToken: setToken, onFail: () => { setToken(""); setFailure(COPY.checkFailed); }, resetKey };

  if (phase === "loading") return <div className="hfy-join hfy-join__skeleton" role="status" aria-busy="true" aria-label={COPY.loading} />;
  if (phase === "closed") return <p className="hfy-join__note" role="status" data-join-state="closed">{closedMid ? COPY.closedNow : COPY.closed}</p>;
  if (phase === "unavailable") {
    return (
      <div className="hfy-join" data-join-state="unavailable">
        <p className="hfy-join__note" role="status">{COPY.unavailable}</p>
        <button type="button" className="hfy-join__btn" onClick={reload}>{COPY.retry}</button>
      </div>
    );
  }

  if (phase === "done" || phase === "settled") {
    return (
      <section className="hfy-join" data-join-state={phase === "done" ? "done" : `settled-${settled}`}>
        <Heading innerRef={heading}>{phase === "done" ? COPY.doneTitle : (settled === "member" ? COPY.alreadyMember : COPY.alreadyRequested)}</Heading>
        {phase === "done" ? (
          <>
            <p>{COPY.done}</p>
            <p>{COPY.doneAbout.split(COPY.doneAboutLink)[0]}<a href="/about/" className="hfy-join__link">{COPY.doneAboutLink}</a>{COPY.doneAbout.split(COPY.doneAboutLink)[1]}</p>
          </>
        ) : settled === "member" ? <p><a href={SIGN_IN_HREF} className="hfy-join__link">{COPY.signIn}</a></p> : null}
      </section>
    );
  }

  if (phase === "email") {
    const err = fieldError && fieldError.field === "email" ? fieldError.text : "";
    return (
      <section className="hfy-join" data-join-state="email">
        <Heading innerRef={heading} step={STEPS.email}>{COPY.step1}</Heading>
        <p className="hfy-join__lede">{COPY.lede}</p>
        <p className="hfy-join__hint">{COPY.privacy}</p>
        <p className="hfy-join__hint">{COPY.firstCode}</p>
        {status}
        <Summary heading={COPY.summaryEmail} items={err ? [{ field: "email", id: emailId, text: err }] : []} innerRef={summary} />
        <form onSubmit={onStart} noValidate>
          <Trap value={trap} onChange={setTrap} />
          <div className="hfy-join__field">
            <label className="hfy-join__label" htmlFor={emailId}>{COPY.emailLabel}</label>
            <p className="hfy-join__hint" id={`${emailId}-hint`}>{COPY.emailHint}</p>
            <input
              id={emailId} className="hfy-join__input" type="email" name="email" autoComplete="email" inputMode="email" autoCapitalize="none" spellCheck="false"
              value={email} onChange={(e) => setEmail(e.target.value)}
              aria-required="true" aria-invalid={err ? "true" : undefined} aria-describedby={err ? `${emailId}-hint ${emailId}-err` : `${emailId}-hint`}
            />
            {err ? <p className="hfy-join__error" id={`${emailId}-err`}>{err}</p> : null}
          </div>
          <Check {...checkProps} />
          {alert}
          <button type="submit" className="hfy-join__btn hfy-join__btn--primary" aria-disabled={busy ? "true" : undefined}>{busy ? COPY.sending : COPY.sendCode}</button>
        </form>
      </section>
    );
  }

  if (phase === "code") {
    const err = fieldError && fieldError.field === "code" ? fieldError.text : "";
    return (
      <section className="hfy-join" data-join-state="code">
        <Heading innerRef={heading} step={STEPS.code}>{COPY.step2}</Heading>
        <p>{COPY.sentTo(email)}</p>
        {status}
        <Summary heading={COPY.summaryEmail} items={err ? [{ field: "code", id: codeId, text: err }] : []} innerRef={summary} />
        <form onSubmit={onVerify} noValidate>
          <div className="hfy-join__field">
            <label className="hfy-join__label" htmlFor={codeId}>{COPY.codeLabel}</label>
            <input
              id={codeId} className="hfy-join__input hfy-join__input--code" type="text" name="code" autoComplete="one-time-code" inputMode="numeric" maxLength={12} spellCheck="false"
              value={code} onChange={(e) => setCode(e.target.value)}
              aria-required="true" aria-invalid={err ? "true" : undefined} aria-describedby={err ? `${codeId}-err` : undefined}
            />
            {err ? <p className="hfy-join__error" id={`${codeId}-err`}>{err}</p> : null}
          </div>
          {alert}
          <button type="submit" className="hfy-join__btn hfy-join__btn--primary" aria-disabled={busy ? "true" : undefined}>{busy ? COPY.checking : COPY.checkIt}</button>
        </form>
        <div className="hfy-join__again">
          <p>
            {COPY.noCode}{" "}
            <button type="button" className="hfy-join__linkbtn" onClick={onResend} aria-disabled={resendIn > 0 || busy ? "true" : undefined} data-join-resend>{COPY.sendAnother}</button>
          </p>
          {resendIn > 0 ? <p className="hfy-join__hint" data-join-wait>{COPY.waitResend(resendIn)}</p> : null}
          <Check {...checkProps} />
          <button type="button" className="hfy-join__linkbtn" onClick={() => { setCode(""); setNotice(""); go("email"); }}>{COPY.differentEmail}</button>
        </div>
      </section>
    );
  }

  // phase === "form"
  const items = summaryItems(lines).map((it) => ({ ...it, id: fieldId(it.field) }));
  return (
    <section className="hfy-join" data-join-state="form">
      <Heading innerRef={heading} step={STEPS.form}>{COPY.step3}</Heading>
      {status}
      <Summary heading={COPY.summary} items={items} innerRef={summary} />
      <form onSubmit={onSubmit} noValidate>
        <Trap value={trap} onChange={setTrap} />
        <fieldset className="hfy-join__set">
          <legend className="hfy-join__legend">{COPY.aboutYou}</legend>
          {formFields(1).map((f) => <Field key={f.key} spec={f} values={values} lines={lines} onChange={change} />)}
        </fieldset>
        <fieldset className="hfy-join__set">
          <legend className="hfy-join__legend">{COPY.timeline}</legend>
          {formFields(2).map((f) => <Field key={f.key} spec={f} values={values} lines={lines} onChange={change} />)}
        </fieldset>
        <div className="hfy-join__field" data-field="forSelf">
          <label className="hfy-join__radio hfy-join__radio--check" htmlFor={fieldId("forSelf")}>
            <input
              id={fieldId("forSelf")} type="checkbox" name="forSelf" checked={values.forSelf === true}
              aria-required="true" aria-invalid={lines.forSelf ? "true" : undefined} aria-describedby={lines.forSelf ? `${fieldId("forSelf")}-err` : undefined}
              onChange={(e) => change("forSelf", e.target.checked)}
            />
            <span>{FIELD_UI.forSelf.label}</span>
          </label>
          {lines.forSelf ? <p className="hfy-join__error" id={`${fieldId("forSelf")}-err`}>{lines.forSelf}</p> : null}
        </div>
        <Check {...checkProps} />
        {alert}
        <button type="submit" className="hfy-join__btn hfy-join__btn--primary" aria-disabled={busy ? "true" : undefined}>{busy ? COPY.sendingRequest : COPY.send}</button>
      </form>
    </section>
  );
}

const off = document.querySelector("[data-join-off]");
if (off) off.remove();
mountIsland("join", Join);
