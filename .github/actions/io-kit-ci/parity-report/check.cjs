// @io-kit/ci 0.1.3 rendered — do not edit; sha256:eb8ec699518d101de8d21c857929ac1c07848943da32a125b5961f49caa8fe1f
"use strict";
// io-kit-ci pipeline-drift check. Zero dependencies (Node built-ins only) so a consumer can run the vendored copy
// with no CI-time npm/registry access. This file is the single source: the io-kit-ci CLI requires it, and
// `io-kit-ci render` vendors it (with the rendered header) next to the parity-report action.
const { createHash } = require("node:crypto");
const { existsSync, readdirSync, readFileSync, statSync } = require("node:fs");
const { join, relative, resolve } = require("node:path");

const ACTIONS_DIR = ".github/actions/io-kit-ci";
const WORKFLOWS_DIR = ".github/workflows";
const HEADER_RE = /^(?:#|\/\/) @io-kit\/ci (\S+) rendered \u2014 do not edit; sha256:([0-9a-f]{64})$/;

const DEPLOY_PATTERNS = [
  /\baws\s+s3\s+sync\b/,
  /\baws\s+lambda\s+(update-function-code|update-function-configuration|publish-version|update-alias)\b/,
  /\baws\s+cloudfront\s+(create-invalidation|update-function|publish-function)\b/,
];

const hashBody = (body) => createHash("sha256").update(body, "utf8").digest("hex");

function splitHeader(content) {
  const nl = content.indexOf("\n");
  if (nl === -1) return { match: null, body: content };
  return { match: content.slice(0, nl).match(HEADER_RE), body: content.slice(nl + 1) };
}

function walk(dir, out) {
  if (!existsSync(dir)) return;
  for (const name of readdirSync(dir).sort()) {
    const abs = join(dir, name);
    if (statSync(abs).isDirectory()) walk(abs, out);
    else if (/\.(ya?ml|cjs)$/.test(name)) out.push(abs);
  }
}

const stripComments = (text) =>
  text
    .split("\n")
    .filter((l) => !/^\s*#/.test(l))
    .join("\n");

/** Compare every workflow/action file under `root/.github` with the kit contract. */
function checkRepo(root) {
  const files = [];
  walk(join(root, WORKFLOWS_DIR), files);
  walk(join(root, ".github/actions"), files);
  const drift = [];
  for (const abs of files) {
    const rel = relative(root, abs).split("\\").join("/");
    const { match, body } = splitHeader(readFileSync(abs, "utf8"));
    const kitPath = rel.startsWith(`${ACTIONS_DIR}/`) || /^\.github\/workflows\/io-kit-[^/]*$/.test(rel);
    if (match) {
      if (hashBody(body) !== match[2]) drift.push({ file: rel, reason: "hand_edit" });
    } else if (kitPath) {
      drift.push({ file: rel, reason: "missing_header" });
    } else if (/\.ya?ml$/.test(rel) && DEPLOY_PATTERNS.some((p) => p.test(stripComments(body)))) {
      drift.push({ file: rel, reason: "deploy_outside_kit" });
    }
  }
  return drift;
}

/** CLI entry: prints the same lines as `io-kit-ci check`; returns the exit code (0 clean, 1 drift, 2 error). */
function main(argv, out, err) {
  try {
    let root = ".";
    for (let i = 0; i < argv.length; i++) {
      const a = argv[i];
      if (a === "--root" && i + 1 < argv.length) root = argv[++i];
      else if (a.startsWith("--root=")) root = a.slice(7);
      else throw new Error(`unexpected argument '${a}'`);
    }
    const drift = checkRepo(resolve(root));
    for (const d of drift) {
      out(`pipeline_drift: ${d.file}`);
      err(`  ${d.file}: ${d.reason}`);
    }
    return drift.length ? 1 : 0;
  } catch (e) {
    err(`io-kit-ci: ${e.message}`);
    return 2;
  }
}

module.exports = { checkRepo, hashBody, splitHeader, main, HEADER_RE, ACTIONS_DIR, WORKFLOWS_DIR };

if (require.main === module) {
  process.exitCode = main(process.argv.slice(2), (l) => process.stdout.write(`${l}\n`), (l) => process.stderr.write(`${l}\n`));
}
