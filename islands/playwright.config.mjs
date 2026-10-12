import { defineConfig } from "@playwright/test";
export default defineConfig({
  testDir: "./tests",
  timeout: 30_000,
  reporter: "list",
  use: { baseURL: "http://127.0.0.1:8089", channel: process.env.PW_CHANNEL || "chrome", viewport: { width: 375, height: 812 } },
  webServer: { command: "npx http-server ../11ty -p 8089 -a 127.0.0.1 -c-1 --silent", url: "http://127.0.0.1:8089/", reuseExistingServer: true, timeout: 30_000 }
});
