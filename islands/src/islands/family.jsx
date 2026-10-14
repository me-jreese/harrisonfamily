// /edit/family/: the relationship wizard (HFY-TSK-158, flag relationshipWizard; HFY-PLN-002 editing.md section 8, BRD2 R-24). Four flows for an
// older, non-technical member: "my parents", "my children", "my spouse or partner" and "something's wrong". One question per screen in plain
// words, a step count, big targets (56 px) and 16 px inputs, Back and Undo on every screen, and nothing sent until the summary. The client sends
// INTENTS (POST /api/relationships/preview, then POST /api/relationships); the server compiles the ops, and a member always gets a proposal.
// The pure rules are in lib/wizard-model.js, the calls in lib/wizard-api.js and the parts in lib/wizard-ui.jsx. The draft (the screen, the
// answers and the way back) lives in sessionStorage, so a reload does not lose work. The static page keeps its "not available yet" note until this
// bundle runs, and feature-flags.js loads the bundle only with relationshipWizard on, so with the flag off nothing here is requested.
import "./family.css";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { getMe } from "../lib/me.js";
import { memberSub, useEdgeSession } from "../lib/edge-session.js";
import { mountIsland } from "../lib/mount.jsx";
import { PersonName } from "../lib/person-name.jsx";
import { createWizardApi, newKey } from "../lib/wizard-api.js";
import {
  COPY, SPOUSE_TYPES, addKid, answerDifferent, answerSame, back, canBack, canUndo, changeKid, childChoices, chooseParent, chooseParentRel, chooseRole, chooseUnlink, clearDraft, confirmDistinct,
  confirmUnlink, editLine, freshState, go, hasOtherParent, intentOf, kidsDone, kidsLookRight, loadDraft, moreParents, panelLines, parentChoices, problemOf, removeKid, restart,
  rolesLeft, roleGender, routeId, saveDraft, sentenceLines, setEndYear, setEnded, setKidRelMe, setKidRelOther, setOtherParent, setPlace, setRelType, setSpouse, setYear, settle, startFlow, stepOf,
  stubWho, unansweredDuplicates, undo, unlinkChoices, whoName, MAX_KIDS, FLOWS
} from "../lib/wizard-model.js";
import { Action, Choice, ChoiceList, NewPersonForm, PersonPicker, PlaceStep, Sentence, YearForm } from "../lib/wizard-ui.jsx";

export const signInHref = () => `/auth/login?returnTo=${encodeURIComponent(`${location.pathname}${location.search}`)}`;

const storage = () => { try { return window.sessionStorage; } catch { return null; } };

/** The flags once resolved ({} until then, or when feature-flags.js is missing). */
function useFlags() {
  const [flags, setFlags] = useState(undefined);
  useEffect(() => {
    let live = true;
    const resolve = window.HFYFeatureFlags?.resolveFlags;
    Promise.resolve(typeof resolve === "function" ? resolve() : {}).then(
      (f) => { if (live) setFlags(f && typeof f === "object" ? f : {}); },
      () => { if (live) setFlags({}); },
    );
    return () => { live = false; };
  }, []);
  return flags;
}

/** The member's families, loaded once and only when a screen needs them. `status`: idle | loading | ready | failed; `retry()` asks again. */
function useFamily(wapi, meHandle, wanted) {
  const [st, setSt] = useState({ status: "idle", data: null });
  const [tick, setTick] = useState(0);
  const started = useRef(-1);
  const alive = useRef(true);
  useEffect(() => { alive.current = true; return () => { alive.current = false; }; }, []);
  useEffect(() => {
    if (!wanted || started.current === tick) return;
    started.current = tick;
    setSt({ status: "loading", data: null });
    wapi.loadFamily(meHandle).then(
      (data) => { if (alive.current) setSt({ status: "ready", data }); },
      () => { if (alive.current) setSt({ status: "failed", data: null }); },
    );
  }, [wapi, meHandle, wanted, tick]);
  return [st, () => setTick((t) => t + 1)];
}

