import { expect, test, type Page } from "@playwright/test";

async function loginAs(page: Page, email: string) {
  await page.goto("/login");
  await page.getByLabel("Email").fill(email);
  await page.getByLabel("Password").fill(process.env.DEV_SEED_PASSWORD ?? "lstbuddy-dev-only");
  await page.getByRole("button", { name: "Sign in" }).click();
  await expect(page.getByText("No order submission")).toBeVisible();
}

async function loginAsMatt(page: Page) {
  await loginAs(page, "matt@lst.local");
}

async function loginAsEric(page: Page) {
  await loginAs(page, "eric@lst.local");
}

const baseURL = process.env.PLAYWRIGHT_BASE_URL ?? "http://localhost:3000";

test.describe("Performance Phase A", () => {
  test("dashboard shell does not prefetch duplicate private route RSC payloads", async ({ page }) => {
    const privateRscPaths: string[] = [];
    page.on("request", (request) => {
      const url = new URL(request.url());
      if (url.searchParams.has("_rsc") && url.pathname !== "/dashboard") {
        privateRscPaths.push(url.pathname);
      }
    });

    await loginAsMatt(page);
    await page.waitForTimeout(1500);

    expect(privateRscPaths).toEqual([]);
  });

  test("tracker tab selection updates before the server navigation settles", async ({ page }) => {
    await loginAsMatt(page);
    await page.goto("/positions?scope=both");

    const performanceTab = page.getByTestId("tracker-tabs").getByRole("link", { name: "Performance" });
    const startedAt = Date.now();
    await performanceTab.click();
    await expect(performanceTab).toHaveAttribute("aria-current", "page", { timeout: 500 });
    const selectedMs = Date.now() - startedAt;

    expect(selectedMs).toBeLessThan(500);
    await expect(page).toHaveURL(/view=performance/);
  });

  test("desktop and mobile navigation keep browser history and tracker deep links valid", async ({ browser }) => {
    const desktop = await browser.newContext({ baseURL, serviceWorkers: "block", viewport: { width: 1366, height: 768 } });
    const desktopPage = await desktop.newPage();
    await loginAsMatt(desktopPage);
    await desktopPage.locator("aside").getByRole("link", { name: "Scanner", exact: true }).click();
    await expect(desktopPage.getByRole("heading", { name: "My LST Scanner" })).toBeVisible();
    await desktopPage.locator("aside").getByRole("link", { name: "Research", exact: true }).click();
    await expect(desktopPage.getByRole("heading", { name: "Research", exact: true })).toBeVisible();
    await desktopPage.goBack();
    await expect(desktopPage.getByRole("heading", { name: "My LST Scanner" })).toBeVisible();
    await desktopPage.goForward();
    await expect(desktopPage.getByRole("heading", { name: "Research", exact: true })).toBeVisible();

    await desktopPage.goto("/positions?scope=both&view=history");
    await expect(desktopPage.getByRole("heading", { name: "Tracker" })).toBeVisible();
    await expect(desktopPage.getByTestId("tracker-tabs").getByRole("link", { name: "History", exact: true })).toHaveAttribute("aria-current", "page");
    await expect(desktopPage).toHaveURL(/scope=both&view=history/);
    await desktop.close();

    const mobile = await browser.newContext({ baseURL, serviceWorkers: "block", viewport: { width: 390, height: 844 } });
    const mobilePage = await mobile.newPage();
    await loginAsMatt(mobilePage);
    await mobilePage.locator("header").getByRole("link", { name: "Scanner", exact: true }).click();
    await expect(mobilePage.getByRole("heading", { name: "My LST Scanner" })).toBeVisible();
    await mobilePage.locator("header").getByRole("link", { name: "Tracker", exact: true }).click();
    await expect(mobilePage.getByRole("heading", { name: "Tracker" })).toBeVisible();
    await expect
      .poll(async () => mobilePage.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 2))
      .toBe(true);
    await mobile.close();
  });

  test("research status buttons update optimistically and roll back failed saves", async ({ page }) => {
    await loginAsMatt(page);
    await page.goto("/research");

    const ticker = `OP${Date.now() % 100000}`;
    await page.getByPlaceholder("Ticker").fill(ticker);
    await page.getByRole("button", { name: "Add" }).click();

    const table = page.getByTestId("research-desktop-table");
    const row = table.getByRole("row", { name: new RegExp(ticker) }).first();
    await expect(row.getByText("WATCH", { exact: true })).toBeVisible();
    await row.getByRole("button", { name: new RegExp(`${ticker} research`) }).click();

    for (const choice of [
      { button: "Like", badge: "LIKE" },
      { button: "Watch", badge: "WATCH" },
      { button: "Neutral", badge: "NEUTRAL" },
      { button: "Avoid", badge: "AVOID" },
      { button: "Never Trade", badge: "EXCLUDED" },
    ]) {
      const startedAt = Date.now();
      await page.getByRole("button", { name: choice.button, exact: true }).click();
      await expect(row.getByText(choice.badge, { exact: true })).toBeVisible({ timeout: 500 });
      expect(Date.now() - startedAt).toBeLessThan(500);
      await expect(page.getByRole("button", { name: choice.button, exact: true })).not.toBeDisabled();
    }

    let abortNextPost = true;
    await page.route("**/*", async (route) => {
      if (abortNextPost && route.request().method() === "POST") {
        abortNextPost = false;
        await new Promise((resolve) => setTimeout(resolve, 300));
        await route.abort();
        return;
      }
      await route.continue();
    });

    await page.getByRole("button", { name: "Like", exact: true }).click();
    await expect(row.getByText("EXCLUDED", { exact: true })).toBeVisible();
    await expect(page.getByText("Research status could not be saved. Try again in a moment.")).toBeVisible();
    await page.unroute("**/*");
  });

  test("scanner quick research actions are optimistic and preserve technical score/exclusion ownership", async ({ page }) => {
    await loginAsMatt(page);
    await page.goto("/scanner");

    const table = page.getByTestId("scanner-desktop-table");
    const expandButton = table.getByRole("button", { name: /WBD details/ });
    const scoreBefore = (await expandButton.locator("xpath=ancestor::tr").locator("td").nth(1).innerText()).trim();
    await expandButton.click();

    for (const choice of [
      { button: "Like", badge: "LIKE" },
      { button: "Watch", badge: "WATCH" },
      { button: "Avoid", badge: "AVOID" },
    ]) {
      const startedAt = Date.now();
      await page.getByRole("button", { name: choice.button, exact: true }).click();
      await expect(table.getByRole("row", { name: /WBD/ }).getByText(choice.badge, { exact: true })).toBeVisible({ timeout: 500 });
      expect(Date.now() - startedAt).toBeLessThan(500);
      await expect(page.getByRole("button", { name: choice.button, exact: true })).not.toBeDisabled();
    }

    let abortNextPost = true;
    await page.route("**/*", async (route) => {
      if (abortNextPost && route.request().method() === "POST") {
        abortNextPost = false;
        await new Promise((resolve) => setTimeout(resolve, 300));
        await route.abort();
        return;
      }
      await route.continue();
    });

    await page.getByRole("button", { name: "Watch", exact: true }).click();
    await expect(table.getByRole("row", { name: /WBD/ }).getByText("AVOID", { exact: true })).toBeVisible();
    await expect(page.getByText("Research status could not be saved. Try again in a moment.")).toBeVisible();
    await page.unroute("**/*");

    await page.getByRole("button", { name: "Neutral", exact: true }).click();
    await expect(page.getByRole("button", { name: "Neutral", exact: true })).toHaveAttribute("aria-pressed", "true");

    await page.getByRole("button", { name: "Exclude", exact: true }).click();
    await expect(table.getByRole("button", { name: /WBD details/ })).toHaveCount(0);

    await page.getByRole("button", { name: /Show Excluded/ }).click();
    const excludedExpandButton = table.getByRole("button", { name: /WBD details/ });
    await expect(excludedExpandButton).toBeVisible();
    const excludedRow = excludedExpandButton.locator("xpath=ancestor::tr");
    expect((await excludedRow.locator("td").nth(1).innerText()).trim()).toBe(scoreBefore);
    await expect(excludedRow.getByText("EXCLUDED BY YOU")).toBeVisible();

    await page.getByRole("button", { name: "Sign out" }).click();
    await expect(page.getByRole("heading", { name: "Off Shift Options" })).toBeVisible();
    await loginAsEric(page);
    await page.goto("/scanner");
    const ericRow = page.getByTestId("scanner-desktop-table").getByRole("row", { name: /WBD/ });
    await expect(ericRow).toBeVisible();
    expect((await ericRow.locator("td").nth(1).innerText()).trim()).toBe(scoreBefore);
    await expect(ericRow.getByText("EXCLUDED BY YOU")).toHaveCount(0);
  });
});
