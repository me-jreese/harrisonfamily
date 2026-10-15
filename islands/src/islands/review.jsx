// /me/review/: the review island (HFY-TSK-259, flags proposalReview and recordEdit; HFY-PLN-002 editing.md section 9.2, BRD2 R-06 and R-07).
// Three tabs: "to review" (admins with proposalReview: the approval queue, oldest first, on the kit's `useGateInbox` over the proposal gate source),
// "my suggestions" and "about my page" (everyone, with recordEdit). A list and a detail card: from 64rem a 40/60 split, under it the list and the
// card are two views (the card has a back link and its actions in a sticky footer). The server enforces actor.admin on the queue whatever the flag
// says; here a member never gets the tab, and no queue request is made for them. The static page keeps its "not available yet" note until this
// bundle runs, and feature-flags.js loads the bundle only with one of the two flags on, so with both off nothing here is requested (HFY-R8).
import "./review.css";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useGateInbox } from "@io-kit/gates/react";
import { api } from "../lib/api.js";
import { getMe } from "../lib/me.js";
import { memberSub, useEdgeSession } from "../lib/edge-session.js";
import { mountIsland } from "../lib/mount.jsx";
import { useFlags } from "../lib/use-flags.js";
import { DuplicatesTab } from "../lib/admin-delete-ui.jsx";
import { createProposalGateSource, proposalToCard } from "../lib/proposal-gate-source.js";
import { CHIPS, COPY, TAB_LABEL, VIEW_OF, locationFor, parseLocation, pickCard, pickTab, tabsFor } from "../lib/review-model.js";
import { Chips, ProposalCard, ProposalRow, usePersonNames } from "../lib/review-ui.jsx";

export const signInHref = () => `/auth/login?returnTo=${encodeURIComponent(`${location.pathname}${location.search}`)}`;

const wide = () => typeof matchMedia === "function" && matchMedia("(min-width: 64rem)").matches;
function useWide() {
  const [isWide, setIsWide] = useState(wide());
  useEffect(() => {
    if (typeof matchMedia !== "function") return undefined;
    const mq = matchMedia("(min-width: 64rem)");
    const on = () => setIsWide(mq.matches);
    mq.addEventListener("change", on);
    return () => mq.removeEventListener("change", on);
  }, []);
  return isWide;
}

const NO_CHIP = Object.freeze({ id: "none", states: [], empty: "" });
const FILTER = Object.freeze({}); // the gates `state` filter is ignored: each chip names its own proposal states

