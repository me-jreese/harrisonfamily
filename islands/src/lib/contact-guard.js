// The R-18 pre-check in the post and comment composers (HFY-PLN-002 BRD2 5.3, task privacy-guard-existing-paths AC2). The same
// detector the API runs, shared/privacy-guard.mjs, bundled here; UX only, because the API's 422 is the authority (D2-09).
//
// While a composer field holds a hit: the span is highlighted (a mark layer drawn over the field, which never touches its text),
// the field is aria-invalid with the DS copy in a line under it, and the form's submit button is disabled. A submit that still
// gets through (Enter in a one-row comment box, implicit submission) is stopped, and the first span is selected. The text is
// always kept: nothing here writes a field's value, and the copy stays until the member removes the hit (no override).
//
// The kits own the composer DOM (@io-kit/content 0.1.1 PostComposer, @io-kit/comments 0.1.0 Composer) and offer no validation or
// disabled prop, so this decorates it from outside, as my-posts.jsx and comments-ui.jsx already do for placeholders. Upstream:
// a composer `validate(text) -> {message, spans}` prop; then delete this module's DOM work and keep precheck().
// The verdict itself (and the DOB switch the page learns from the API) is lib/contact-precheck.js.
import { mergeSpans, onKindsChange, precheck } from "./contact-precheck.js";
import "../guard.css";

export { GUARD_CODES, GUARD_COPY, learnFromRefusal, mergeSpans, precheck, precheckAll } from "./contact-precheck.js";

// Text metrics the mark layer copies from its field, so each mark lands on the characters it covers.
const METRICS = [
  "boxSizing", "fontFamily", "fontSize", "fontWeight", "fontStyle", "fontStretch", "fontVariantLigatures", "fontFeatureSettings",
  "letterSpacing", "wordSpacing", "lineHeight", "textTransform", "textIndent", "textAlign", "tabSize", "direction",
  "paddingTop", "paddingBottom", "paddingLeft", "borderTopWidth", "borderRightWidth", "borderBottomWidth", "borderLeftWidth",
];
let seq = 0;

/**
 * Decorates every field under `root` matching `fields` (textarea or input selector). `submitOf(form)` is the form's submit
 * button; `enabledOf(form)` says whether the kit would enable it (used when a hit is removed). Returns a disposer.
 */
