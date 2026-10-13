import { defineConfig } from "vitest/config";

// src/shared is a symlink to the repo-root shared/, whose tests run under node --test, so vitest scans test/ only.
export default defineConfig({ test: { include: ["test/**/*.test.js"] } });
