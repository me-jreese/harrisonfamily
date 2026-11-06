// CappedSection (HFY-TSK-188, social.md section 8, R-28): one list body cut at a height cap, with a "show older ..." button under it. It bounds
// both what is downloaded (the first page is small) and what is drawn (clipped items are inert). Shared by stories, comments and contributions.
//
//   - The clip. The list element (the body itself, or the element `clipSelector` names inside it, such as the kit thread's list, so the
//     composer above it is never clipped) gets max-height = the cap and overflow hidden, with a fade mask while it overflows
//     (capped.css; lib/capped-model.js has the sizes). A ResizeObserver and a MutationObserver re-measure on every change.
//   - Inert items. An item (`itemSelector`, relative to the clip) that starts at or below the cap gets `inert` and aria-hidden="true", so
//     keyboard and screen-reader users never land on clipped content.
//   - "show older ...". It first raises the cap by one step (one more cap) and moves focus to the first item that step revealed. Once
//     nothing loaded remains clipped it asks the host for the next page (`onMore`), then raises the cap and focuses the first new item.
//     It is hidden when everything is loaded and visible. The section grows in the page: there is no scroll box inside it.
//   - Anchors. `revealSelector` names one item (an `#comment-<ulid>` link): the cap is raised until it is visible, then `onReveal(el)` runs.
//
// The host owns the list's loading, error and empty states and the paging itself; this component owns the clipping and the button.
import "../capped.css";
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { MAX_STEPS, WIDE_QUERY, capExpression, hiddenIndexes } from "./capped-model.js";
import { useMedia } from "./use-media.js";

