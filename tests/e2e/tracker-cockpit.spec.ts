import { expect, test, type Page } from "@playwright/test";

async function login(page: Page, name: "Matt" | "Eric" = "Matt") {
  const password = process.env.DEV_SEED_PASSWORD;
  if (!password) throw new Error("Set DEV_SEED_PASSWORD for local browser tests.");
  await page.goto("/login");
  await page.getByLabel("Email").fill(name === "Matt" ? "matt@lst.local" : "eric@lst.local");
  await page.getByLabel("Password").fill(password);
  await page.getByRole("button", { name: "Sign in" }).click();
  await expect(page.getByRole("heading", { name: new RegExp(`Hey ${name}`) })).toBeVisible();
}

test("open cards expose the active contract and distinguish DTE, campaign age and cash flow", async ({ page }) => {
  await login(page);
  await page.goto("/positions");
  const card = page.getByTestId("campaign-card-AAP");
  const summary = card.locator("summary").first();
  await expect(summary.getByTestId("active-put-contract")).toContainText(/\$[\d,.]+ Put/);
  await expect(summary.getByTestId("active-put-contract")).toContainText(/\d+ DTE/);
  await expect(summary.getByText("Days open", { exact: true })).toBeVisible();
  await expect(summary.getByText("Net premium", { exact: true })).toBeVisible();
  await expect(summary.getByText(/Cash flow · not realized/)).toBeVisible();
  await expect(summary.getByText("Realized", { exact: true })).toHaveCount(0);
  await expect(summary.getByText("Return", { exact: true })).toHaveCount(0);
  await expect(summary.getByText("Stock snapshot", { exact: true })).toBeVisible();
  await summary.click();
  await expect(card.getByText("Roll net")).toBeVisible();
});

test("Refresh preserves scope and expanded history and sends no mutation request", async ({ page }) => {
  await login(page);
  await page.goto("/positions?scope=both");
  const card = page.getByTestId("campaign-card-AAP");
  await card.locator("summary").first().click();
  const mutations: string[] = [];
  page.on("request", (request) => { if (request.method() === "POST") mutations.push(request.url()); });
  await page.getByRole("button", { name: "Refresh snapshot", exact: true }).click();
  await expect(page.getByRole("button", { name: "Refresh snapshot", exact: true })).toBeEnabled();
  await expect(page).toHaveURL(/scope=both/);
  await expect(card.getByText("Roll net")).toBeVisible();
  await expect(page.getByTestId("tracker-snapshot-status")).toContainText("cached for 15 seconds");
  expect(mutations).toEqual([]);
});

test("Brokerage Sync leads to the existing Account controls without running sync", async ({ page }) => {
  await login(page);
  await page.goto("/positions");
  const mutations: string[] = [];
  page.on("request", (request) => { if (request.method() === "POST") mutations.push(request.url()); });
  await page.getByRole("link", { name: "Brokerage Sync in Account" }).click();
  await expect(page).toHaveURL(/\/account#brokerage-sync$/);
  await expect(page.locator("#brokerage-sync")).toBeVisible();
  expect(mutations).toEqual([]);
});

test("private campaigns remain unavailable to the buddy", async ({ page }) => {
  await login(page, "Eric");
  await page.goto("/positions?scope=both");
  await expect(page.getByTestId("campaign-card-WBD")).toHaveCount(0);
  await expect(page.getByTestId("campaign-card-HOOD")).toBeVisible();
});

test("open cockpit fits mobile and desktop in both themes", async ({ page }, testInfo) => {
  await login(page);
  await page.goto("/positions");
  for (const width of [390, 1440]) {
    await page.setViewportSize({ width, height: 1000 });
    for (const theme of ["light", "dark"]) {
      await page.evaluate((value) => document.documentElement.setAttribute("data-theme", value), theme);
      await expect(page.getByRole("button", { name: "Refresh snapshot", exact: true })).toBeVisible();
      await expect.poll(() => page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 2)).toBe(true);
      await page.screenshot({ path: testInfo.outputPath(`tracker-${width}-${theme}.png`), fullPage: true });
    }
  }
});