export function watchContactGuard(root, { fields, submitOf, enabledOf = () => true }) {
  if (!root || typeof MutationObserver === "undefined") return () => {};
  const state = new Map(); // field -> { verdict, layer, msg }
  const blocked = new Set(); // forms with a hit

  const ro = typeof ResizeObserver === "undefined" ? null : new ResizeObserver(() => reposition());
  const anchorOf = (field) => field.closest(".iok-content-field, .iok-content-attachment, .io-comments-row") || field;
  const single = (field) => field.tagName === "INPUT";

  function place(field, layer) {
    const cs = getComputedStyle(field);
    for (const p of METRICS) layer.style[p] = cs[p];
    const scrollbar = Math.max(0, field.offsetWidth - field.clientWidth - parseFloat(cs.borderLeftWidth) - parseFloat(cs.borderRightWidth));
    layer.style.paddingRight = `${parseFloat(cs.paddingRight) + scrollbar}px`;
    layer.style.top = `${field.offsetTop}px`;
    layer.style.left = `${field.offsetLeft}px`;
    layer.style.width = `${field.offsetWidth}px`;
    layer.style.height = `${field.offsetHeight}px`;
    layer.scrollTop = field.scrollTop;
    layer.scrollLeft = field.scrollLeft;
  }

  function paint(field, s) {
    const { verdict } = s;
    if (!s.layer) {
      s.layer = document.createElement("div");
      s.layer.className = "hfy-guard__layer";
      s.layer.setAttribute("aria-hidden", "true");
      s.layer.setAttribute("data-hfy-guard-layer", "");
      if (single(field)) s.layer.setAttribute("data-single", "");
      field.insertAdjacentElement("afterend", s.layer);
    }
    const text = field.value;
    const frag = document.createDocumentFragment();
    let at = 0;
    for (const { start, end } of mergeSpans(verdict.spans)) {
      if (start > at) frag.append(text.slice(at, start));
      const mark = document.createElement("mark");
      mark.className = "hfy-guard__mark";
      mark.setAttribute("data-hfy-guard-mark", "");
      mark.textContent = text.slice(start, end);
      frag.append(mark);
      at = end;
    }
    frag.append(text.slice(at) + (single(field) ? "" : "​")); // keeps a trailing newline's line in a textarea
    s.layer.replaceChildren(frag);
    place(field, s.layer);
    if (!s.msg) {
      s.msg = document.createElement("p");
      s.msg.className = "hfy-guard__msg";
      s.msg.id = `hfy-guard-${(seq += 1)}`;
      s.msg.setAttribute("data-hfy-guard-msg", "");
      s.msg.setAttribute("aria-live", "polite");
      anchorOf(field).insertAdjacentElement("afterend", s.msg);
    }
    if (s.msg.textContent !== verdict.message) s.msg.textContent = verdict.message;
    field.setAttribute("aria-invalid", "true");
    field.setAttribute("data-hfy-guard-invalid", "");
    const described = (field.getAttribute("aria-describedby") || "").split(/\s+/).filter(Boolean);
    if (!described.includes(s.msg.id)) field.setAttribute("aria-describedby", [...described, s.msg.id].join(" "));
  }

  function clear(field, s) {
    s.layer?.remove();
    s.msg?.remove();
    if (s.msg) {
      const rest = (field.getAttribute("aria-describedby") || "").split(/\s+/).filter((id) => id && id !== s.msg.id);
      if (rest.length) field.setAttribute("aria-describedby", rest.join(" ")); else field.removeAttribute("aria-describedby");
    }
    field.removeAttribute("aria-invalid");
    field.removeAttribute("data-hfy-guard-invalid");
    s.layer = null;
    s.msg = null;
  }

  function syncForm(form) {
    if (!form) return;
    const hit = [...state].some(([f, s]) => s.verdict && form.contains(f));
    const button = submitOf(form);
    if (hit) {
      blocked.add(form);
      form.setAttribute("data-hfy-guard-blocked", "");
      if (button && !button.disabled) button.disabled = true;
    } else if (blocked.has(form)) {
      blocked.delete(form);
      form.removeAttribute("data-hfy-guard-blocked");
      if (button) button.disabled = !enabledOf(form);
    }
  }

  function scan(field) {
    let s = state.get(field);
    if (!s) {
      state.set(field, (s = { verdict: null, layer: null, msg: null }));
      ro?.observe(field); // a resized field (the window, a growing box) moves its marks
    }
    s.verdict = precheck(field.value);
    if (s.verdict) paint(field, s); else clear(field, s);
    syncForm(field.form || field.closest("form"));
  }

  function sweep() {
    for (const [field, s] of state) {
      if (field.isConnected) continue;
      clear(field, s);
      state.delete(field);
    }
    for (const form of blocked) if (!form.isConnected) blocked.delete(form);
    root.querySelectorAll(fields).forEach((f) => { if (!state.has(f)) scan(f); });
  }

  // A blocked form's submit, from any path, is stopped before the kit's React handler sees it, and the first span is selected.
  function firstHit(form) {
    for (const [field, s] of state) {
      if (!s.verdict || !form.contains(field)) continue;
      field.focus();
      try { field.setSelectionRange(s.verdict.spans[0].start, s.verdict.spans[0].end); } catch { /* not a text control */ }
      return;
    }
  }
  const stop = (e, form) => {
    e.preventDefault();
    e.stopPropagation();
    firstHit(form);
  };
  const onSubmit = (e) => { if (blocked.has(e.target)) stop(e, e.target); };
  const onKey = (e) => {
    const t = e.target;
    if (e.key !== "Enter" || e.shiftKey || e.isComposing || !(t instanceof Element) || !t.matches(fields)) return;
    const form = t.form || t.closest("form");
    if (form && blocked.has(form) && (t.tagName === "INPUT" || t.getAttribute("rows") === "1")) stop(e, form);
  };
  const onInput = (e) => { if (e.target instanceof Element && e.target.matches(fields)) scan(e.target); };
  const onScroll = (e) => { const s = state.get(e.target); if (s?.layer) { s.layer.scrollTop = e.target.scrollTop; s.layer.scrollLeft = e.target.scrollLeft; } };
  const reposition = () => { for (const [field, s] of state) if (s.layer) place(field, s.layer); };

  // The kit re-renders its submit button's disabled state from its own props; while the form is blocked, keep it disabled.
  const mo = new MutationObserver((records) => {
    let structural = false;
    for (const r of records) {
      if (r.type === "attributes" && r.target.disabled === false) {
        const form = r.target.form || r.target.closest("form");
        if (form && blocked.has(form) && submitOf(form) === r.target) r.target.disabled = true;
      } else if (r.type === "childList") structural = true;
    }
    if (structural) sweep();
  });
  mo.observe(root, { subtree: true, childList: true, attributes: true, attributeFilter: ["disabled"] });
  root.addEventListener("submit", onSubmit, true);
  root.addEventListener("keydown", onKey, true);
  root.addEventListener("input", onInput);
  root.addEventListener("scroll", onScroll, true);
  window.addEventListener("resize", reposition);
  const unlisten = onKindsChange(() => { for (const f of state.keys()) if (f.isConnected) scan(f); });
  sweep();

  return () => {
    unlisten();
    mo.disconnect();
    ro?.disconnect();
    root.removeEventListener("submit", onSubmit, true);
    root.removeEventListener("keydown", onKey, true);
    root.removeEventListener("input", onInput);
    root.removeEventListener("scroll", onScroll, true);
    window.removeEventListener("resize", reposition);
    for (const [field, s] of state) clear(field, s);
    state.clear();
    for (const form of blocked) form.removeAttribute("data-hfy-guard-blocked");
    blocked.clear();
  };
}
