#!/usr/bin/env node
// Generates api/dist/caps.json from the route registry (AC2). Run: node api/scripts/gen-caps.mjs
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { buildCaps } from "../src/routes.js";

const out = resolve(dirname(fileURLToPath(import.meta.url)), "..", "dist", "caps.json");
mkdirSync(dirname(out), { recursive: true });
writeFileSync(out, `${JSON.stringify(buildCaps(), null, 2)}\n`);
console.log(`wrote ${out}`);
