import { expect, test, type Page } from "@playwright/test";

async function loginAs(page: Page, name: "Matt" | "Eric") {
  const email = name === "Matt" ? "matt@lst.local" : "eric@lst.local";
  await page.goto("/login");
  await page.getByLabel("Email").fill(email);
  await page.getByLabel("Password").fill(process.env.DEV_SEED_PASSWORD ?? "lstbuddy-dev-only");
  await page.getByRole("button", { name: "Sign in" }).click();
  await expect(page.getByRole("heading", { name: new RegExp(`Hey ${name}`) })).toBeVisible();
}

test.describe("Performance cockpit and campaign history", () => {
  test("performance separates account, realized, current, and projected P/L", async ({ page }) => {
    await loginAs(page, "Matt");
    await page.goto("/positions?view=performance");

    const cockpit = page.getByTestId("performance-cockpit");
    await expect(cockpit).toBeVisible();
    await expect(cockpit.getByText("Trading P/L Now", { exact: true })).toBeVisible();
    await expect(cockpit.getByText("Realized P/L", { exact: true }).first()).toBeVisible();
    await expect(cockpit.getByText("Current / MTM P/L", { exact: true })).toBeVisible();
    await expect(cockpit.getByText("Projected OTM P/L", { exact: true })).toBeVisible();
    await expect(page.getByText("1% Goal Tracker")).toBeVisible();
    await expect(page.getByText("Performance vs 1% Target")).toBeVisible();

    const table = page.getByTestId("performance-campaign-table");
    await expect(table).toBeVisible();
    await expect(table.getByText("Campaign Performance")).toBeVisible();
    await expect(table.getByText("Current P/L")).toBeVisible();
    await expect(table.getByText("Projected OTM")).toBeVisible();

    const aap = page.getByTestId("performance-campaign-AAP");
    await expect(aap).toBeVisible();
    await expect(aap.getByText("-$36.00")).toBeVisible();
    await expect(aap.getByText("+$79.00").first()).toBeVisible();
    await aap.locator("summary").click();
    await expect(aap.getByText("Cached option mark")).toBeVisible();
  });

  test("performance help opens on hover, focus, and Escape closes it", async ({ page }) => {
    await loginAs(page, "Matt");
    await page.goto("/positions?view=performance");

    const mtmHelp = page.getByTestId("help-current-mtm-pl");
    await mtmHelp.hover();
    const mtmTip = page.locator('[role="tooltip"]').filter({ hasText: "estimate of what marked campaigns" });
    await expect(mtmTip).toBeVisible();
    await page.mouse.move(5, 5);
    await expect(mtmTip).toHaveCount(0);

    const tradingHelp = page.getByTestId("help-trading-pl-now");
    await tradingHelp.focus();
    const tradingTip = page.locator('[role="tooltip"]').filter({ hasText: "current trading result" });
    await expect(tradingTip).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(tradingTip).toHaveCount(0);
  });

  test("mobile help opens by tap, closes by tap-away, and stays within the viewport", async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await loginAs(page, "Matt");
    await page.goto("/positions?view=performance");

    await page.getByTestId("help-projected-otm-pl").click();
    const projectionTip = page.locator('[role="tooltip"]').filter({ hasText: "scenario, not guaranteed profit" });
    await expect(projectionTip).toBeVisible();
    await expect
      .poll(async () => page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 2))
      .toBe(true);
    await page.mouse.click(20, 20);
    await expect(projectionTip).toHaveCount(0);
  });

  test("help icons do not block campaign expansion controls", async ({ page }) => {
    await loginAs(page, "Matt");
    await page.goto("/positions?scope=both&view=history");

    const aap = page.getByTestId("campaign-card-AAP");
    await aap.getByTestId("help-summary-premium-AAP").click();
    await expect(aap.locator('[role="tooltip"]').filter({ hasText: "Credits received minus debits paid" })).toBeVisible();
    await expect.poll(async () => aap.evaluate((element) => (element as HTMLDetailsElement).open)).toBe(false);

    await aap.locator("summary").click();
    await expect(aap.getByText("Roll net")).toBeVisible();
    await expect(aap.getByText("Sell to Open")).toBeVisible();
  });

  test("history shows open, rolled, assigned, and closed campaigns", async ({ page }) => {
    await loginAs(page, "Matt");
    await page.goto("/positions?scope=both&view=history");

    const history = page.getByTestId("campaign-history-table");
    await expect(history).toBeVisible();
    for (const ticker of ["IONQ", "AAP", "F", "BROS", "SOFI", "ROKU", "HOOD"]) {
      await expect(history.getByTestId(`campaign-card-${ticker}`)).toBeVisible();
    }
    await expect(history.getByText("OPEN").first()).toBeVisible();
    await expect(history.getByText("ASSIGNED").first()).toBeVisible();
    await expect(history.getByText("CLOSED").first()).toBeVisible();

    const aap = history.getByTestId("campaign-card-AAP");
    await aap.locator("summary").click();
    await expect(aap.getByText("Roll net")).toBeVisible();
    await expect(history.getByText("No closed campaigns yet for this view.")).toHaveCount(0);
  });

  test("performance table remains scoped to the signed-in user", async ({ page }) => {
    await loginAs(page, "Eric");
    await page.goto("/positions?scope=both&view=performance");

    await expect(page.getByTestId("performance-campaign-HOOD")).toBeVisible();
    await expect(page.getByTestId("performance-campaign-AAP")).toHaveCount(0);
    await expect(page.getByTestId("performance-campaign-WBD")).toHaveCount(0);
    await expect(page.getByTestId("performance-campaign-BROS")).toHaveCount(0);
  });

  test("performance and history stay within the mobile viewport", async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await loginAs(page, "Matt");

    for (const route of ["/positions?view=performance", "/positions?scope=both&view=history"]) {
      await page.goto(route);
      await expect(page.getByRole("heading", { name: "Tracker" })).toBeVisible();
      await expect
        .poll(async () => page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 2))
        .toBe(true);
    }
  });

  test("help remains readable in dark, light, and system theme modes", async ({ page }) => {
    await loginAs(page, "Matt");
    await page.goto("/positions?view=performance");

    for (const theme of ["dark", "light", "system"] as const) {
      await page.evaluate((nextTheme) => {
        if (nextTheme === "system") {
          document.documentElement.removeAttribute("data-theme");
        } else {
          document.documentElement.setAttribute("data-theme", nextTheme);
        }
      }, theme);
      await page.getByTestId("help-one-percent-target").click();
      await expect(page.locator('[role="tooltip"]').filter({ hasText: "strategy benchmark" })).toBeVisible();
      await page.keyboard.press("Escape");
    }
  });
});
