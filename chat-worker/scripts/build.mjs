// Builds chat-worker/dist/ (the committed bundle) and checks that it is fresh.
//
//   node scripts/build.mjs            wrangler deploy --dry-run --outdir dist, then dist/deploy.json from wrangler.toml
//   node scripts/build.mjs --check    the same build in a temp directory; exit 1 when dist/ differs (missing, stale or extra)
//
// dist/ is committed output (HFY-R58), like 11ty/js/islands/: CI cannot install @io-kit/chat and installs no npm package
// (HFY-R14, HFY-R62). Rebuild with a CodeArtifact token and commit dist/ with every change to src/, package.json, the
// lockfile, wrangler.toml or shared/privacy-guard.mjs (the guard is bundled into the Worker).
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const distDir = join(root, "dist");
const MAIN = "index.js";

/** wrangler bundles src/index.mjs into `out` (no network, no login). */
function wranglerBundle(out) {
  const wrangler = join(root, "node_modules", ".bin", "wrangler");
  const r = spawnSync(wrangler, ["deploy", "--dry-run", "--outdir", out, "--config", join(root, "wrangler.toml")], {
    cwd: root,
    encoding: "utf8",
    env: {
      ...process.env,
      CI: "1",
      WRANGLER_SEND_METRICS: "false",
      WRANGLER_LOG_PATH: join(out, "..", ".wrangler-logs"),
      NO_COLOR: "1",
    },
  });
  if (r.status !== 0) {
    process.stderr.write(`${r.stdout}\n${r.stderr}\n`);
    throw new Error("wrangler deploy --dry-run failed");
  }
}

function sha256(buf) {
  return createHash("sha256").update(buf).digest("hex");
}

/** dist/deploy.json: what the cloudflare-worker target of @io-kit/ci uploads, taken from wrangler.toml (production only). */
async function deployDescriptor() {
  const { unstable_readConfig } = await import("wrangler");
  const cfg = unstable_readConfig({ config: join(root, "wrangler.toml") });
  const migrations = cfg.migrations ?? [];
  if (migrations.length !== 1 || migrations[0].tag !== "v1") throw new Error("wrangler.toml: expected the single migration v1");
  return {
    name: cfg.name,
    main_module: MAIN,
    compatibility_date: cfg.compatibility_date,
    compatibility_flags: cfg.compatibility_flags ?? [],
    bindings: (cfg.durable_objects?.bindings ?? []).map((b) => ({ type: "durable_object_namespace", name: b.name, class_name: b.class_name })),
    vars: cfg.vars ?? {},
    migrations: { new_tag: migrations[0].tag, new_sqlite_classes: migrations[0].new_sqlite_classes },
    routes: (cfg.routes ?? []).map((r) => r.pattern),
    observability: { enabled: cfg.observability?.enabled === true },
    workers_dev: cfg.workers_dev === true,
  };
}

/** Build into `out` and return `{ relativePath: Buffer }` of what dist/ must hold. */
async function build(out) {
  rmSync(out, { recursive: true, force: true });
  mkdirSync(out, { recursive: true });
  wranglerBundle(out);
  const files = {};
  for (const f of walk(out)) {
    const rel = relative(out, f).split("\\").join("/");
    if (rel === "README.md" || rel.endsWith(".map")) continue; // wrangler's own notes and sourcemaps are not uploaded
    files[rel] = readFileSync(f);
  }
  if (!files[MAIN]) throw new Error(`wrangler produced no ${MAIN} (got ${Object.keys(files).join(", ")})`);
  const d = await deployDescriptor();
  d.bundle = { file: MAIN, sha256: sha256(files[MAIN]) };
  files["deploy.json"] = Buffer.from(`${JSON.stringify(d, null, 2)}\n`);
  return files;
}

function walk(dir) {
  const out = [];
  if (!existsSync(dir)) return out;
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) out.push(...walk(p));
    else out.push(p);
  }
  return out.sort();
}

const check = process.argv.includes("--check");
const scratch = mkdtempSync(join(tmpdir(), "hfy-chat-worker-"));
try {
  const files = await build(join(scratch, "out"));
  if (!check) {
    rmSync(distDir, { recursive: true, force: true });
    for (const [rel, buf] of Object.entries(files)) {
      mkdirSync(dirname(join(distDir, rel)), { recursive: true });
      writeFileSync(join(distDir, rel), buf);
    }
    console.log(`chat-worker/dist written: ${Object.keys(files).join(", ")} (bundle sha256 ${sha256(files[MAIN]).slice(0, 12)})`);
  } else {
    const have = {};
    for (const f of walk(distDir)) have[relative(distDir, f).split("\\").join("/")] = readFileSync(f);
    const problems = [];
    for (const [rel, buf] of Object.entries(files)) {
      if (!have[rel]) problems.push(`missing: ${rel}`);
      else if (!have[rel].equals(buf)) problems.push(`stale: ${rel}`);
    }
    for (const rel of Object.keys(have)) if (!files[rel]) problems.push(`extra: ${rel}`);
    if (problems.length) {
      console.error(`chat-worker/dist is not fresh:\n  ${problems.join("\n  ")}\nRun: cd chat-worker && npm ci && npm run build, then commit dist/.`);
      process.exitCode = 1;
    } else {
      console.log(`chat-worker/dist is fresh (${Object.keys(files).join(", ")})`);
    }
  }
} finally {
  rmSync(scratch, { recursive: true, force: true });
}
