// docs/reference/sync-errors.md must name every exit code of the addon and every error code of the sync API (HFY-TSK-155).
// It reads sources and docs only: no network, no table.
import { describe, expect, it } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repo = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const read = (p) => readFileSync(join(repo, p), "utf8");
const page = read("docs/reference/sync-errors.md");

/** The exit codes: every `EXIT_<NAME> = <n>` of the addon's consts.py. */
export function exitCodes(src) {
  return [...src.matchAll(/^(EXIT_[A-Z_]+)\s*=\s*(\d+)\s*$/gm)].map((m) => ({ name: m[1], code: m[2] }));
}

/** The API error codes: a 4xx/5xx status followed by a quoted code, also as either arm of a ternary, in api/src/sync. */
export function apiCodes(files) {
  const out = new Map();
  for (const [file, src] of files) {
    for (const m of src.matchAll(/\b([45]\d\d)\s*,\s*(?:[\w.]+\s*\?\s*"([a-z_]+)"\s*:\s*)?"([a-z_]+)"/g)) {
      for (const code of [m[2], m[3]].filter(Boolean)) out.set(`${m[1]} ${code}`, file);
    }
  }
  return out;
}

// Reach: the sync API's codes live in api/src/sync (the test below pins that no sync-only code is thrown elsewhere in api/src). The web API's own
// codes (api/src/records, routes.js and the rest) are documented in their route summaries, not on this page. Codes built in a variable or
// thrown through a helper are outside the grep; the count floor in the first test guards against the grep going quiet.
const syncFiles = readdirSync(join(repo, "api/src/sync")).filter((f) => f.endsWith(".js")).map((f) => [f, read(`api/src/sync/${f}`)]);

describe("docs/reference/sync-errors.md", () => {
  it("finds the exit codes and the API codes in the sources (the greps are not empty)", () => {
    expect(exitCodes(read("gramps/hfygramps/addon/consts.py")).length).toBeGreaterThanOrEqual(10);
    expect(apiCodes(syncFiles).size).toBeGreaterThanOrEqual(40);
    expect([...apiCodes(syncFiles).keys()]).toEqual(expect.arrayContaining(["409 exists", "409 version_conflict", "503 sync_paused"]));
  });

  it("keeps the sync-only codes inside api/src/sync (the grep's reach)", () => {
    const walk = (d) => readdirSync(join(repo, d), { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? walk(`${d}/${e.name}`) : e.name.endsWith(".js") ? [`${d}/${e.name}`] : []));
    const strays = walk("api/src").filter((f) => !f.startsWith("api/src/sync/") && /[45]\d\d\s*,\s*"(sync_[a-z_]+|tree_mismatch|store_not_seeded|seed_[a-z_]+)"/.test(read(f)));
    expect(strays).toEqual([]);
  });

  it("names every exit code of the addon, with its constant", () => {
    const missing = exitCodes(read("gramps/hfygramps/addon/consts.py")).filter(({ name, code }) => !new RegExp(`\\|\\s*\`${code}\`\\s*\\|\\s*\`${name}\``).test(page));
    expect(missing).toEqual([]);
  });

  it("names every API error code with its status", () => {
    const missing = [...apiCodes(syncFiles).keys()].filter((key) => {
      const [status, code] = key.split(" ");
      return !new RegExp(`\\|\\s*${status}\\s*\\|\\s*\`${code}\``).test(page);
    });
    expect(missing).toEqual([]);
  });

  it("lists the catalog rows D44 to D52 and S19 to S22", () => {
    const ids = [];
    for (let n = 44; n <= 52; n++) ids.push(`D${n}`);
    for (let n = 19; n <= 22; n++) ids.push(`S${n}`);
    expect(ids.filter((id) => !new RegExp(`^\\|\\s*${id}\\s*\\|`, "m").test(page))).toEqual([]);
  });
});

describe("the sync runbook page", () => {
  const howto = read("docs/how-to/sync-gramps-with-the-website.md");
  it("states the agent-session rule, the go-ahead rule and the expunge limits", () => {
    expect(howto.toLowerCase()).toContain("never paste previews, backups or logs other than `status.json` into an agent session");
    expect(howto).toMatch(/Every production use of `api\/scripts\/sync-admin\.mjs`[\s\S]{0,120}?needs io's go-ahead/);
    expect(howto).toContain("72-hour");
    expect(howto).toContain("35-day");
  });
  it("carries the amended runbook steps", () => {
    for (const needle of ["G-seed", "close every Gramps edit window", "--yes --plan <run_id>", "hfy-sync restore", "pause --all", "rebuild-heads --to-seq N", "never swaps `TABLE_NAME`"]) {
      expect(howto.toLowerCase()).toContain(needle.toLowerCase());
    }
  });
});
