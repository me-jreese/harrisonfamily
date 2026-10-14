// package-api-gen-caps-before-install: scripts/ci/package-api.sh must build on a clean checkout (no api/node_modules).
// Runs the real script against a temp copy of the repo with `npm` and `zip` shimmed on PATH: the npm shim stands in for
// the locked `npm ci` (links this checkout's installed packages into the stage), the zip shim records the file list.
import { describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import { chmodSync, cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { buildCaps } from "../src/routes.js";

const api = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const script = resolve(api, "../scripts/ci/package-api.sh");

describe("scripts/ci/package-api.sh", () => {
  it("generates caps.json inside the stage after npm ci, so a checkout without api/node_modules packages", async () => {
    const tmp = mkdtempSync(join(tmpdir(), "hfy-package-api-"));
    try {
      const root = join(tmp, "repo");
      mkdirSync(join(root, "scripts/ci"), { recursive: true });
      cpSync(script, join(root, "scripts/ci/package-api.sh"));
      for (const f of ["src", "scripts", "package.json", "package-lock.json"]) cpSync(join(api, f), join(root, "api", f), { recursive: true });
      cpSync(join(api, "../shared"), join(root, "shared"), { recursive: true });
      mkdirSync(join(root, "gramps/redaction"), { recursive: true });
      cpSync(join(api, "../gramps/redaction/redaction-v1.json"), join(root, "gramps/redaction/redaction-v1.json"));
      mkdirSync(join(root, "gramps/schema"), { recursive: true });
      cpSync(join(api, "../gramps/schema/gramps-6.0.6.schema.json"), join(root, "gramps/schema/gramps-6.0.6.schema.json"));
      writeFileSync(join(root, "api/.npmrc"), "# test stub\n");
      const bin = join(tmp, "bin");
      mkdirSync(bin);
      writeFileSync(join(bin, "npm"), `#!/bin/sh\n[ "$1" = ci ] || { echo "unexpected npm $*" >&2; exit 2; }\nln -s "${join(api, "node_modules")}" node_modules\n`);
      writeFileSync(join(bin, "zip"), `#!/bin/sh\n# zip -qr -X OUT .\nfind . -path ./node_modules -prune -o -type f -print | sort > "$3"\nmkdir -p "${join(tmp, "staged")}" && tar --exclude=./node_modules -cf - . | tar -xf - -C "${join(tmp, "staged")}"\n`);
      chmodSync(join(bin, "npm"), 0o755);
      chmodSync(join(bin, "zip"), 0o755);

      execFileSync("bash", [join(root, "scripts/ci/package-api.sh")], {
        env: { ...process.env, PATH: `${bin}:${process.env.PATH}`, CODEARTIFACT_AUTH_TOKEN: "test-token" },
        stdio: "pipe",
      });

      expect(existsSync(join(root, "api/node_modules"))).toBe(false); // nothing ran against the checkout's own node_modules
      const files = readFileSync(join(root, "dist/hfy-api.zip"), "utf8").trim().split("\n");
      expect(files).toEqual(expect.arrayContaining(["./dist/caps.json", "./src/index.js", "./src/presign.js", "./package.json"]));
      // shared/*.mjs is staged as real files (api/src/shared is a symlink in the checkout), never the tests or package.json
      const shared = readdirSync(join(api, "../shared")).filter((f) => f.endsWith(".mjs") && !f.endsWith(".test.mjs"));
      expect(shared.length).toBeGreaterThan(0);
      expect(files).toEqual(expect.arrayContaining(shared.map((f) => `./src/shared/${f}`)));
      expect(files.filter((f) => f.startsWith("./src/shared/") && !shared.includes(f.slice("./src/shared/".length)))).toEqual([]);
      expect(files.filter((f) => f.startsWith("./scripts/") || f === "./.npmrc" || f === "./package-lock.json")).toEqual([]);
      expect(files).toContain("./gramps/redaction/redaction-v1.json"); // the edit guard reads the policy beside src/
      expect(files).toContain("./gramps/schema/gramps-6.0.6.schema.json"); // the server validator reads the schema beside src/
      // The guard must find its policy in the PACKAGED layout (src/ at the stage root), not only in the checkout.
      symlinkSync(join(api, "node_modules"), join(tmp, "staged", "node_modules"));
      const staged = await import(/* @vite-ignore */ pathToFileURL(join(tmp, "staged", "src/records/guard.js")).href);
      expect(staged.loadPolicy().dates.dayMonthIndexes).toBeDefined();
      // ...and so must the server validator, which reads the policy and the schema from the same staged layout.
      const stagedSchema = await import(/* @vite-ignore */ pathToFileURL(join(tmp, "staged", "src/sync/schema.js")).href);
      expect(stagedSchema.loadSchema()["x-gramps"].gramps_version).toBe("6.0.6");
      const stagedValidator = await import(/* @vite-ignore */ pathToFileURL(join(tmp, "staged", "src/sync/validator.js")).href);
      expect(typeof stagedValidator.createValidator()).toBe("function");
      const caps = JSON.parse(readFileSync(join(root, "api/dist/caps.json"), "utf8"));
      expect(caps).toEqual(JSON.parse(JSON.stringify(buildCaps())));
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });
});