export function CappedSection({
  label,
  children,
  itemSelector = ":scope > li",
  clipSelector = null,
  hasMore = false,
  loading = false,
  onMore,
  revealSelector = null,
  onReveal,
  className = "",
}) {
  const wide = useMedia(WIDE_QUERY);
  const [steps, setSteps] = useState(0);
  const [view, setView] = useState({ items: 0, hidden: 0, clipped: false });
  const body = useRef(null);
  // The latest props and state, read by the observers and the measure pass without re-subscribing them.
  const live = useRef({});
  live.current = { wide, steps, hasMore, loading, onMore, revealSelector, onReveal, itemSelector, clipSelector, view };
  const awaiting = useRef(null); // { last, count } when a page was asked for: the last item then and the item count; the cap rises when items show up after `last`
  const focusAt = useRef(null); // the item index to focus once it is visible
  const bumpedAt = useRef(-1); // the `steps` value a raise was already requested from, so one measure burst raises once
  const revealed = useRef(null); // the selector whose item was already announced to onReveal

  const clipOf = () => {
    const root = body.current;
    if (!root) return null;
    const { clipSelector: sel } = live.current;
    return sel ? root.querySelector(sel) : root;
  };

  const raise = useCallback(() => {
    const at = live.current.steps;
    if (bumpedAt.current === at || at >= MAX_STEPS) return;
    bumpedAt.current = at;
    setSteps((s) => Math.min(MAX_STEPS, s + 1));
  }, []);

  // One pass: apply the cap, mark the clipped items, then act on whatever is pending (an anchor, a page, a focus move).
  const measure = useCallback(() => {
    const clip = clipOf();
    if (!clip) return;
    const { wide: isWide, steps: n, itemSelector: sel } = live.current;
    clip.classList.add("hfy-capped__clip");
    clip.style.maxHeight = capExpression(isWide, n);
    const cap = parseFloat(getComputedStyle(clip).maxHeight);
    const top = clip.getBoundingClientRect().top;
    const items = [...clip.querySelectorAll(sel)];
    const hiddenAt = new Set(hiddenIndexes(items.map((el) => el.getBoundingClientRect().top - top), cap));
    items.forEach((el, i) => {
      const off = hiddenAt.has(i);
      if (el.hasAttribute("inert") !== off) el.toggleAttribute("inert", off);
      if (off) { if (el.getAttribute("aria-hidden") !== "true") el.setAttribute("aria-hidden", "true"); } else if (el.hasAttribute("aria-hidden")) el.removeAttribute("aria-hidden");
    });
    const clipped = clip.scrollHeight > clip.clientHeight + 1;
    if (clip.hasAttribute("data-clipped") !== clipped) clip.toggleAttribute("data-clipped", clipped);
    const next = { items: items.length, hidden: hiddenAt.size, clipped };
    setView((v) => (v.items === next.items && v.hidden === next.hidden && v.clipped === next.clipped ? v : next));

    // An anchor: raise the cap until its item is visible, then hand it over once.
    const want = live.current.revealSelector;
    if (want) {
      const el = body.current.querySelector(want);
      if (el) {
        if (el.closest("[inert]")) raise();
        else if (revealed.current !== want) { revealed.current = want; live.current.onReveal?.(el); }
      }
    } else revealed.current = null;

    // A page was asked for: when it arrives the cap rises one step and focus goes to its first item; if the fetch ended with nothing new, stop waiting.
    if (awaiting.current !== null) {
      // New items arrive after the last item that was there. A comment the viewer posts meanwhile lands before it (newest first), so it neither
      // counts as the page nor moves focus; if the last item itself went away, fall back to the count.
      const { last, count } = awaiting.current;
      const at = last ? items.indexOf(last) : -1;
      const first = at >= 0 ? (at + 1 < items.length ? at + 1 : -1) : (items.length > count ? count : -1);
      if (first >= 0) { focusAt.current = first; awaiting.current = null; raise(); }
      else if (!live.current.loading) awaiting.current = null;
    }

    if (focusAt.current !== null) {
      const el = items[focusAt.current];
      if (el && !el.hasAttribute("inert")) {
        focusAt.current = null;
        el.tabIndex = -1;
        el.focus();
      }
    }
  }, [raise]);

  // Every render re-applies the cap (a raised step, the breakpoint, a page that finished), and each DOM change or resize re-measures.
  useLayoutEffect(() => { measure(); }, [measure, wide, steps, loading, hasMore, revealSelector, children]);
  useEffect(() => {
    const root = body.current;
    if (!root) return undefined;
    let ro = null;
    const watch = () => {
      if (!ro) return;
      ro.disconnect();
      const clip = clipOf();
      if (!clip) return;
      ro.observe(clip);
      clip.querySelectorAll(live.current.itemSelector).forEach((el) => ro.observe(el)); // a photo that loads late moves the items below it
    };
    if (typeof ResizeObserver === "function") ro = new ResizeObserver(() => measure());
    const mo = new MutationObserver(() => { watch(); measure(); });
    mo.observe(root, { childList: true, subtree: true });
    watch();
    return () => { mo.disconnect(); ro?.disconnect(); };
  }, [measure]);

  const showButton = view.clipped || view.hidden > 0 || hasMore;
  const onClick = () => {
    const { view: v, hasMore: more, loading: busy, onMore: ask } = live.current;
    if (busy) return; // aria-disabled, not disabled: a disabled button would drop keyboard focus to the body while the page loads
    if (v.hidden > 0 || v.clipped) {
      if (v.hidden > 0) focusAt.current = v.items - v.hidden; // the hidden items are the tail, so the first one is items - hidden
      bumpedAt.current = -1;
      raise();
      return;
    }
    if (more && !busy && ask) {
      const list = clipOf()?.querySelectorAll(live.current.itemSelector) ?? [];
      awaiting.current = { last: list[list.length - 1] ?? null, count: v.items };
      bumpedAt.current = -1;
      ask();
    }
  };

  return (
    <div className={`hfy-capped ${className}`.trim()} data-hfy-capped data-steps={steps}>
      <div className="hfy-capped__body" ref={body}>{children}</div>
      {showButton && (
        <div className="hfy-capped__bar">
          <button type="button" className="hfy-btn hfy-capped__more" onClick={onClick} aria-disabled={loading ? "true" : undefined} data-hfy-capped-more>{loading ? "loading…" : label}</button>
        </div>
      )}
    </div>
  );
}
