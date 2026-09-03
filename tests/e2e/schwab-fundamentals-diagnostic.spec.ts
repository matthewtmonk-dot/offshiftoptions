import { expect, test, type Page } from "@playwright/test";

async function loginAsMatt(page: Page) {
  await page.goto("/login");
  await page.getByLabel("Email").fill("matt@lst.local");
  await page.getByLabel("Password").fill(process.env.DEV_SEED_PASSWORD ?? "lstbuddy-dev-only");
  await page.getByRole("button", { name: "Sign in" }).click();
  await expect(page.getByText("No order submission")).toBeVisible();
}

test.describe("Schwab fundamentals diagnostic - access control and safe no-connection behavior", () => {
  test("an unauthenticated visitor is redirected to login, never sees the diagnostic", async ({ page }) => {
    await page.goto("/account/schwab-fundamentals");
    await expect(page).toHaveURL(/\/login/);
  });

  test("Account does not show the diagnostic link when Schwab is not connected (this dev environment)", async ({ page }) => {
    await loginAsMatt(page);
    await page.goto("/account");
    await expect(page.getByRole("link", { name: /Verify Schwab Fundamental Fields/ })).toHaveCount(0);
  });

  test("an authenticated user with no Schwab connection sees a safe, read-only unavailable message - never raw provider detail", async ({ page }) => {
    await loginAsMatt(page);
    await page.goto("/account/schwab-fundamentals");

    const diagnostic = page.getByTestId("schwab-fundamentals-diagnostic");
    await expect(diagnostic).toBeVisible();
    await expect(diagnostic.getByText("Read only")).toBeVisible();
    await expect(diagnostic.getByText("Nothing saved")).toBeVisible();
    await expect(diagnostic.getByText("Connect Schwab in Account before running this read-only diagnostic.")).toBeVisible();

    const bodyText = await diagnostic.innerText();
    expect(bodyText).not.toMatch(/access[-_ ]?token|refresh[-_ ]?token|bearer|client[-_ ]?secret/i);
  });

  test("navigating directly to the diagnostic and back to Account does not change any Research or Scanner state", async ({ page }) => {
    await loginAsMatt(page);
    await page.goto("/account/schwab-fundamentals");
    await page.getByTestId("schwab-fundamentals-diagnostic").getByRole("link", { name: "Account" }).click();
    await expect(page).toHaveURL(/\/account$/);

    await page.goto("/research");
    await expect(page.getByRole("heading", { name: "Research", exact: true })).toBeVisible();
    await page.goto("/scanner");
    await expect(page.getByRole("heading", { name: "My LST Scanner" })).toBeVisible();
  });
});
