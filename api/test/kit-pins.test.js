// hfy-kit-pins-exact: every @io-kit dependency in api/ and islands/ is an exact version, so a kit bump is always one deliberate edit.
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repo = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const EXACT = /^\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?$/;

function kitDeps(rel) {
  const pkg = JSON.parse(readFileSync(resolve(repo, rel), "utf8"));
  const out = [];
  for (const field of ["dependencies", "devDependencies", "optionalDependencies", "peerDependencies"]) {
    for (const [name, range] of Object.entries(pkg[field] || {})) if (name.startsWith("@io-kit/")) out.push({ rel, field, name, range });
  }
  return out;
}

describe("@io-kit exact pins", () => {
  for (const rel of ["api/package.json", "islands/package.json"]) {
    it(`${rel} pins every @io-kit dependency to an exact version`, () => {
      const deps = kitDeps(rel);
      expect(deps.length).toBeGreaterThan(0);
      const ranges = deps.filter((d) => !EXACT.test(d.range)).map((d) => `${d.field}.${d.name}=${d.range}`);
      expect(ranges).toEqual([]);
    });
  }

  it("api lockfile root entry matches package.json and resolves each kit to its pinned version", () => {
    const lock = JSON.parse(readFileSync(resolve(repo, "api/package-lock.json"), "utf8"));
    for (const d of kitDeps("api/package.json")) {
      expect(lock.packages[""][d.field][d.name], d.name).toBe(d.range);
      expect(lock.packages[`node_modules/${d.name}`].version, d.name).toBe(d.range);
    }
  });
});
