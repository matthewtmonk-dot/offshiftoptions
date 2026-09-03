import { expect, test, type Page } from "@playwright/test";

async function loginAsMatt(page: Page) {
  const password = process.env.DEV_SEED_PASSWORD ?? "lstbuddy-dev-only";
  await page.goto("/login");
  await page.getByLabel("Email").fill("matt@lst.local");
  await page.getByLabel("Password").fill(password);
  await page.getByRole("button", { name: "Sign in" }).click();
  await expect(page.getByText("No order submission")).toBeVisible();
}

test.describe("scanner redesign", () => {
  test("defaults to Score descending with no configuration", async ({ page }) => {
    await page.setViewportSize({ width: 1366, height: 768 });
    await loginAsMatt(page);
    await page.goto("/scanner");

    const desktop = page.getByTestId("scanner-desktop-table");
    const scoreCells = desktop.locator("table tbody tr td:nth-child(2)");
    const scores = (await scoreCells.allTextContents()).map((text) => Number(text.trim())).filter((n) => !Number.isNaN(n));

    expect(scores.length).toBeGreaterThan(1);
    for (let i = 1; i < scores.length; i += 1) {
      expect(scores[i]).toBeLessThanOrEqual(scores[i - 1]);
    }
  });

  test("one-click Pass filter shows only PASS rows", async ({ page }) => {
    await loginAsMatt(page);
    await page.goto("/scanner");

    await page.getByRole("button", { name: /^Pass/ }).click();
    const desktop = page.getByTestId("scanner-desktop-table");
    await expect(desktop.getByRole("row", { name: /RIVN/ })).toBeVisible();
    await expect(desktop.getByText("FAIL", { exact: true })).toHaveCount(0);
    await expect(desktop.getByText("NEAR", { exact: true })).toHaveCount(0);
  });

  test("one-click Near filter isolates near-miss candidates and shows why they missed", async ({ page }) => {
    await loginAsMatt(page);
    await page.goto("/scanner");

    await page.getByRole("button", { name: /^Near/ }).click();
    const desktop = page.getByTestId("scanner-desktop-table");
    await expect(desktop.getByRole("row", { name: /CORZ/ })).toBeVisible();
    await expect(desktop.getByRole("row", { name: /RIVN/ })).toHaveCount(0);

    await desktop.getByRole("button", { name: /CORZ details/ }).click();
    await expect(desktop.getByText("Criteria")).toBeVisible();
    await expect(desktop.getByText("FAIL", { exact: true }).first()).toBeVisible();
  });

  test("one-click Watchlist filter shows only watchlisted tickers", async ({ page }) => {
    await loginAsMatt(page);
    await page.goto("/scanner");

    await page.getByRole("button", { name: /^Watchlist/ }).click();
    const desktop = page.getByTestId("scanner-desktop-table");
    await expect(desktop.getByRole("row", { name: /CORZ/ })).toBeVisible();
    await expect(desktop.getByRole("row", { name: /RIVN/ })).toHaveCount(0);
  });

  test("candidate rows expand and collapse in place without navigation", async ({ page }) => {
    await loginAsMatt(page);
    await page.goto("/scanner");

    const desktop = page.getByTestId("scanner-desktop-table");
    const expandButton = desktop.getByRole("button", { name: /RIVN details/ });
    await expect(desktop.getByText("Send to buddy")).toHaveCount(0);

    await expandButton.click();
    await expect(desktop.getByText("Send to buddy")).toBeVisible();
    expect(page.url()).toContain("/scanner");

    await expandButton.click();
    await expect(desktop.getByText("Send to buddy")).toHaveCount(0);
  });

  test("missing/unknown values render as a compact dash, not the word UNKNOWN", async ({ page }) => {
    await loginAsMatt(page);
    await page.goto("/scanner");

    const desktop = page.getByTestId("scanner-desktop-table");
    await expect(desktop.getByText("UNKNOWN", { exact: true })).toHaveCount(0);
    await expect(desktop.getByText("—", { exact: true }).first()).toBeVisible();
  });

  test("gating FAIL never displays a positive label, and Verify never displays Excellent/Strong", async ({ page }) => {
    await loginAsMatt(page);
    await page.goto("/scanner");

    const desktop = page.getByTestId("scanner-desktop-table");
    const failRow = desktop.getByRole("row", { name: /WBD/ });
    await expect(failRow.getByText("FAIL", { exact: true })).toBeVisible();
    await expect(failRow.getByText("EXCELLENT", { exact: true })).toHaveCount(0);
    await expect(failRow.getByText("STRONG", { exact: true })).toHaveCount(0);
  });

  test("optional columns are hidden by default and can be added via Columns", async ({ page }) => {
    await loginAsMatt(page);
    await page.goto("/scanner");

    await expect(page.locator("thead th", { hasText: "Delta" })).toHaveCount(0);

    await page.getByText("Columns", { exact: true }).click();
    await page.locator("label").filter({ hasText: /^Delta$/ }).click();
    await expect(page.locator("thead th", { hasText: "Delta" })).toBeVisible();
  });

  test("sort control changes candidate order client-side", async ({ page }) => {
    await loginAsMatt(page);
    await page.goto("/scanner");

    await page.getByLabel("Sort candidates by").selectOption("ticker");
    const desktop = page.getByTestId("scanner-desktop-table");
    const firstTicker = desktop.locator("table tbody tr").first().locator("td").first();
    await expect(firstTicker).toContainText("AAP");
  });

  test("Why diagnostics stay collapsed by default and reveal the exclusion funnel on demand", async ({ page }) => {
    await loginAsMatt(page);
    await page.goto("/scanner");

    await expect(page.getByText("Starting universe")).not.toBeVisible();
    await page.getByText(/Why showing/).click();
    await expect(page.getByText("Starting universe")).toBeVisible();
  });

  test("desktop 1366x768: multiple candidate rows are visible above the fold", async ({ page }) => {
    await page.setViewportSize({ width: 1366, height: 768 });
    await loginAsMatt(page);
    await page.goto("/scanner");

    const desktop = page.getByTestId("scanner-desktop-table");
    const tickerButtons = desktop.locator("table tbody tr td:first-child button");
    const count = await tickerButtons.count();
    expect(count).toBeGreaterThanOrEqual(5);

    for (let i = 0; i < Math.min(count, 5); i += 1) {
      await expect(tickerButtons.nth(i)).toBeInViewport();
    }
  });

  test("mobile 390px: no horizontal overflow and priority fields are visible", async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await loginAsMatt(page);
    await page.goto("/scanner");

    await expect
      .poll(async () => page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 2))
      .toBe(true);

    const mobile = page.getByTestId("scanner-mobile-cards");
    await expect(mobile.getByText("RIVN").first()).toBeVisible();
    await expect(mobile.getByText("PRICE").first()).toBeVisible();
  });

  test("results and Last run timestamp stay visible after navigating away and back", async ({ page }) => {
    await loginAsMatt(page);
    await page.goto("/scanner");

    const desktop = page.getByTestId("scanner-desktop-table");
    await expect(desktop.getByRole("row", { name: /RIVN/ })).toBeVisible();
    await expect(page.getByText(/Last run:/)).toBeVisible();

    await page.goto("/research");
    await page.goto("/scanner");

    await expect(desktop.getByRole("row", { name: /RIVN/ })).toBeVisible();
    await expect(page.getByText(/Last run:/)).toBeVisible();
  });
});

