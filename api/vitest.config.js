import { defineConfig } from "vitest/config";
// testTimeout: the suite runs ~1900 tests in parallel workers, and the heavy ones (package-api, caps.json) overrun the 5000 ms default under that load.
export default defineConfig({ test: { include: ["test/**/*.test.js"], reporters: ["default"], testTimeout: 20000 } });
