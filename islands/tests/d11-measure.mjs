// The D-11 measurements, shared by the editing audit (edit-d11-audit.spec.mjs, HFY-TSK-282) and the tagging audit (tag-edit-d11-audit.spec.mjs, HFY-TSK-283).
// Run in the page: `page.evaluate(`(${MEASURE.toString()})()`)`.
/** The D-11 measurements, run in the page: a list of findings (empty when the state is clean). */
export const MEASURE = () => {
  const out = [];
  const visible = (e) => {
    const r = e.getBoundingClientRect();
    if (r.width === 0 || r.height === 0) return false;
    for (let n = e; n && n.nodeType === 1; n = n.parentElement) {
      const cs = getComputedStyle(n);
      if (cs.display === "none" || cs.visibility === "hidden") return false;
      if (n.tagName === "DIALOG" && !n.open) return false;
    }
    return true;
  };
  const name = (e) => `${e.tagName.toLowerCase()}${e.id ? `#${e.id}` : ""}${e.getAttribute("name") ? `[name=${e.getAttribute("name")}]` : ""} "${(e.getAttribute("aria-label") || e.textContent || e.value || "").trim().slice(0, 24)}"`;
  const fields = [...document.querySelectorAll("input:not([type=hidden]):not([type=checkbox]):not([type=radio]), textarea, select")].filter(visible);
  for (const f of fields) if (parseFloat(getComputedStyle(f).fontSize) < 16) out.push(`input under 16px: ${name(f)} ${getComputedStyle(f).fontSize}`);
  // targets: buttons, fields, summaries, links that are not inside a sentence; a checkbox or radio is its label
  const targets = [...document.querySelectorAll("button, summary, [role=button], a[href], input:not([type=hidden]), textarea, select")].filter(visible);
  const measured = [];
  for (const t of targets) {
    let el = t;
    if (t.matches("input[type=checkbox], input[type=radio]")) el = t.closest("label") || document.querySelector(`label[for="${t.id}"]`) || t;
    if (t.tagName === "A") {
      const p = t.parentElement;
      const inline = getComputedStyle(t).display === "inline" && p && (p.textContent || "").replace(t.textContent, "").trim().length > 0; // other words around it
      if (inline) continue; // WCAG 2.5.8: a link inside a sentence is exempt
    }
    const r = el.getBoundingClientRect();
    measured.push({ el: t, r });
    if (r.height < 43.5 || r.width < 43.5) out.push(`target under 44px: ${name(t)} ${Math.round(r.width)}x${Math.round(r.height)}`);
    if (t.matches("[data-hfy-choice]") && r.height < 55.5) out.push(`wizard choice under 56px: ${name(t)} ${Math.round(r.height)}`); // editing.md: choice targets are 56px
  }
  // one control height per row: controls in the same flex or grid container whose vertical centres sit within 3px of each other share a row
  const rowOf = (e) => { for (let n = e.parentElement; n; n = n.parentElement) { const d = getComputedStyle(n).display; if (d.includes("flex") || d.includes("grid")) return n; } return document.body; };
  const ctl = measured.filter((m) => m.el.matches("button, select, input:not([type=checkbox]):not([type=radio]), [role=button]"));
  const rows = [];
  for (const m of ctl.sort((a, b) => a.r.top + a.r.height / 2 - (b.r.top + b.r.height / 2))) {
    const c = m.r.top + m.r.height / 2;
    const row = rows.find((x) => Math.abs(x.c - c) <= 3 && rowOf(x.items[0].el) === rowOf(m.el));
    if (row) row.items.push(m); else rows.push({ c, items: [m] });
  }
  for (const row of rows) {
    const hs = row.items.filter((i) => i.r.left >= 0).map((i) => Math.round(i.r.height));
    if (hs.length > 1 && Math.max(...hs) - Math.min(...hs) > 1) out.push(`mixed control heights in one row: ${row.items.map((i) => `${name(i.el)} ${Math.round(i.r.height)}`).join("; ")}`);
  }
  const de = document.documentElement;
  if (de.scrollWidth > de.clientWidth) out.push(`horizontal scroll: ${de.scrollWidth} > ${de.clientWidth}`);
  return out;
};
