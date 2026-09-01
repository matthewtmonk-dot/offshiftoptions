import { defineConfig, devices } from "@playwright/test";

export default defineConfig({
  testDir: "./tests/e2e",
  timeout: 30_000,
  expect: {
    timeout: 10_000,
  },
  fullyParallel: false,
  reporter: [["list"]],
  use: {
    // Next.js dev's cross-origin asset guard trusts "localhost" but not the equivalent
    // "127.0.0.1" - using the IP literal here silently 403s every JS chunk, which breaks
    // client hydration (and therefore every onClick-driven assertion) without any visible
    // test failure.
    baseURL: process.env.PLAYWRIGHT_BASE_URL ?? "http://localhost:3000",
    trace: "retain-on-failure",
  },
  projects: [
    {
      name: "chromium",
      use: { ...devices["Desktop Chrome"] },
    },
  ],
});
