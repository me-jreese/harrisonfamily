// scripts/ci/package-auth.sh stages shared/*.mjs as src/shared/ (auth/src/shared is a symlink in the checkout, which a zip must not carry).
// Runs the real script against a temp copy of the repo with `npm` and `zip` shimmed on PATH; the zip shim records the file list.
import { describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import { chmodSync, cpSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const auth = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const script = resolve(auth, "../scripts/ci/package-auth.sh");

describe("scripts/ci/package-auth.sh", () => {
  it("the zip lists src/shared/*.mjs as files, and no test or symlink", () => {
    const tmp = mkdtempSync(join(tmpdir(), "hfy-package-auth-"));
    try {
      const root = join(tmp, "repo");
      mkdirSync(join(root, "scripts/ci"), { recursive: true });
      cpSync(script, join(root, "scripts/ci/package-auth.sh"));
      for (const f of ["src", "edge.manifest.json", "package.json", "package-lock.json"]) cpSync(join(auth, f), join(root, "auth", f), { recursive: true });
      cpSync(join(auth, "../shared"), join(root, "shared"), { recursive: true });
      writeFileSync(join(root, "auth/.npmrc"), "# test stub\n");
      const bin = join(tmp, "bin");
      mkdirSync(bin);
      writeFileSync(join(bin, "npm"), `#!/bin/sh\n[ "$1" = ci ] || { echo "unexpected npm $*" >&2; exit 2; }\n`);
      writeFileSync(join(bin, "zip"), `#!/bin/sh\n# zip -qr -X OUT .\nfind . -path ./node_modules -prune -o \\( -type f -o -type l \\) -print | sort > "$3"\n`);
      chmodSync(join(bin, "npm"), 0o755);
      chmodSync(join(bin, "zip"), 0o755);

      execFileSync("bash", [join(root, "scripts/ci/package-auth.sh")], {
        env: { ...process.env, PATH: `${bin}:${process.env.PATH}`, CODEARTIFACT_AUTH_TOKEN: "test-token" },
        stdio: "pipe",
      });

      const files = readFileSync(join(root, "dist/hfy-auth-edge.zip"), "utf8").trim().split("\n");
      const shared = readdirSync(join(auth, "../shared")).filter((f) => f.endsWith(".mjs") && !f.endsWith(".test.mjs"));
      expect(shared.length).toBeGreaterThan(0);
      expect(files).toEqual(expect.arrayContaining(["./src/index.js", ...shared.map((f) => `./src/shared/${f}`)]));
      expect(files.filter((f) => f.startsWith("./src/shared/") && !shared.includes(f.slice("./src/shared/".length)))).toEqual([]);
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });
});
