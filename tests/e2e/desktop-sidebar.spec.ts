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

async function sidebarWidth(page: Page): Promise<number> {
  const box = await page.getByTestId("app-sidebar").boundingBox();
  if (!box) throw new Error("app-sidebar not visible");
  return box.width;
}

test.describe("Desktop collapsible sidebar", () => {
  test.use({ viewport: { width: 1366, height: 800 } });

  test("starts expanded with no stored preference", async ({ page }) => {
    await loginAs(page, "Matt");
    const sidebar = page.getByTestId("app-sidebar");
    await expect(sidebar).toBeVisible();
    await expect(sidebar).toHaveAttribute("data-collapsed", "false");
    expect(await sidebarWidth(page)).toBeGreaterThan(200);
    await expect(sidebar.getByText("Off Shift Options", { exact: true })).toBeVisible();
  });

  test("collapsing narrows the sidebar and expanding restores it", async ({ page }) => {
    await loginAs(page, "Matt");
    const sidebar = page.getByTestId("app-sidebar");
    const toggle = page.getByTestId("sidebar-toggle");

    await toggle.click();
    await expect(sidebar).toHaveAttribute("data-collapsed", "true");
    await expect.poll(() => sidebarWidth(page)).toBeLessThan(100);
    expect(await sidebarWidth(page)).toBeGreaterThanOrEqual(56);

    await toggle.click();
    await expect(sidebar).toHaveAttribute("data-collapsed", "false");
    await expect.poll(() => sidebarWidth(page)).toBeGreaterThan(200);
  });

  test("main content genuinely reclaims the freed width when collapsed - not an overlay", async ({ page }) => {
    await loginAs(page, "Matt");
    await page.goto("/research");
    const main = page.locator("main");
    const expandedMainBox = await main.boundingBox();
    if (!expandedMainBox) throw new Error("main not visible");

    await page.getByTestId("sidebar-toggle").click();
    await expect(page.getByTestId("app-sidebar")).toHaveAttribute("data-collapsed", "true");
    const collapsedMainBox = await main.boundingBox();
    if (!collapsedMainBox) throw new Error("main not visible after collapse");

    expect(collapsedMainBox.width).toBeGreaterThan(expandedMainBox.width);
    // The sidebar's own box shrank; the two boxes must not overlap horizontally (no overlay).
    const sidebarBox = await page.getByTestId("app-sidebar").boundingBox();
    expect(sidebarBox).not.toBeNull();
    expect(collapsedMainBox.x).toBeGreaterThanOrEqual(sidebarBox!.x + sidebarBox!.width - 1);
  });

  test("collapsed preference survives client-side navigation", async ({ page }) => {
    await loginAs(page, "Matt");
    await page.getByTestId("sidebar-toggle").click();
    await expect(page.getByTestId("app-sidebar")).toHaveAttribute("data-collapsed", "true");

    await page.getByRole("link", { name: "Research" }).click();
    await expect(page).toHaveURL(/\/research/);
    await expect(page.getByTestId("app-sidebar")).toHaveAttribute("data-collapsed", "true");
  });

  test("collapsed preference survives a full page refresh", async ({ page }) => {
    await loginAs(page, "Matt");
    await page.getByTestId("sidebar-toggle").click();
    await expect(page.getByTestId("app-sidebar")).toHaveAttribute("data-collapsed", "true");

    await page.reload();
    await expect(page.getByTestId("app-sidebar")).toHaveAttribute("data-collapsed", "true");
  });

  test("collapsed nav icons remain navigable, keyboard-focusable, and labeled", async ({ page }) => {
    await loginAs(page, "Matt");
    await page.getByTestId("sidebar-toggle").click();
    await expect(page.getByTestId("app-sidebar")).toHaveAttribute("data-collapsed", "true");

    const researchLink = page.getByTestId("app-sidebar").getByRole("link", { name: "Research" });
    await expect(researchLink).toHaveAttribute("aria-label", "Research");
    await researchLink.focus();
    await expect(researchLink).toBeFocused();
    await page.keyboard.press("Enter");
    await expect(page).toHaveURL(/\/research/);
  });

  test("active route is visually and semantically indicated in both expanded and collapsed states", async ({ page }) => {
    await loginAs(page, "Matt");
    await page.goto("/research");

    const expandedLink = page.getByTestId("app-sidebar").getByRole("link", { name: "Research" });
    await expect(expandedLink).toHaveAttribute("aria-current", "page");

    await page.getByTestId("sidebar-toggle").click();
    const collapsedLink = page.getByTestId("app-sidebar").getByRole("link", { name: "Research" });
    await expect(collapsedLink).toHaveAttribute("aria-current", "page");
  });

  test("theme, account, and sign-out controls remain reachable after expanding again", async ({ page }) => {
    await loginAs(page, "Matt");
    const toggle = page.getByTestId("sidebar-toggle");
    await toggle.click();
    await expect(page.getByTestId("app-sidebar")).toHaveAttribute("data-collapsed", "true");
    await expect(page.getByRole("button", { name: "Sign out" })).toBeVisible();

    await toggle.click();
    await expect(page.getByTestId("app-sidebar")).toHaveAttribute("data-collapsed", "false");
    await expect(page.getByRole("radiogroup", { name: "Appearance" })).toBeVisible();
    await expect(page.getByRole("button", { name: "Sign out" })).toBeVisible();
  });

  test("Research still renders and scrolls correctly with the sidebar collapsed, with no page-level horizontal overflow", async ({ page }) => {
    await loginAs(page, "Matt");
    await page.goto("/research");
    await page.getByTestId("sidebar-toggle").click();
    await expect(page.getByTestId("app-sidebar")).toHaveAttribute("data-collapsed", "true");
    await expect(page.getByTestId("research-desktop-table")).toBeVisible();

    const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
    expect(overflow).toBeLessThanOrEqual(1);
  });

  test("no page-level horizontal overflow while expanded either", async ({ page }) => {
    await loginAs(page, "Matt");
    await page.goto("/research");
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
    expect(overflow).toBeLessThanOrEqual(1);
  });
});

test.describe("Mobile navigation is unaffected by the desktop sidebar", () => {
  test.use({ viewport: { width: 390, height: 844 } });

  test("mobile shows the existing top nav, not a collapsed icon rail, and has no collapse toggle", async ({ page }) => {
    await loginAs(page, "Matt");
    await expect(page.getByTestId("app-sidebar")).toBeHidden();
    await expect(page.getByTestId("sidebar-toggle")).toBeHidden();
    await expect(page.getByRole("link", { name: "Research" })).toBeVisible();
  });

  test("mobile nav still navigates correctly", async ({ page }) => {
    await loginAs(page, "Matt");
    await page.getByRole("link", { name: "Research" }).click();
    await expect(page).toHaveURL(/\/research/);
  });
});
