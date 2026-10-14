// DVP-TSK-A73: @io-kit/shell, @io-kit/content and @io-kit/notify read Enceladus short variables (--bg, --fg, --space-2, ...)
// instead of their --io-* contracts. src/theme/10-kit-aliases.css maps every one of them to a harrisonfamily token in a single
// html:root block. This test re-derives the read set from the installed kit CSS, so a kit bump that starts reading a new short
// name fails here instead of silently painting with no value (or the Enceladus look).
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const islandsDir = join(dirname(fileURLToPath(import.meta.url)), "..");
const kit = (p) => join(islandsDir, "node_modules", "@io-kit", p);
const SOURCES = ["shell/dist/io-kit.css", "content/src/content.css", "notify/src/notify.css"];
const aliasesPath = join(islandsDir, "src", "theme", "10-kit-aliases.css");
const stripComments = (css) => css.replace(/\/\*[\s\S]*?\*\//g, "");

function shortReads(css) {
  return new Set([...stripComments(css).matchAll(/var\(\s*(--[\w-]+)/g)].map((m) => m[1]).filter((n) => !n.startsWith("--io-")));
}

function aliasBlock() {
  const css = stripComments(readFileSync(aliasesPath, "utf8"));
  const blocks = [...css.matchAll(/([^{}]+)\{([^{}]*)\}/g)];
  assert.equal(blocks.length, 1, "10-kit-aliases.css holds exactly one block");
  assert.equal(blocks[0][1].trim(), "html:root", "the block is html:root (specificity 0,1,1 beats any :root declaration)");
  const decls = new Map();
  for (const m of blocks[0][2].matchAll(/(--[\w-]+)\s*:\s*([^;]+);/g)) decls.set(m[1], m[2].trim());
  return decls;
}

test("every short variable the kit CSS reads is mapped in 10-kit-aliases.css", () => {
  const reads = new Set();
  for (const src of SOURCES) for (const n of shortReads(readFileSync(kit(src), "utf8"))) reads.add(n);
  assert.ok(reads.size > 0, "found no short-variable reads: has DVP-TSK-A73 shipped? then delete 10-kit-aliases.css and this test");
  const declared = aliasBlock();
  const missing = [...reads].filter((n) => !declared.has(n)).sort();
  assert.deepEqual(missing, [], `unmapped kit reads (add them to src/theme/10-kit-aliases.css): ${missing.join(", ")}`);
});

test("every alias is a single var() of an --io-* token (no literals, no short-name chains)", () => {
  for (const [name, value] of aliasBlock()) {
    assert.match(value, /^var\(--io-[\w-]+\)$/, `${name}: ${value}`);
  }
});

test("the aliases follow the A73 mapping", () => {
  const d = aliasBlock();
  const want = {
    "--bg": "--io-color-semantic-surface",
    "--bg-surface": "--io-color-semantic-surface-raised",
    "--bg-surface-alt": "--io-color-semantic-surface-raised",
    "--fg": "--io-color-semantic-text",
    "--fg-muted": "--io-color-semantic-text-dim",
    "--accent": "--io-color-semantic-accent",
    "--accent-hover": "--io-color-semantic-link-hover",
    "--border": "--io-color-semantic-border",
    "--danger": "--io-color-semantic-danger",
    "--font-body": "--io-typography-font-ui",
    "--font-heading": "--io-typography-font-display",
    "--font-display": "--io-typography-font-display",
    "--font-mono": "--io-typography-font-mono",
    "--radius-sm": "--io-radius-sm",
    "--radius-md": "--io-radius-md",
    "--radius-lg": "--io-radius-lg",
    "--space-1": "--io-space-1",
    "--space-2": "--io-space-2",
    "--space-3": "--io-space-3",
    "--space-12": "--io-space-8",
    "--text-xs": "--io-typography-size-sm",
    "--text-sm": "--io-typography-size-sm",
    "--text-base": "--io-typography-size-md",
    "--dur-base": "--io-motion-duration-base",
    "--ease-orbit": "--io-motion-easing-standard"
  };
  for (const [name, token] of Object.entries(want)) assert.equal(d.get(name), `var(${token})`, name);
});

test("every aliased token exists in the harrisonfamily theme", () => {
  const theme = readFileSync(kit("tokens/dist/harrisonfamily/theme.css"), "utf8");
  for (const [name, value] of aliasBlock()) {
    const token = value.slice(4, -1);
    assert.match(theme, new RegExp(`${token}\\s*:`), `${name} -> ${token} is not declared by @io-kit/tokens harrisonfamily theme.css`);
  }
});

test("the root-cause comment names the packages, DVP-TSK-A73 and the deletion condition", () => {
  const src = readFileSync(aliasesPath, "utf8");
  for (const s of ["DVP-TSK-A73", "@io-kit/shell 0.6.6", "@io-kit/content 0.3.1", "@io-kit/notify 0.4.0", "DELETE"]) assert.ok(src.includes(s), s);
  const pkg = (p) => JSON.parse(readFileSync(kit(`${p}/package.json`), "utf8")).version;
  assert.deepEqual([pkg("shell"), pkg("content"), pkg("notify")], ["0.6.6", "0.3.1", "0.4.0"], "kit versions changed: re-check A73 and update the comment");
});
