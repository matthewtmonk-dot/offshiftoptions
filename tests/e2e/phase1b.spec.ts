import { expect, test, type Page } from "@playwright/test";

async function loginAs(page: Page, name: "Matt" | "Eric") {
  const email = name === "Matt" ? "matt@lst.local" : "eric@lst.local";
  const password = process.env.DEV_SEED_PASSWORD ?? "lstbuddy-dev-only";
  await page.goto("/login");
  await page.getByLabel("Email").fill(email);
  await page.getByLabel("Password").fill(password);
  await page.getByRole("button", { name: "Sign in" }).click();
  await expect(page.getByRole("heading", { name: new RegExp(`Hey ${name}`) })).toBeVisible();
}

async function signOut(page: Page) {
  await page.getByRole("button", { name: "Sign out" }).click();
  await expect(page.getByRole("heading", { name: "Off Shift Options" })).toBeVisible();
}

test("Matt and Eric can authenticate to their own dashboard", async ({ page }) => {
  await loginAs(page, "Matt");
  await expect(page.getByText("No order submission")).toBeVisible();
  await signOut(page);

  await loginAs(page, "Eric");
  await expect(page.getByText("No order submission")).toBeVisible();
});

test("Matt private research items are not visible to Eric", async ({ page }) => {
  // Watchlist was renamed to Research (2026-09) - a dense table, not per-item <article>
  // cards - and new items are PRIVATE by default now, so no explicit visibility toggle is
  // needed to prove isolation. See PROJECT_HANDOFF.md Research section.
  await loginAs(page, "Matt");
  await page.goto("/research");
  await page.getByPlaceholder("Ticker").fill("TST3");
  await page.getByRole("button", { name: "Add" }).click();

  const mattTable = page.getByTestId("research-desktop-table");
  await expect(mattTable.getByRole("row", { name: /TST3/ })).toBeVisible();

  await signOut(page);
  await loginAs(page, "Eric");
  await page.goto("/research");
  await expect(page.getByTestId("research-desktop-table").getByRole("row", { name: /TST3/ })).toHaveCount(0);
  await expect(page.getByText("TST3")).toHaveCount(0);
});

test("recommendations persist for the buddy recipient", async ({ page }) => {
  const message = `E2E recommendation for CORZ ${Date.now()}`;

  await loginAs(page, "Matt");
  await page.goto("/recommendations");
  await page.getByPlaceholder("Ticker").fill("CORZ");
  await page.locator('select[name="recipientId"]').selectOption({ label: "Eric" });
  await page.getByPlaceholder("Message").fill(message);
  await page.getByRole("button", { name: "Send" }).click();

  await signOut(page);
  await loginAs(page, "Eric");
  await page.goto("/recommendations");
  await expect(page.getByText(message)).toBeVisible();
  await expect(page.locator("article").filter({ hasText: message }).first()).toContainText("NEW");
});

test("scanner settings are editable per user", async ({ page }) => {
  await loginAs(page, "Matt");
  await page.goto("/scanner/settings");
  await page.locator('input[name="price:min"]').fill("12");
  await page.locator('input[name="price:max"]').fill("60");
  await page.getByRole("button", { name: "Save Settings" }).click();
  await expect(page.getByText("Scanner settings saved.")).toBeVisible();

  await signOut(page);
  await loginAs(page, "Eric");
  await page.goto("/scanner/settings");
  await expect(page.locator('input[name="price:min"]')).toHaveValue("10");
  await expect(page.locator('input[name="price:max"]')).toHaveValue("50");
});

test("tracker shows campaign lifecycles without leaking private buddy campaigns", async ({ page }) => {
  await loginAs(page, "Matt");
  await page.goto("/positions?scope=both");
  await expect(page.getByRole("heading", { name: "Tracker" })).toBeVisible();
  // Open tab is the default view - only open campaigns show here.
  await expect(page.getByText("WBD").first()).toBeVisible();

  const aapCard = page.locator("details").filter({ hasText: "AAP" }).first();
  await aapCard.click();
  await expect(aapCard.getByText("Lifecycle")).toBeVisible();
  await expect(aapCard.getByText("Roll net")).toBeVisible();

  await page.getByRole("link", { name: "History" }).click();
  await expect(page.getByText("SOFI").first()).toBeVisible();

  await signOut(page);
  await loginAs(page, "Eric");
  await page.goto("/positions?scope=both");
  await expect(page.getByText("HOOD").first()).toBeVisible();
  await expect(page.getByText("WBD")).toHaveCount(0);

  await page.getByRole("link", { name: "Accounts" }).click();
  await expect(page.getByText("Matt IRA").first()).toBeVisible();
});

test("major app pages render at mobile width without horizontal overflow", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await loginAs(page, "Matt");

  for (const route of [
    "/dashboard",
    "/scanner",
    "/scanner/settings",
    "/research",
    "/recommendations",
    "/chat",
    "/notifications",
    "/positions",
    "/account",
  ]) {
    await page.goto(route);
    await expect(page.locator("h1").first()).toBeVisible();
    await expect
      .poll(async () =>
        page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 2),
      )
      .toBe(true);
  }
});
