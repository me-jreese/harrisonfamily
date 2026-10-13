// axe-core in the Playwright specs (HFY-TSK-091; HFY-PLN-002 surfaces §13: "every spec runs axe, zero serious or critical").
// The engine is the pinned devDependency axe-core, injected from node_modules (no network). Not a spec itself: the specs import it.
import { createRequire } from "node:module";

const AXE = createRequire(import.meta.url).resolve("axe-core/axe.min.js");

/**
 * The serious and critical violations on the page (or inside `include`, a CSS selector), as short strings `<rule> <impact>: <targets>`.
 * Moderate and minor findings are not failures here (the DS audit gate is serious/critical).
 */
export async function axeViolations(page, { include = null, impacts = ["serious", "critical"] } = {}) {
  if (!(await page.evaluate(() => Boolean(window.axe)))) await page.addScriptTag({ path: AXE });
  const found = await page.evaluate(async (sel) => {
    const r = await window.axe.run(sel ? { include: [[sel]] } : document, { resultTypes: ["violations"] });
    return r.violations.map((v) => ({ id: v.id, impact: v.impact, targets: v.nodes.slice(0, 4).map((n) => n.target.join(" ")) }));
  }, include);
  return found.filter((v) => impacts.includes(v.impact)).map((v) => `${v.id} ${v.impact}: ${v.targets.join(", ")}`);
}