test.describe("Run Live Scan pending state", () => {
  test("shows Scanning immediately, blocks duplicate clicks, and clears on failure with Retry", async ({ page }) => {
    await loginAsMatt(page);
    await page.goto("/scanner");

    // No Schwab connection exists in this dev environment, so the action genuinely
    // fails fast (LIVE DATA UNAVAILABLE). Delay the action's response so the transient
    // pending state is observable instead of resolving before we can assert on it.
    await page.route("**/scanner", async (route) => {
      if (route.request().method() === "POST") {
        await new Promise((resolve) => setTimeout(resolve, 700));
      }
      await route.continue();
    });

    const button = page.getByTestId("run-live-scan-button");
    const status = page.getByTestId("live-scan-status");
    await expect(button).toHaveText("Run Live Scan");

    await button.click();
    await expect(button).toHaveText("Scanning…");
    await expect(button).toBeDisabled();
    await expect(status).toContainText("Checking live market data and option chains");

    // A click while disabled must not restart or otherwise disturb the pending state.
    await button.click({ timeout: 300 }).catch(() => {});
    await expect(button).toHaveText("Scanning…");

    await expect(button).toHaveText("Run Live Scan", { timeout: 5000 });
    await expect(button).toBeEnabled();
    await expect(status).toContainText("LIVE DATA UNAVAILABLE");
    await expect(status.getByRole("button", { name: "Retry" })).toBeVisible();
  });

  test("respects prefers-reduced-motion by not animating the refresh icon", async ({ page }) => {
    await page.emulateMedia({ reducedMotion: "reduce" });
    await loginAsMatt(page);
    await page.goto("/scanner");

    await page.route("**/scanner", async (route) => {
      if (route.request().method() === "POST") {
        await new Promise((resolve) => setTimeout(resolve, 500));
      }
      await route.continue();
    });

    const button = page.getByTestId("run-live-scan-button");
    await button.click();
    await expect(button).toHaveText("Scanning…");

    const icon = button.locator("svg");
    const animationName = await icon.evaluate((element) => getComputedStyle(element).animationName);
    expect(animationName).toBe("none");
  });
});
