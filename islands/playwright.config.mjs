import { defineConfig } from "@playwright/test";
import { resolve } from "node:path";

// HFY design-system pass (F3): the served site and port are overridable so parallel work can test a scratch copy of the site
// built with `node build.mjs --site <dir>`: HFY_SITE=<dir> PW_PORT=<port> npx playwright test ...
// Defaults (../11ty on 8089) are the committed site.
const site = resolve(process.env.HFY_SITE || "../11ty");
const port = Number(process.env.PW_PORT || 8089);
const origin = `http://127.0.0.1:${port}`;

// Local runs share the machine with the person using it, so they launch Playwright's bundled headless shell (never the system
// Chrome, which PW_CHANNEL=chrome still opts into) and run at most 2 workers, one spec file at a time per worker.
export default defineConfig({
  testDir: "./tests",
  timeout: 30_000,
  reporter: "list",
  fullyParallel: false,
  workers: process.env.CI ? undefined : 2,
  use: { baseURL: origin, channel: process.env.PW_CHANNEL || "chromium-headless-shell", viewport: { width: 375, height: 812 } },
  webServer: { command: `npx http-server "${site}" -p ${port} -a 127.0.0.1 -s -c-1`, url: `${origin}/`, reuseExistingServer: true, timeout: 30_000 }
});
