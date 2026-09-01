import { expect, test, type Page } from "@playwright/test";

async function loginAsMatt(page: Page) {
  await page.goto("/login");
  await page.getByLabel("Email").fill("matt@lst.local");
  await page.getByLabel("Password").fill(process.env.DEV_SEED_PASSWORD ?? "lstbuddy-dev-only");
  await page.getByRole("button", { name: "Sign in" }).click();
  await expect(page.getByText("No order submission")).toBeVisible();
}

test.describe("Research", () => {
  test("renders as a dense status-tabbed table, not giant cards", async ({ page }) => {
    await page.setViewportSize({ width: 1366, height: 768 });
    await loginAsMatt(page);
    await page.goto("/research");

    await expect(page.getByRole("heading", { name: "Research", exact: true })).toBeVisible();
    await expect(page.getByRole("button", { name: /^All/ })).toBeVisible();
    await expect(page.getByRole("button", { name: /^Excluded/ })).toBeVisible();
    const table = page.getByTestId("research-desktop-table");
    await expect(table.locator("table thead th", { hasText: "Status" })).toBeVisible();
    await expect(table.locator("table thead th", { hasText: "Ticker" })).toBeVisible();
  });

  test("adding a ticker creates it PRIVATE with WATCH status by default", async ({ page }) => {
    await loginAsMatt(page);
    await page.goto("/research");

    const ticker = `RT${Date.now() % 100000}`;
    await page.getByPlaceholder("Ticker").fill(ticker);
    await page.getByRole("button", { name: "Add" }).click();

    const table = page.getByTestId("research-desktop-table");
    const row = table.getByRole("row", { name: new RegExp(ticker) });
    await expect(row).toBeVisible();
    await expect(row.getByText("WATCH", { exact: true })).toBeVisible();

    await row.click();
    await expect(page.getByRole("button", { name: "Share" })).toBeVisible();
  });

  test("Never Trade can be undone (unexcluded), never deletes the row", async ({ page }) => {
    await loginAsMatt(page);
    await page.goto("/research");

    const ticker = `RU${Date.now() % 100000}`;
    await page.getByPlaceholder("Ticker").fill(ticker);
    await page.getByRole("button", { name: "Add" }).click();

    const table = page.getByTestId("research-desktop-table");
    const expandButton = table.getByRole("button", { name: new RegExp(`${ticker} research`) });
    await expandButton.click();
    await page.getByRole("button", { name: "Never Trade" }).click();
    await expect(page.getByRole("button", { name: /^Excluded/ })).toContainText(/[1-9]/);

    await page.getByRole("button", { name: /^Excluded/ }).click();
    await expect(expandButton).toBeVisible();
    await page.getByRole("button", { name: "Neutral", exact: true }).click();

    await page.getByRole("button", { name: /^All/ }).click();
    await expect(expandButton).toBeVisible();
  });

  test("mobile 390px: no horizontal overflow", async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await loginAsMatt(page);
    await page.goto("/research");

    await expect
      .poll(async () => page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 2))
      .toBe(true);
    await expect(page.getByTestId("research-mobile-cards")).toBeVisible();
  });
});

test.describe("Scanner <-> Research integration", () => {
  test("a research status change from the Scanner shows up as a badge next to the ticker", async ({ page }) => {
    await loginAsMatt(page);
    await page.goto("/scanner");

    const table = page.getByTestId("scanner-desktop-table");
    const row = table.getByRole("row", { name: /^Collapse RIVN|Expand RIVN/ }).first();
    await row.click();
    await page.getByRole("button", { name: "Like" }).click();

    await expect(table.getByRole("row", { name: /RIVN/ }).getByText("LIKE", { exact: true })).toBeVisible();
  });

  test("excluding a candidate hides it by default but preserves its exact score when Show Excluded is on", async ({ page }) => {
    await loginAsMatt(page);
    await page.goto("/scanner");

    const table = page.getByTestId("scanner-desktop-table");
    const wbdExpandButton = table.getByRole("button", { name: /WBD details/ });
    const wbdRow = wbdExpandButton.locator("xpath=ancestor::tr");
    const scoreBefore = await wbdRow.locator("td").nth(1).innerText();
    const statusBefore = await wbdRow.locator("td").nth(2).innerText();

    await wbdExpandButton.click();
    await page.getByRole("button", { name: "Exclude" }).click();

    // Hidden by default now that it's excluded.
    await expect(table.getByRole("button", { name: /WBD details/ })).toHaveCount(0);

    await page.getByRole("button", { name: /Show Excluded/ }).click();
    const wbdExpandButtonAfter = table.getByRole("button", { name: /WBD details/ });
    await expect(wbdExpandButtonAfter).toBeVisible();
    const wbdRowAfter = wbdExpandButtonAfter.locator("xpath=ancestor::tr");
    await expect(wbdRowAfter.getByText("EXCLUDED BY YOU")).toBeVisible();
    expect(await wbdRowAfter.locator("td").nth(1).innerText()).toBe(scoreBefore.trim());
    expect((await wbdRowAfter.locator("td").nth(2).innerText()).replace("EXCLUDED BY YOU", "").trim()).toBe(statusBefore.trim());
  });

  test("Open in Research links from the Scanner to the Research page", async ({ page }) => {
    await loginAsMatt(page);
    await page.goto("/scanner");

    const table = page.getByTestId("scanner-desktop-table");
    await table.getByRole("row", { name: /SOFI/ }).click();
    await page.getByRole("link", { name: "Open in Research" }).click();
    await expect(page).toHaveURL(/\/research/);
  });

  test("/watchlist redirects to /research", async ({ page }) => {
    await loginAsMatt(page);
    await page.goto("/watchlist");
    await expect(page).toHaveURL(/\/research/);
  });
});