const childLabel = (rel) => [...childChoices().main, ...childChoices().more].find((c) => c.value === rel)?.label || rel;

function Q({ children, help }) {
  return (
    <div className="hfy-wiz__lead">
      <h2 className="hfy-wiz__q" tabIndex={-1} data-hfy-q>{children}</h2>
      {help ? <p className="hfy-wiz__help">{help}</p> : null}
    </div>
  );
}

function SignInGate() {
  return (
    <div className="hfy-wiz__gate" role="status" data-hfy-gate>
      <p>{COPY.signedOut}</p>
      <a className="hfy-wiz__action hfy-wiz__action--primary" data-hfy-action href={signInHref()}>{COPY.signIn}</a>
    </div>
  );
}

function Wizard({ me, uid }) {
  const nowYear = useMemo(() => new Date().getFullYear(), []);
  const wapi = useMemo(() => createWizardApi(), []);
  const [state, setState] = useState(() => {
    const kept = loadDraft(storage(), uid);
    // The summary and the duplicate question need the server's answer, which is not kept: ask again.
    return kept ? (kept.screen === "summary" || kept.screen === "dup" ? settle(kept, "check") : kept) : freshState();
  });
  const [preview, setPreview] = useState(null);
  const [problem, setProblem] = useState(null);
  const [sending, setSending] = useState(false);
  const [sendProblem, setSendProblem] = useState(null);
  const [done, setDone] = useState(null);
  const [places, setPlaces] = useState({ status: "idle", list: [] });
  const [tick, setTick] = useState(0);
  const rootRef = useRef(null);
  const firstRender = useRef(true);
  const keyRef = useRef({ sig: "", key: "" });
  const stateRef = useRef(state);
  stateRef.current = state;

  const wantFamily = state.screen === "u.list" || state.screen === "c.other";
  const [family, retryFamily] = useFamily(wapi, me.handle, wantFamily);

  // The draft survives a reload (a per-viewer convenience: sessionStorage, every access in try/catch).
  useEffect(() => { if (!done) saveDraft(storage(), uid, state); }, [state, uid, done]);

  // Focus the question when the screen changes, so a screen reader and a keyboard follow the wizard (not on the first paint).
  useEffect(() => {
    if (firstRender.current) { firstRender.current = false; return; }
    const q = rootRef.current && rootRef.current.querySelector("[data-hfy-q]");
    if (q) q.focus({ preventScroll: false });
  }, [state.screen, state.flow, done]);

  // The check: ask the server what this would do (the preview), then the duplicate question or the summary.
  useEffect(() => {
    if (state.screen !== "check") return undefined;
    const intent = intentOf(state, me);
    if (!intent) { setState((s) => (s.screen === "check" ? back(s) : s)); return undefined; }
    let live = true;
    setProblem(null);
    setPreview(null);
    wapi.preview(intent, confirmDistinct(state)).then((res) => {
      if (!live) return;
      if (res.error) { setProblem(problemOf(res.error)); return; }
      setPreview(res.view);
      setState((s) => {
        if (s.screen !== "check") return s;
        const dups = unansweredDuplicates(s, res.view.duplicates);
        return dups.length ? settle(s, "dup", { dups }) : settle(s, "summary", { dups: [] });
      });
    });
    return () => { live = false; };
  }, [state.screen, tick]); // eslint-disable-line react-hooks/exhaustive-deps

  // The places the member's page holds, for "where did you marry?" (asked once, when that screen first shows).
  const placesAsked = useRef(false);
  useEffect(() => {
    if (state.screen !== "s.place" || placesAsked.current) return;
    placesAsked.current = true;
    setPlaces({ status: "loading", list: [] });
    wapi.loadPlaces(me.gid).then(
      (list) => setPlaces({ status: "ready", list }),
      () => setPlaces({ status: "ready", list: [] }),
    );
  }, [state.screen, wapi, me.gid]);

  const act = useCallback((fn) => setState((s) => fn(s)), []);
  // "Yes, that's them": find the person's Gramps id first (the duplicate candidate has only a handle), so the name links. A failed lookup still swaps.
  const sameAs = async (dup, c) => {
    let gid = null;
    try { const p = await wapi.resolveHandle(c.handle); gid = p ? p.gid : null; } catch { gid = null; }
    act((s) => answerSame(s, dup.uid, gid ? { ...c, gid } : c));
  };
  const draft = state.draft;
  const step = stepOf(state);

  const send = async () => {
    const intent = intentOf(state, me);
    const confirm = confirmDistinct(state);
    if (!intent || sending) return;
    if ((state.draft.dups || []).length) return; // an unanswered "is this the same person?" blocks sending
    const sig = JSON.stringify([intent, confirm]);
    if (keyRef.current.sig !== sig) keyRef.current = { sig, key: newKey() };
    setSending(true);
    setSendProblem(null);
    try {
      await wapi.send(intent, confirm, keyRef.current.key);
      keyRef.current = { sig: "", key: "" }; // a later, identical intent is a new send, not a replay of this one
      clearDraft(storage(), uid);
      setDone({ followUps: preview ? preview.followUps : [], spouse: state.flow === "spouse" ? state.draft.spouse : null });
      setState(restart());
    } catch (e) {
      const p = problemOf(e);
      if (p.kind === "duplicate") setState((s) => settle(s, "check"));
      else setSendProblem(p);
    } finally {
      setSending(false);
    }
  };

  const lines = sentenceLines(state);
  const skipIds = [me.gid, ...(draft.parents || []).map((p) => p.who && p.who.gid), ...(draft.kids || []).map((k) => k.who && k.who.gid), draft.other && draft.other.gid, draft.spouse && draft.spouse.gid].filter(Boolean);

  let body;
  if (done) {
    body = <DoneScreen done={done} onMore={() => { keyRef.current = { sig: "", key: "" }; setDone(null); setPreview(null); setState(restart()); }} />;
  } else {
    body = (
      <>
        {step && <p className="hfy-wiz__step" data-hfy-step aria-live="polite">{COPY.stepOf(step.n, step.total)}</p>}
        {renderScreen()}
      </>
    );
  }

  function renderScreen() {
    switch (state.screen) {
      case "start":
        return (
          <section data-hfy-screen="start">
            <Q help={COPY.startHelp}>{COPY.startQ}</Q>
            <div className="hfy-wiz__choices">
              {FLOWS.map((f) => <Choice key={f} onClick={() => act((s) => startFlow(s, f))} hint={COPY.flowHelp[f]} data-hfy-flow={f}>{COPY.flowLabel[f]}</Choice>)}
            </div>
          </section>
        );

      // ---- my parents
      case "p.which": {
        const labels = { mother: COPY.pMother, father: COPY.pFather, other: COPY.pOther };
        return (
          <section data-hfy-screen="p.which">
            <Q>{(draft.parents || []).length ? COPY.pWhichMore : COPY.pWhich}</Q>
            <div className="hfy-wiz__choices">
              {rolesLeft(draft).map((r) => <Choice key={r} onClick={() => act((s) => chooseRole(s, r))} data-hfy-role={r}>{labels[r]}</Choice>)}
            </div>
          </section>
        );
      }
      case "p.who": {
        const role = draft.cur ? draft.cur.role : "other";
        return (
          <section data-hfy-screen="p.who">
            <Q>{COPY.pWho(role)}</Q>
            <PersonPicker skip={skipIds} resolve={wapi.resolvePerson} newLabel={role === "mother" ? COPY.notOnSiteMother : role === "father" ? COPY.notOnSiteFather : COPY.notOnSite}
              onPick={(who) => act((s) => chooseParent(s, who))} onNew={() => act((s) => go(s, "p.new"))} />
          </section>
        );
      }
      case "p.new": {
        const role = draft.cur ? draft.cur.role : "other";
        return (
          <section data-hfy-screen="p.new">
            <Q>{COPY.pWho(role)}</Q>
            <NewPersonForm gender={roleGender(role)} surnameLabel={role === "mother" ? COPY.newSurnameMaiden : undefined} nowYear={nowYear} onSubmit={(form) => act((s) => { const who = stubWho(s.draft, form, { nowYear }); return who ? chooseParent(s, who) : s; })} />
          </section>
        );
      }
      case "p.rel": {
        const role = draft.cur ? draft.cur.role : "other";
        const c = parentChoices(role);
        return (
          <section data-hfy-screen="p.rel">
            <Q>{COPY.pRel(role)}</Q>
            <ChoiceList main={c.main} more={c.more} label={COPY.pRel(role)} onPick={(rel) => act((s) => chooseParentRel(s, rel))} />
          </section>
        );
      }
      case "p.more":
        return (
          <section data-hfy-screen="p.more">
            <Q>{COPY.pMore}</Q>
            <div className="hfy-wiz__choices">
              <Choice onClick={() => act((s) => moreParents(s, true))} data-hfy-more-yes>{COPY.pMoreYes}</Choice>
              <Choice onClick={() => act((s) => moreParents(s, false))} data-hfy-more-no>{COPY.pMoreNo}</Choice>
            </div>
          </section>
        );

      // ---- my children
      case "c.other": {
        const partners = family.status === "ready" ? family.data.partners : [];
        return (
          <section data-hfy-screen="c.other">
            <Q>{COPY.cOther}</Q>
            <div className="hfy-wiz__choices">
              {family.status === "loading" && <p className="hfy-wiz__hint" role="status">{COPY.uLoading}</p>}
              {partners.map((p) => <Choice key={p.handle} onClick={() => act((s) => setOtherParent(s, { ref: `Person:${p.handle}`, gid: p.gid || null, name: p.name, lifespan: "" }))} data-hfy-partner={p.handle}>{p.name || COPY.uSomeone}</Choice>)}
              <Choice onClick={() => act((s) => go(s, "c.otherWho"))} data-hfy-other-someone>{COPY.cOtherSomeone}</Choice>
              <Choice onClick={() => act((s) => setOtherParent(s, { unknown: true }))} data-hfy-other-unknown>{COPY.cOtherNone}</Choice>
            </div>
          </section>
        );
      }
      case "c.otherWho":
        return (
          <section data-hfy-screen="c.otherWho">
            <Q>{COPY.cOther}</Q>
            <PersonPicker skip={skipIds} resolve={wapi.resolvePerson} onPick={(who) => act((s) => setOtherParent(s, who))} onNew={() => act((s) => go(s, "c.otherNew"))} />
          </section>
        );
      case "c.otherNew":
        return (
          <section data-hfy-screen="c.otherNew">
            <Q>{COPY.cOther}</Q>
            <NewPersonForm gender="unknown" nowYear={nowYear} onSubmit={(form) => act((s) => { const who = stubWho(s.draft, form, { nowYear }); return who ? setOtherParent(s, who) : s; })} />
          </section>
        );
      case "c.add": {
        const kids = draft.kids || [];
        const full = kids.length >= MAX_KIDS;
        return (
          <section data-hfy-screen="c.add">
            <Q help={COPY.cAddHelp}>{COPY.cAdd}</Q>
            {kids.length === 0 ? <p className="hfy-wiz__hint" data-hfy-empty>{COPY.cEmpty}</p> : (
              <ul className="hfy-wiz__chips" data-hfy-kids>
                {kids.map((k, i) => (
                  <li key={i} className="hfy-wiz__chip" data-hfy-kid>
                    <PersonName id={k.who.gid || undefined} name={whoName(k.who)} />
                    <Action onClick={() => act((s) => removeKid(s, i))} aria-label={`${COPY.cRemove} ${whoName(k.who)}`} data-hfy-remove>{COPY.cRemove}</Action>
                  </li>
                ))}
              </ul>
            )}
            {full && <p className="hfy-wiz__hint" role="status" data-hfy-max>{COPY.cMax}</p>}
            <div className="hfy-wiz__choices">
              {!full && <Choice onClick={() => act((s) => go(s, "c.child"))} data-hfy-add-kid>{kids.length ? COPY.cAddAnother : COPY.cAddOne}</Choice>}
              {kids.length > 0 && <Choice onClick={() => act((s) => kidsDone(s))} data-hfy-kids-done>{COPY.cDone}</Choice>}
            </div>
          </section>
        );
      }
      case "c.child":
        return (
          <section data-hfy-screen="c.child">
            <Q>{COPY.cWho}</Q>
            <PersonPicker skip={skipIds} resolve={wapi.resolvePerson} onPick={(who) => act((s) => addKid(s, who))} onNew={() => act((s) => go(s, "c.new"))} />
          </section>
        );
      case "c.new":
        return (
          <section data-hfy-screen="c.new">
            <Q>{COPY.cWho}</Q>
            <NewPersonForm gender="unknown" nowYear={nowYear} onSubmit={(form) => act((s) => { const who = stubWho(s.draft, form, { nowYear }); return who ? addKid(s, who) : s; })} />
          </section>
        );
      case "c.rel": {
        const known = hasOtherParent(draft);
        return (
          <section data-hfy-screen="c.rel">
            <Q help={COPY.cRelHelp}>{COPY.cRel}</Q>
            <ul className="hfy-wiz__chips" data-hfy-kid-rels>
              {(draft.kids || []).map((k, i) => (
                <li key={i} className="hfy-wiz__chip hfy-wiz__chip--rel" data-hfy-kid>
                  <span><PersonName id={k.who.gid || undefined} name={whoName(k.who)} />: {childLabel(k.relToMe)}{known ? `, and ${childLabel(k.relToOther)} of ${whoName(draft.other)}` : ""}</span>
                  <Action onClick={() => act((s) => changeKid(s, i))} data-hfy-change>{COPY.cChange}</Action>
                </li>
              ))}
            </ul>
            <div className="hfy-wiz__choices">
              <Choice onClick={() => act((s) => kidsLookRight(s))} data-hfy-looks-right>{COPY.cLooksRight}</Choice>
            </div>
          </section>
        );
      }
      case "c.relMe": {
        const kid = (draft.kids || [])[draft.editKid];
        const c = childChoices();
        return (
          <section data-hfy-screen="c.relMe">
            <Q>{COPY.cRelMe(kid ? whoName(kid.who) : COPY.uSomeone)}</Q>
            <ChoiceList main={c.main} more={c.more} value={kid ? kid.relToMe : undefined} label={COPY.cRel} onPick={(rel) => act((s) => setKidRelMe(s, rel))} />
          </section>
        );
      }
      case "c.relOther": {
        const kid = (draft.kids || [])[draft.editKid];
        const c = childChoices();
        return (
          <section data-hfy-screen="c.relOther">
            <Q>{COPY.cRelOther(kid ? whoName(kid.who) : COPY.uSomeone, whoName(draft.other))}</Q>
            <ChoiceList main={c.main} more={c.more} value={kid ? kid.relToOther : undefined} label={COPY.cRel} onPick={(rel) => act((s) => setKidRelOther(s, rel))} />
          </section>
        );
      }

      // ---- my spouse or partner
      case "s.who":
        return (
          <section data-hfy-screen="s.who">
            <Q>{COPY.sWho}</Q>
            <PersonPicker skip={skipIds} resolve={wapi.resolvePerson} onPick={(who) => act((s) => setSpouse(s, who))} onNew={() => act((s) => go(s, "s.new"))} />
          </section>
        );
      case "s.new":
        return (
          <section data-hfy-screen="s.new">
            <Q>{COPY.sWho}</Q>
            <NewPersonForm gender="unknown" nowYear={nowYear} onSubmit={(form) => act((s) => { const who = stubWho(s.draft, form, { nowYear }); return who ? setSpouse(s, who) : s; })} />
          </section>
        );
      case "s.type":
        return (
          <section data-hfy-screen="s.type">
            <Q>{COPY.sType}</Q>
            <div className="hfy-wiz__choices" role="group" aria-label={COPY.sType}>
              {SPOUSE_TYPES.map((o) => <Choice key={o.value} onClick={() => act((s) => setRelType(s, o.value))} pressed={draft.relType === o.value} data-hfy-value={o.value}>{o.label}</Choice>)}
            </div>
          </section>
        );
      case "s.year":
        return (
          <section data-hfy-screen="s.year">
            <Q>{COPY.sYear}</Q>
            <YearForm label={COPY.sYear} help={COPY.sYearHelp} nowYear={nowYear} onSubmit={(v) => act((s) => setYear(s, v))} onSkip={() => act((s) => setYear(s, { year: null }))} />
          </section>
        );
      case "s.place":
        return (
          <section data-hfy-screen="s.place">
            <Q help={COPY.sPlaceHelp}>{COPY.sPlace}</Q>
            {places.status === "loading" ? <p className="hfy-wiz__hint" role="status">{COPY.loading}</p> : <PlaceStep places={places.list} onPick={(p) => act((s) => setPlace(s, p))} />}
          </section>
        );
      case "s.end":
        return (
          <section data-hfy-screen="s.end">
            <Q>{COPY.sEnd(draft.relType)}</Q>
            <div className="hfy-wiz__choices">
              <Choice onClick={() => act((s) => setEnded(s, "still"))} data-hfy-end="still">{COPY.sEndStill}</Choice>
              <Choice onClick={() => act((s) => setEnded(s, "divorced"))} data-hfy-end="divorced">{COPY.sEndDivorced}</Choice>
              <Choice onClick={() => act((s) => setEnded(s, "widowed"))} data-hfy-end="widowed">{COPY.sEndWidowed}</Choice>
            </div>
          </section>
        );
      case "s.endYear":
        return (
          <section data-hfy-screen="s.endYear">
            <Q>{COPY.sEndYear}</Q>
            <YearForm label={COPY.sEndYear} nowYear={nowYear} allowAbout={false} onSubmit={(v) => act((s) => setEndYear(s, v.year))} onSkip={() => act((s) => setEndYear(s, null))} />
          </section>
        );

      // ---- something's wrong
      case "u.list": {
        const items = family.status === "ready" ? unlinkChoices({ me, families: family.data.families }) : [];
        const label = (it) => {
          const names = it.names.map((x) => x.name).join(" and ");
          return it.kind === "parents" ? COPY.uParents(names) : it.kind === "partner" ? COPY.uPartner(names) : COPY.uChild(names);
        };
        return (
          <section data-hfy-screen="u.list">
            <Q help={COPY.uListHelp}>{COPY.uList}</Q>
            {family.status === "loading" && <p className="hfy-wiz__hint" role="status">{COPY.uLoading}</p>}
            {family.status === "failed" && (
              <p className="hfy-wiz__problem" role="alert">{COPY.loadFailed} <Action onClick={retryFamily}>{COPY.retry}</Action></p>
            )}
            {family.status === "ready" && items.length === 0 && <p className="hfy-wiz__hint" role="status" data-hfy-empty>{COPY.uNone}</p>}
            <div className="hfy-wiz__choices">
              {items.map((it, i) => <Choice key={i} onClick={() => act((s) => chooseUnlink(s, it))} data-hfy-unlink={it.kind}>{label(it)}</Choice>)}
            </div>
          </section>
        );
      }
      case "u.confirm":
        return (
          <section data-hfy-screen="u.confirm">
            <Q help={COPY.uWarn}>{COPY.uConfirm}</Q>
            {lines.map((l, i) => <p key={i} className="hfy-wiz__sentence" data-hfy-sentence><Sentence parts={l.parts} /></p>)}
            <div className="hfy-wiz__choices">
              <Choice onClick={() => act((s) => confirmUnlink(s, true))} data-hfy-yes>{COPY.uConfirmYes}</Choice>
              <Choice onClick={() => act((s) => confirmUnlink(s, false))} data-hfy-no>{COPY.uConfirmNo}</Choice>
            </div>
          </section>
        );

      // ---- asking the server, the same-person question, the summary
      case "check":
        return (
          <section data-hfy-screen="check">
            <Q>{COPY.checking}</Q>
            {!problem && <p className="hfy-wiz__hint" role="status">{COPY.loading}</p>}
            {problem && (
              <div className="hfy-wiz__problem" role="alert" data-hfy-problem={problem.kind}>
                <p>{problem.text}</p>
                {problem.kind === "signin" && <a className="hfy-wiz__action hfy-wiz__action--primary" data-hfy-action href={signInHref()}>{COPY.signIn}</a>}
                {problem.kind === "retry" && <Action onClick={() => setTick((t) => t + 1)} data-hfy-retry>{COPY.retry}</Action>}
              </div>
            )}
          </section>
        );
      case "dup": {
        const dup = (draft.dups || [])[0];
        if (!dup) return null;
        return (
          <section data-hfy-screen="dup">
            <Q help={COPY.dupHelp(dup.name)}>{COPY.dupQ}</Q>
            <p className="hfy-wiz__hint" role="status" data-hfy-blocked>{COPY.dupBlocked}</p>
            <div className="hfy-wiz__choices">
              {dup.candidates.map((c) => (
                <Choice key={c.handle} onClick={() => sameAs(dup, c)} hint={c.lifespan || undefined} data-hfy-same={c.handle}>{COPY.dupSame(c.displayName || COPY.uSomeone)}</Choice>
              ))}
              <Choice onClick={() => act((s) => answerDifferent(s, dup.uid))} data-hfy-different>{COPY.dupDifferent}</Choice>
            </div>
          </section>
        );
      }
      case "summary": {
        const blocked = (draft.dups || []).length > 0;
        const nothing = preview && preview.alreadyRecorded;
        return (
          <section data-hfy-screen="summary">
            <Q>{COPY.summaryTitle}</Q>
            {nothing ? <p className="hfy-wiz__hint" role="status" data-hfy-nothing>{COPY.summaryNothing}</p> : (
              <>
                <p className="hfy-wiz__help">{COPY.summaryLead}</p>
                <ul className="hfy-wiz__lines" data-hfy-sentences>
                  {lines.map((l, i) => (
                    <li key={i} className="hfy-wiz__line" data-hfy-sentence>
                      <span className="hfy-wiz__sentence"><Sentence parts={l.parts} /></span>
                      {l.edit && <Action onClick={() => act((s) => editLine(s, l.edit))} data-hfy-edit-line>{COPY.summaryEdit}</Action>}
                    </li>
                  ))}
                </ul>
                {preview && preview.warnings.length > 0 && (
                  <div className="hfy-wiz__notice" data-hfy-warnings>
                    <p className="hfy-wiz__notice-title">{COPY.warnings}</p>
                    <ul>{preview.warnings.map((w, i) => <li key={i}>{w}</li>)}</ul>
                  </div>
                )}
                {preview && preview.destructive && <p className="hfy-wiz__hint" data-hfy-destructive>{COPY.uWarn}</p>}
                <p className="hfy-wiz__help" data-hfy-admin-line>{COPY.summaryAdmin}</p>
              </>
            )}
            {sendProblem && <p className="hfy-wiz__problem" role="alert" data-hfy-send-problem>{sendProblem.text} {sendProblem.kind === "signin" && <a href={signInHref()}>{COPY.signIn}</a>}</p>}
            <div className="hfy-wiz__row">
              {!nothing && <Action primary onClick={send} disabled={sending || blocked} data-hfy-send>{sending ? COPY.sending : COPY.send}</Action>}
              <Action onClick={() => act((s) => back(s))} data-hfy-go-back>{COPY.sendBack}</Action>
            </div>
          </section>
        );
      }
      default:
        return null;
    }
  }

  const showNav = !done && state.screen !== "start" && (canBack(state) || canUndo(state));
  return (
    <div className="hfy-wiz" ref={rootRef} data-hfy-wizard-ready data-flow={state.flow || undefined} data-screen={done ? "done" : state.screen}>
      <div className="hfy-wiz__layout">
        <div className="hfy-wiz__main">
          {body}
          {showNav && (
            <div className="hfy-wiz__dock" data-hfy-dock>
              {canBack(state) && <Action onClick={() => act((s) => back(s))} data-hfy-back>{COPY.back}</Action>}
              <Action onClick={() => act((s) => undo(s))} disabled={!canUndo(state)} aria-label="undo my last answer" data-hfy-undo>{COPY.undo}</Action>
            </div>
          )}
        </div>
        <aside className="hfy-wiz__panel" aria-label={COPY.panel} data-hfy-panel>
          <h2 className="hfy-wiz__panel-h">{COPY.panel}</h2>
          {panelLines(state).length === 0 ? <p className="hfy-wiz__hint">{COPY.panelNone}</p> : (
            <ul className="hfy-wiz__panel-list">
              {sentenceLines(state).map((l, i) => <li key={i}><Sentence parts={l.parts} /></li>)}
            </ul>
          )}
        </aside>
      </div>
    </div>
  );
}

