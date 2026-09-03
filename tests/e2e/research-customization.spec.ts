import { expect, test, type Page } from "@playwright/test";

async function loginAs(page: Page, name: "Matt" | "Eric") {
  const email = name === "Matt" ? "matt@lst.local" : "eric@lst.local";
  await page.goto("/login");
  await page.getByLabel("Email").fill(email);
  await page.getByLabel("Password").fill(process.env.DEV_SEED_PASSWORD ?? "lstbuddy-dev-only");
  await page.getByRole("button", { name: "Sign in" }).click();
  await expect(page.getByRole("heading", { name: new RegExp(`Hey ${name}`) })).toBeVisible();
}

test.describe("Research customization - per-user column layouts", () => {
  test("Matt keeps his existing simple default: Company/Scanner/Current Price/RSI-BB, no Eric-only columns", async ({ page }) => {
    await page.setViewportSize({ width: 1366, height: 768 });
    await loginAs(page, "Matt");
    await page.goto("/research");

    const table = page.getByTestId("research-desktop-table");
    await expect(table.locator("thead th", { hasText: "Company" })).toBeVisible();
    await expect(table.locator("thead th", { hasText: "Scanner" })).toBeVisible();
    await expect(table.locator("thead th", { hasText: "Current Price" })).toBeVisible();
    await expect(table.locator("thead th", { hasText: "RSI / BB" })).toBeVisible();
    await expect(table.locator("thead th", { hasText: "Schwab Rating" })).toHaveCount(0);
    await expect(table.locator("thead th", { hasText: "LSEG Recommendation" })).toHaveCount(0);
  });

  test("Eric starts with his research-heavy default layout", async ({ page }) => {
    await page.setViewportSize({ width: 1366, height: 768 });
    await loginAs(page, "Eric");
    await page.goto("/research");

    const table = page.getByTestId("research-desktop-table");
    for (const label of [
      "Company",
      "Current Price",
      "Industry / What",
      "Schwab Rating",
      "LSEG Recommendation",
      "LSEG Rating",
      "LSEG Target Price",
      "Debt / Equity",
      "Current Ratio",
      "P/E",
      "PEG",
      "Dividend",
      "Profitability",
      "Would Own",
      "Notes",
    ]) {
      await expect(table.locator("thead th", { hasText: label })).toBeVisible();
    }
  });

  test("every requested field is available through the Columns menu, organized by group", async ({ page }) => {
    await loginAs(page, "Matt");
    await page.goto("/research");

    await page.getByText("Columns", { exact: true }).click();
    const menu = page.getByTestId("research-columns-menu");
    for (const group of ["Core", "Technical", "Fundamentals", "External Research", "Personal", "History"]) {
      await expect(menu.getByText(group, { exact: true })).toBeVisible();
    }
    for (const label of ["Schwab Rating", "LSEG Recommendation", "LSEG Rating", "LSEG Target Price", "P/E", "PEG", "Debt / Equity", "Current Ratio", "Dividend", "Profitability", "Would Own", "Notes"]) {
      await expect(menu.locator("label", { hasText: label })).toBeVisible();
    }
  });

  test("Matt changing his columns does not change Eric's, and vice versa", async ({ browser }) => {
    const mattContext = await browser.newContext();
    const ericContext = await browser.newContext();
    const mattPage = await mattContext.newPage();
    const ericPage = await ericContext.newPage();

    await loginAs(mattPage, "Matt");
    await mattPage.goto("/research");
    await mattPage.getByText("Columns", { exact: true }).click();
    await mattPage.getByTestId("research-columns-menu").locator("label", { hasText: "P/E" }).click();
    await expect(mattPage.getByTestId("research-desktop-table").locator("thead th", { hasText: "P/E" })).toBeVisible();

    await loginAs(ericPage, "Eric");
    await ericPage.goto("/research");
    // Eric's own default already includes P/E and does NOT include RSI / BB - confirms his
    // layout is independent of whatever Matt just changed, not a shared/global setting.
    await expect(ericPage.getByTestId("research-desktop-table").locator("thead th", { hasText: "P/E" })).toBeVisible();
    await expect(ericPage.getByTestId("research-desktop-table").locator("thead th", { hasText: "RSI / BB" })).toHaveCount(0);

    await mattContext.close();
    await ericContext.close();
  });

  test("column preferences persist after logout and login", async ({ page }) => {
    await loginAs(page, "Matt");
    await page.goto("/research");

    await page.getByText("Columns", { exact: true }).click();
    await page.getByTestId("research-columns-menu").locator("label", { hasText: "Would Own" }).click();
    await expect(page.getByTestId("research-desktop-table").locator("thead th", { hasText: "Would Own" })).toBeVisible();

    await page.getByRole("button", { name: "Sign out" }).click();
    await expect(page).toHaveURL(/\/login/);

    await loginAs(page, "Matt");
    await page.goto("/research");
    await expect(page.getByTestId("research-desktop-table").locator("thead th", { hasText: "Would Own" })).toBeVisible();

    // Clean up so this test is re-runnable without reseeding.
    await page.getByText("Columns", { exact: true }).click();
    await page.getByTestId("research-columns-menu").locator("label", { hasText: "Would Own" }).click();
  });
});

