import { expect, test } from "@playwright/test";

test.beforeEach(async ({ page }) => {
  const password = process.env.DEV_SEED_PASSWORD;
  if (!password) throw new Error("Set DEV_SEED_PASSWORD for local browser tests.");
  await page.goto("/login");
  await page.getByLabel("Email").fill("matt@lst.local");
  await page.getByLabel("Password").fill(password);
  await page.getByRole("button", { name: "Sign in" }).click();
  await expect(page.getByRole("heading", { name: /Hey Matt/ })).toBeVisible();
});

test("dashboard dates its scan and social previews and clarifies navigation", async ({ page }) => {
  await expect(page.getByTestId("dashboard-scan-time").locator("time")).toHaveAttribute("datetime", /T/);
  for (const title of ["Buddy Chat", "Buddy Activity"]) {
    const panel = page.locator("section").filter({ has: page.getByRole("heading", { name: title, exact: true }) });
    await expect(panel.locator("time").first()).toBeVisible();
    await expect(panel.locator("time").first()).toContainText(/E[DS]T/);
  }
  const sidebar = page.getByTestId("app-sidebar");
  await expect(sidebar.getByRole("link", { name: /Notifications/ })).toBeVisible();
  await expect(sidebar.getByRole("link", { name: /Chat/ })).toBeVisible();
  await expect(sidebar.getByRole("link", { name: /Alerts/ })).toHaveCount(0);
});

test("dashboard stays readable at desktop and mobile widths in both themes", async ({ page }, testInfo) => {
  for (const width of [1440, 390]) {
    await page.setViewportSize({ width, height: 1000 });
    for (const theme of ["light", "dark"]) {
      await page.evaluate((value) => document.documentElement.setAttribute("data-theme", value), theme);
      await expect.poll(() => page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 2)).toBe(true);
      await expect(page.getByRole("link", { name: /Notifications/ }).filter({ visible: true })).toBeVisible();
      await page.screenshot({ path: testInfo.outputPath(`dashboard-${width}-${theme}.png`), fullPage: true, animations: "disabled" });
    }
  }
});