function DoneScreen({ done, onMore }) {
  const spouseId = done.spouse && done.spouse.gid;
  const offer = (done.followUps || []).some((f) => f.code === "offer_death_year");
  return (
    <section data-hfy-screen="done" data-hfy-sent>
      <h2 className="hfy-wiz__q" tabIndex={-1} data-hfy-q role="status">{COPY.sent}</h2>
      <div className="hfy-wiz__choices">
        <a className="hfy-wiz__choice" data-hfy-choice href="/me/review/?tab=mine" data-hfy-see-sent><span className="hfy-wiz__choice-text">{COPY.seeSent}</span></a>
        {offer && spouseId && <a className="hfy-wiz__choice" data-hfy-choice href={`/edit/?cls=person&id=${encodeURIComponent(spouseId)}`} data-hfy-death-follow><span className="hfy-wiz__choice-text">{COPY.deathFollow(whoName(done.spouse))}</span></a>}
        <Choice onClick={onMore} data-hfy-add-more>{COPY.addMore}</Choice>
      </div>
    </section>
  );
}

function FamilyPage() {
  const session = useEdgeSession();
  const sub = memberSub(session);
  const flags = useFlags();
  const [me, setMe] = useState(undefined);
  useEffect(() => {
    if (!sub) return undefined;
    let live = true;
    getMe().then((m) => { if (live) setMe(m); });
    return () => { live = false; };
  }, [sub]);
  const pending = session === undefined || flags === undefined || (sub && me === undefined);
  let body;
  if (pending) body = <div className="hfy-wiz__skeleton" role="status" aria-label={COPY.loading} />;
  else if (flags.relationshipWizard !== true) body = <p className="hfy-wiz__hint" role="status">{COPY.offFlag}</p>;
  else if (!sub) body = <SignInGate />;
  else if (me.editing === false) body = <p className="hfy-wiz__hint" role="status">{COPY.off}</p>;
  else {
    const own = me.ownRecord && typeof me.ownRecord === "object" ? me.ownRecord : null;
    const asked = routeId(location.search);
    if (!own || typeof own.handle !== "string" || typeof own.gramps_id !== "string") body = <p className="hfy-wiz__hint" role="status" data-hfy-no-page>{COPY.noPage}</p>;
    else if (asked && asked !== own.gramps_id) {
      body = (
        <div className="hfy-wiz__gate" role="status" data-hfy-not-yours>
          <p>{COPY.notYours}</p>
          <a className="hfy-wiz__action hfy-wiz__action--primary" data-hfy-action href={`/person/?id=${encodeURIComponent(own.gramps_id)}`}>{COPY.yourPage}</a>
        </div>
      );
    } else body = <Wizard me={{ handle: own.handle, gid: own.gramps_id }} uid={sub} />;
  }
  return <div className="hfy-wizpage" aria-busy={Boolean(pending)}>{body}</div>;
}

const off = document.querySelector("[data-family-off]");
if (off) off.remove();
mountIsland("family", FamilyPage);
