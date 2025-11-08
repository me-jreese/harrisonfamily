import { defineConfig, devices } from "@playwright/test";

export default defineConfig({
  testDir: "./tests",
  timeout: 90_000,
  expect: {
    timeout: 10_000
  },
  reporter: [["html", { outputFolder: "playwright-report", open: "never" }]],
  use: {
    baseURL: process.env.HFY_SITE_BASE ?? "https://harrisonfamily.us",
    trace: "on-first-retry",
    video: "retain-on-failure"
  },
  projects: [
    {
      name: "chromium",
      use: { ...devices["Desktop Chrome"] }
    },
    {
      name: "webkit",
      use: { ...devices["Desktop Safari"] }
    }
  ]
});
