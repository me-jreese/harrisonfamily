// HFY-TSK-379 pass 1: the hourglass tree's contrast, computed from the token values (no browser). The design adds four colour roles that alias
// existing ones (tree.edge and tree.line = border.strong, tree.repeat = accent.secondary, tree.ground = surface.sunken; DIGEST section 1) and
// states the ink pairs of the seven tree roles in guide/05-theme-qa.md. This reads the pinned @io-kit/tokens theme, resolves every var() chain
// for the dark theme (the default) and the daylight one, and checks:
//   - the non-text marks (edge, line, repeat) against ground, surface and raised are at least 3:1 (WCAG 2.2 1.4.11);
//   - the ink on each of the seven role fills is at least 4.5:1 (a node label), and the ratios the design system states for them hold.
// When the pinned package one day defines the tree.* roles itself, they must resolve to the same colours as the aliases used here.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { NON_TEXT_MIN, contrast, parseColor } from "./contrast.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const css = readFileSync(join(here, "..", "node_modules", "@io-kit", "tokens", "dist", "harrisonfamily", "theme.css"), "utf8").replace(/\/\*[\s\S]*?\*\//g, "");

function declarations(selectorStart) {
  const out = new Map();
  for (const m of css.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
    if (!m[1].trim().startsWith(selectorStart)) continue;
    for (const d of m[2].matchAll(/(--[\w-]+)\s*:\s*([^;]+);/g)) out.set(d[1], d[2].trim());
  }
  return out;
}

// The dark theme is the default (:root); the daylight block overrides what differs, so it is read over the dark one.
const dark = declarations(':root, [data-theme="dark"]');
const THEMES = { dark, light: new Map([...dark, ...declarations('[data-theme="light"]')]) };

/** The colour a --io-color-semantic-<role> (or palette) property resolves to in a theme, following var() chains. */
function resolve(theme, name, depth = 0) {
  assert.ok(depth < 8, `a var() chain for ${name} does not end`);
  const raw = THEMES[theme].get(name);
  assert.ok(raw !== undefined, `${name} is not defined in the ${theme} theme`);
  const ref = /^var\((--[\w-]+)\)$/.exec(raw);
  return ref ? resolve(theme, ref[1], depth + 1) : raw;
}
const color = (theme, role) => parseColor(resolve(theme, `--io-color-semantic-${role}`));
const ratio = (theme, a, b) => contrast(color(theme, a), color(theme, b));

/** The new roles of DIGEST section 1, as the existing role each aliases. */
const ALIAS = { edge: "border-strong", line: "border-strong", repeat: "accent-secondary", ground: "surface-sunken" };

for (const theme of Object.keys(THEMES)) {
  test(`${theme}: tree.edge, tree.line and tree.repeat are at least 3:1 against ground, surface and raised`, () => {
    for (const mark of ["edge", "line", "repeat"]) {
      for (const ground of [ALIAS.ground, "surface", "surface-raised"]) {
        const r = ratio(theme, ALIAS[mark], ground);
        assert.ok(r >= NON_TEXT_MIN, `${theme}: tree.${mark} (${ALIAS[mark]}) on ${ground} is ${r.toFixed(2)}:1, under ${NON_TEXT_MIN}:1`);
      }
    }
  });

  test(`${theme}: a tree.* role the pinned package defines resolves to the colour its alias gives`, () => {
    for (const [role, alias] of Object.entries(ALIAS)) {
      if (!THEMES[theme].has(`--io-color-semantic-tree-${role}`)) continue;
      assert.deepEqual(color(theme, `tree-${role}`), color(theme, alias), `tree.${role} must alias ${alias}`);
    }
  });
}

// The ratios the design states (T-Spec section "tokens", DIGEST section 1): edge and line on the three grounds, repeat on sunken and surface.
const STATED_MARKS = [
  // [theme, mark, ground, stated]
  ["dark", "edge", "surface-sunken", 4.45], ["dark", "edge", "surface", 4.25], ["dark", "edge", "surface-raised", 3.78],
  ["light", "edge", "surface-sunken", 3.23], ["light", "edge", "surface", 3.74], ["light", "edge", "surface-raised", 4.08],
  ["dark", "repeat", "surface-sunken", 11.99], ["light", "repeat", "surface-sunken", 3.95], ["light", "repeat", "surface", 4.58]
];
test("the ratios the design states for the marks hold (to the printed two decimals)", () => {
  for (const [theme, mark, ground, stated] of STATED_MARKS) {
    const r = ratio(theme, ALIAS[mark], ground);
    assert.ok(Math.abs(r - stated) <= 0.011, `${theme}: tree.${mark} on ${ground} is ${r.toFixed(2)}:1, the design states ${stated}:1`);
  }
});

// guide/05-theme-qa.md, "accent.text on tree.focus" down to "text on tree.grandchild": [role, dark ratio, daylight ratio]; the floor is 4.5:1.
const INK = [
  ["focus", 8.24, 6.22], ["parent", 6.23, 6.23], ["grandparent", 9.14, 12.64], ["sibling", 11.46, 11.46],
  ["spouse", 6.22, 5.95], ["child", 13.74, 17.34], ["grandchild", 11.43, 15.56]
];
const NODE_LABEL_MIN = 4.5;

for (const [role, darkStated, lightStated] of INK) {
  for (const [theme, stated] of [["dark", darkStated], ["light", lightStated]]) {
    test(`${theme}: the ink on tree.${role} is at least ${NODE_LABEL_MIN}:1 and matches the stated ${stated}:1`, () => {
      const r = ratio(theme, `tree-${role}-ink`, `tree-${role}`);
      assert.ok(r >= NODE_LABEL_MIN, `${theme}: tree.${role} ink is ${r.toFixed(2)}:1, under ${NODE_LABEL_MIN}:1`);
      assert.ok(Math.abs(r - stated) <= 0.011, `${theme}: tree.${role} ink is ${r.toFixed(2)}:1, the design system states ${stated}:1`);
    });
  }
}

test("the card edge makes the boundary: every role fill that is under 3:1 on the ground is covered by the 3:1 edge", () => {
  // Eight of the fourteen role fills are under 3:1 against the ground (DIGEST section 2), which is why every card has a 2 px tree.edge outline.
  for (const theme of Object.keys(THEMES)) {
    let under = 0;
    for (const [role] of INK) {
      if (ratio(theme, `tree-${role}`, ALIAS.ground) < NON_TEXT_MIN) {
        under += 1;
        assert.ok(ratio(theme, ALIAS.edge, ALIAS.ground) >= NON_TEXT_MIN, `${theme}: tree.${role} needs the edge, and the edge is under ${NON_TEXT_MIN}:1`);
      }
    }
    assert.ok(under > 0, `${theme}: no role fill is under 3:1 on the ground, so the edge would not be needed (the design's premise changed)`);
  }
});