test.describe("Research customization - manual fundamentals persistence", () => {
  test("manual P/E, LSEG recommendation, and profitability persist and never show 0 for blank", async ({ page }) => {
    await loginAs(page, "Matt");
    await page.goto("/research");

    const table = page.getByTestId("research-desktop-table");
    const row = table.getByRole("row", { name: /CORZ/ }).first();
    await row.click();

    // Scoped to the desktop table: an identical (hidden, closed <details>) copy of this same
    // form also exists in the mobile card markup for every row, which would otherwise make
    // these locators ambiguous even though only one copy is ever visible at a time.
    await table.locator('input[name="manualPeRatio"]').fill("22.4");
    await table.locator('select[name="manualLsegRecommendation"]').selectOption("BUY");
    await table.locator('select[name="profitability"]').selectOption("PROFITABLE");
    await table.locator('input[name="profitabilityNote"]').fill("Profitable 4 of last 5 years");
    await table.getByRole("button", { name: "Save research details" }).click();
    await expect(page).toHaveURL(/\/research/);

    // These fields are uncontrolled (defaultValue) - the still-mounted form after a save
    // does not re-initialize them from the freshly-revalidated props (a pre-existing
    // characteristic of this detail form, not new to this slice). Collapsing and
    // re-expanding the row force-remounts it, which is when defaultValue is honored again.
    await row.click();
    await row.click();
    await expect(table.locator('input[name="manualPeRatio"]')).toHaveValue("22.4");
    await expect(table.locator('select[name="manualLsegRecommendation"]')).toHaveValue("BUY");
    await expect(table.locator('select[name="profitability"]')).toHaveValue("PROFITABLE");
  });
});

test.describe("Research customization - Mine/Eric/Both privacy", () => {
  test("Buddy view shows only the buddy's SHARED research, never their PRIVATE items or private notes", async ({ page }) => {
    await loginAs(page, "Matt");
    await page.goto("/research?scope=buddy");

    await expect(page.getByText("SOFI", { exact: true })).toBeVisible();
    await expect(page.getByText("AMD", { exact: true })).toHaveCount(0);
    await expect(page.getByText("Too cyclical/competitive for Eric's CSP comfort")).toHaveCount(0);
  });

  test("Mine view never shows the buddy's research", async ({ page }) => {
    await loginAs(page, "Matt");
    await page.goto("/research?scope=mine");

    await expect(page.getByText(/Eric's Shared Research/)).toHaveCount(0);
  });

  test("Both view shows both users' independent opinions on the same ticker without merging them", async ({ page }) => {
    await loginAs(page, "Eric");
    await page.goto("/research?scope=both");

    const table = page.getByTestId("research-desktop-table");
    // Eric's own CORZ item does not exist in seed data, but Matt's CORZ is SHARED - it should
    // appear in Eric's buddy section, and Eric's own SOFI/AMD stay in his own table, each
    // labeled by owner rather than combined into one row.
    await expect(page.getByRole("heading", { name: "Matt's Shared Research" })).toBeVisible();
    await expect(page.getByText("CORZ", { exact: true })).toBeVisible();
    await expect(table.getByRole("row", { name: /SOFI/ })).toBeVisible();
  });

  test("Matt's private IONQ research and its private note never leak into Eric's buddy/both view", async ({ page }) => {
    await loginAs(page, "Eric");
    await page.goto("/research?scope=both");

    await expect(page.getByText("IONQ")).toHaveCount(0);
    await expect(page.getByText("Demo private note for Matt")).toHaveCount(0);
  });
});

test.describe("Research customization - mobile and accessibility", () => {
  test("mobile shows a trimmed card, no page-level horizontal overflow", async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await loginAs(page, "Eric");
    await page.goto("/research");

    await expect
      .poll(async () => page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 2))
      .toBe(true);
    await expect(page.getByTestId("research-mobile-cards")).toBeVisible();
    await expect(page.getByTestId("research-mobile-cards").getByText("Would own:").first()).toBeVisible();
  });

  test("Profitability InfoTip opens on focus and is dismissible with Escape", async ({ page }) => {
    await loginAs(page, "Matt");
    await page.goto("/research");

    const table = page.getByTestId("research-desktop-table");
    await table.getByRole("row", { name: /CORZ/ }).first().click();

    const helpButton = table.getByTestId("help-research-profitability");
    await helpButton.focus();
    await expect(page.locator('[role="tooltip"]').filter({ hasText: "multi-year financial-statements source" })).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(page.locator('[role="tooltip"]')).toHaveCount(0);
  });

  test("research stays readable in dark, light, and system theme modes", async ({ page }) => {
    await loginAs(page, "Matt");
    await page.goto("/research");

    for (const theme of ["dark", "light", "system"] as const) {
      await page.evaluate((nextTheme) => {
        if (nextTheme === "system") {
          document.documentElement.removeAttribute("data-theme");
        } else {
          document.documentElement.setAttribute("data-theme", nextTheme);
        }
      }, theme);
      await expect(page.getByRole("heading", { name: "Research", exact: true })).toBeVisible();
      await expect(page.getByTestId("research-desktop-table")).toBeVisible();
    }
  });
});