function Review({ tabs }) {
  const initial = useMemo(() => parseLocation(location.search), []);
  const [tab, setTab] = useState(() => pickTab(tabs, initial.tab));
  const [chipId, setChipId] = useState(() => (CHIPS[pickTab(tabs, initial.tab)] || [])[0]?.id);
  const [selectedId, setSelectedId] = useState(initial.id);
  const [overrides, setOverrides] = useState(() => new Map());
  const [missing, setMissing] = useState(false);
  const [truncated, setTruncated] = useState(false);
  const isWide = useWide();
  const names = usePersonNames();
  const detailRef = useRef(null);
  const listRef = useRef(null);
  const moved = useRef(false);

  // The "possible duplicates" tab (admins with adminDelete, HFY-TSK-295) is not a list of suggestions: it has no chips and no gate source.
  const dupTab = tab === "duplicates";
  const chips = CHIPS[tab] || [];
  const chip = chips.find((c) => c.id === chipId) || chips[0] || NO_CHIP;
  const source = useMemo(() => (dupTab ? null : createProposalGateSource(api, { view: VIEW_OF[tab], states: chip.states, keep: chip.keep, onTruncated: setTruncated })), [tab, chip, dupTab]);
  const sources = useMemo(() => (source ? [source] : []), [source]);
  const inbox = useGateInbox(sources, FILTER);

  // The history: a tab or a chip replaces the entry, a card pushes one, so the phone's back button goes from the card to the list.
  const go = useCallback((next, push) => {
    const url = `${location.pathname}${locationFor(next)}`;
    try { (push ? history.pushState : history.replaceState).call(history, push && next.id ? { hfyReview: true } : null, "", url); } catch { /* the page still works without the URL */ }
  }, []);
  useEffect(() => {
    const on = () => {
      const l = parseLocation(location.search);
      const t = pickTab(tabs, l.tab);
      setTab((cur) => { if (cur !== t) setChipId((CHIPS[t] || [])[0]?.id); return t; });
      setSelectedId(l.id);
    };
    window.addEventListener("popstate", on);
    return () => window.removeEventListener("popstate", on);
  }, [tabs]);

  // Oldest first for the queue (the kit sorts by `expiresAt`, which the adapter sets from the creation time); newest first for the personal lists.
  const listed = useMemo(() => {
    const merged = inbox.cards.map((c) => pickCard(c, overrides.get(c.id)));
    return tab === "review" ? merged : [...merged].reverse();
  }, [inbox.cards, overrides, tab]);

  // The open card stays open when a list read no longer has it (a decision or a conflict moves it to another chip): the last card shown is held.
  const held = useRef(null);
  const found = selectedId ? listed.find((c) => c.id === selectedId) || overrides.get(selectedId) || null : null;
  if (found) held.current = found;
  const selected = found || (selectedId && held.current && held.current.id === selectedId ? held.current : null);
  // A link to a suggestion that is not on the list (a notification, the toast after sending) reads that one suggestion.
  useEffect(() => {
    setMissing(false);
    if (!selectedId || selected || inbox.loading) return undefined;
    let live = true;
    api.get(`/proposals/${encodeURIComponent(selectedId)}`).then(
      (v) => { if (live) setOverrides((prev) => new Map(prev).set(v.id, proposalToCard(v))); },
      () => { if (live) setMissing(true); },
    );
    return () => { live = false; };
  }, [selectedId, selected, inbox.loading]);

  // Focus follows the view change on a phone: the card when one opens, the row when it closes.
  useEffect(() => {
    if (!moved.current) { moved.current = true; return; }
    if (isWide) return;
    if (selectedId && detailRef.current) detailRef.current.focus();
    else if (listRef.current) {
      const row = listRef.current.querySelector('[aria-current="true"], .hfy-review__open');
      if (row) row.focus();
    }
  }, [selectedId, isWide]);

  const pickTabId = (t) => { setTab(t); setChipId((CHIPS[t] || [])[0]?.id); setSelectedId(null); go({ tab: t }, false); };
  const pickChip = (id) => { setChipId(id); setSelectedId(null); go({ tab }, false); };
  const open = (id) => { setSelectedId(id); go({ tab, id }, true); };
  // Closing a card the island pushed goes back one entry (so the history does not grow on every open and close); a card reached by a link replaces it.
  const close = () => {
    if (history.state && history.state.hfyReview) { history.back(); return; }
    setSelectedId(null);
    go({ tab }, false);
  };
  // A card from a conflict, an edit or a decision is held and shown until the list has a newer read of it (the list's index can lag).
  const onCardChanged = useCallback((card) => setOverrides((prev) => new Map(prev).set(card.id, card)), []);
  const onChanged = useCallback(() => { inbox.refresh(); }, [inbox.refresh]); // eslint-disable-line react-hooks/exhaustive-deps

  const showList = isWide || !selectedId;
  const showDetail = isWide || Boolean(selectedId);
  const first = inbox.loading && !listed.length;
  return (
    <div className="hfy-review" data-hfy-review-ready data-tab={tab} data-selected={selectedId ? "true" : undefined}>
      <nav className="hfy-review__tabs" aria-label={COPY.tabs}>
        {tabs.map((t) => (
          <a key={t} href={`?tab=${t}`} className="hfy-review__tab" aria-current={t === tab ? "page" : undefined} data-hfy-tab={t}
            onClick={(e) => { if (e.metaKey || e.ctrlKey || e.shiftKey || e.button) return; e.preventDefault(); pickTabId(t); }}>{TAB_LABEL[t]}</a>
        ))}
      </nav>
      {dupTab && <DuplicatesTab />}
      {!dupTab && <div className="hfy-review__split">
        {showList && (
          <section className="hfy-review__list" aria-label={COPY.list} ref={listRef} data-hfy-list>
            <Chips chips={chips} active={chip.id} onPick={pickChip} label={COPY.filters} />
            {first && <div className="hfy-review__skeleton" role="status" aria-label={COPY.loading} />}
            {inbox.error && <p className="hfy-review__problem" role="alert">{COPY.loadFailed} <button type="button" className="hfy-review__btn" onClick={() => inbox.refresh()}>{COPY.retry}</button></p>}
            {!first && !inbox.error && !listed.length && <p className="hfy-review__note" role="status" data-hfy-empty>{chip.empty}</p>}
            {truncated && !inbox.error && <p className="hfy-review__note" role="status" data-hfy-truncated>{COPY.moreThanShown}</p>}
            {listed.length > 0 && (
              <ul className="hfy-review__items" data-hfy-items>
                {listed.map((c) => <ProposalRow key={c.id} card={c} selected={c.id === selectedId} onOpen={open} names={names} mode={tab} />)}
              </ul>
            )}
          </section>
        )}
        {showDetail && (
          <section className="hfy-review__detail" aria-label="suggestion" tabIndex={-1} ref={detailRef} data-hfy-detail>
            {selectedId && !isWide && <button type="button" className="hfy-review__back" onClick={close} data-hfy-back>{COPY.back}</button>}
            {selected && <ProposalCard key={selected.id} card={selected} source={source} api={api} mode={tab} names={names} onCardChanged={onCardChanged} onChanged={onChanged} />}
            {selectedId && !selected && !missing && <div className="hfy-review__skeleton" role="status" aria-label={COPY.loading} />}
            {selectedId && !selected && missing && <p className="hfy-review__note" role="status">{COPY.gone}</p>}
            {!selectedId && <p className="hfy-review__note" data-hfy-pick>{COPY.pickOne}</p>}
          </section>
        )}
      </div>}
    </div>
  );
}

function SignInGate() {
  return (
    <div className="hfy-review__gate" role="status" data-hfy-gate>
      <p>{COPY.signedOut}</p>
      <a className="hfy-review__signin" href={signInHref()}>{COPY.signIn}</a>
    </div>
  );
}

function ReviewPage() {
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
  if (pending) body = <div className="hfy-review__skeleton" role="status" aria-label={COPY.loading} />;
  else if (!sub) body = <SignInGate />;
  else if (me.editing === false) body = <p className="hfy-review__note" role="status">{COPY.off}</p>;
  else {
    const tabs = tabsFor({ admin: me.admin === true, flags });
    body = tabs.length ? <Review tabs={tabs} /> : <p className="hfy-review__note" role="status">{COPY.unavailable}</p>;
  }
  return <div className="hfy-reviewpage" aria-busy={Boolean(pending)}>{body}</div>;
}

const off = document.querySelector("[data-review-off]");
if (off) off.remove();
mountIsland("review", ReviewPage);
