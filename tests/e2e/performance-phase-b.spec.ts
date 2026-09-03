import { expect, test, type Locator, type Page } from "@playwright/test";

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

async function signOut(page: Page) {
  await page.getByRole("button", { name: "Sign out" }).click();
  await expect(page.getByRole("heading", { name: "Off Shift Options" })).toBeVisible();
}

function collectRscPaths(page: Page) {
  const paths: string[] = [];
  page.on("request", (request) => {
    const url = new URL(request.url());
    if (url.searchParams.has("_rsc")) {
      paths.push(url.pathname);
    }
  });
  return paths;
}

async function gotoDashboard(page: Page, name: "Matt" | "Eric" = "Matt") {
  await page.locator("aside").getByRole("link", { name: "Dashboard", exact: true }).click();
  await expect(page.getByRole("heading", { name: new RegExp(`Hey ${name}`) })).toBeVisible();
}

async function assertOpensNewPage(link: Locator, expectedPath: string, options: Parameters<Locator["click"]>[0]) {
  const context = link.page().context();
  const popupPromise = context.waitForEvent("page", { timeout: 7_500 });
  await link.click(options);
  const popup = await popupPromise;
  await popup.waitForURL((url) => url.pathname === expectedPath, { timeout: 7_500 });
  expect(new URL(popup.url()).pathname).toBe(expectedPath);
  await popup.close();
}

async function defaultPreventedForModifiedClicks(link: Locator) {
  return link.evaluate((element) => {
    const cases = {
      ctrl: { ctrlKey: true, button: 0 },
      cmd: { metaKey: true, button: 0 },
      shift: { shiftKey: true, button: 0 },
      middle: { button: 1 },
      right: { button: 2 },
    };

    return Object.fromEntries(
      Object.entries(cases).map(([name, init]) => {
        let defaultPrevented = false;
        document.addEventListener(
          "click",
          (event) => {
            defaultPrevented = event.defaultPrevented;
            event.preventDefault();
          },
          { once: true },
        );
        const event = new MouseEvent("click", { bubbles: true, cancelable: true, ...init });
        element.dispatchEvent(event);
        return [name, defaultPrevented];
      }),
    );
  });
}

async function createPrivateMattFixtures(page: Page, ticker: string) {
  await page.goto("/research");
  await page.getByPlaceholder("Ticker").fill(ticker);
  await page.getByRole("button", { name: "Add" }).click();
  await expect(page.getByTestId("research-desktop-table").getByRole("row", { name: new RegExp(ticker) })).toBeVisible();

  await page.locator("aside").getByRole("link", { name: "Tracker", exact: true }).click();
  await expect(page.getByRole("heading", { name: "Tracker" })).toBeVisible();
  const newCampaignPanel = page.locator("details").filter({ hasText: "New Campaign" }).first();
  const isOpen = await newCampaignPanel.evaluate((element) => (element as HTMLDetailsElement).open);
  if (!isOpen) {
    await newCampaignPanel.locator("summary").click();
  }

  await newCampaignPanel.locator('input[name="ticker"]').fill(ticker);
  await newCampaignPanel.locator('input[name="strike"]').fill("12");
  await newCampaignPanel.locator('input[name="premium"]').fill("0.34");
  await newCampaignPanel.locator('select[name="visibility"]').selectOption("PRIVATE");
  await newCampaignPanel.getByRole("button", { name: "Create Campaign" }).click();
  await expect(page.getByText(ticker).first()).toBeVisible();
}

async function startForbiddenTextMonitor(page: Page, forbidden: string) {
  const installMonitor = (text: string) => {
    const key = "__osoForbiddenTextLeaks";
    const win = window as typeof window & { __osoForbiddenTextObserver?: MutationObserver };
    const readLeaks = () => JSON.parse(window.sessionStorage.getItem(key) ?? "[]") as Array<{ url: string; text: string }>;
    const writeLeaks = (leaks: Array<{ url: string; text: string }>) => window.sessionStorage.setItem(key, JSON.stringify(leaks));
    window.sessionStorage.setItem(key, "[]");
    win.__osoForbiddenTextObserver?.disconnect();

    const recordIfPresent = () => {
      const bodyText = document.body?.innerText ?? "";
      if (!bodyText.includes(text)) {
        return;
      }
      writeLeaks([...readLeaks(), { url: window.location.href, text: bodyText.slice(0, 500) }]);
    };

    win.__osoForbiddenTextObserver = new MutationObserver(recordIfPresent);
    win.__osoForbiddenTextObserver.observe(document.documentElement, { childList: true, subtree: true, characterData: true });
    recordIfPresent();
  };

  await page.addInitScript(installMonitor, forbidden);
  await page.evaluate(installMonitor, forbidden);
}

async function expectNoForbiddenTextLeaks(page: Page) {
  const leaks = await page.evaluate(() => JSON.parse(window.sessionStorage.getItem("__osoForbiddenTextLeaks") ?? "[]"));
  expect(leaks).toEqual([]);
}

test.describe("Performance Phase B", () => {
  test("intent-prefetch links preserve normal browser link semantics", async ({ page }) => {
    await loginAsMatt(page);

    let scannerLink = page.locator("aside").getByRole("link", { name: "Scanner", exact: true });
    await expect(scannerLink).toHaveAttribute("href", "/scanner");

    await scannerLink.click();
    await expect(page.getByRole("heading", { name: "My LST Scanner" })).toBeVisible();

    await gotoDashboard(page);
    scannerLink = page.locator("aside").getByRole("link", { name: "Scanner", exact: true });
    await scannerLink.focus();
    await page.keyboard.press("Enter");
    await expect(page.getByRole("heading", { name: "My LST Scanner" })).toBeVisible();

    await gotoDashboard(page);
    scannerLink = page.locator("aside").getByRole("link", { name: "Scanner", exact: true });
    expect(await defaultPreventedForModifiedClicks(scannerLink)).toEqual({
      ctrl: false,
      cmd: false,
      shift: false,
      middle: false,
      right: false,
    });
    await expect(page).toHaveURL(/\/dashboard$/);

    await assertOpensNewPage(scannerLink, "/scanner", { modifiers: ["Control"] });

    await page.bringToFront();
    await expect(page).toHaveURL(/\/dashboard$/);
    await assertOpensNewPage(page.locator("aside").getByRole("link", { name: "Scanner", exact: true }), "/scanner", { button: "middle" });

    await page.bringToFront();
    scannerLink = page.locator("aside").getByRole("link", { name: "Scanner", exact: true });
    await scannerLink.click({ button: "right" });
    await expect(page).toHaveURL(/\/dashboard$/);
  });

  test("idle app does not recreate the private-route storm, and hover warms only the intended route", async ({ page }) => {
    const rscPaths = collectRscPaths(page);

    await loginAsMatt(page);
    await page.waitForTimeout(1500);

    expect(rscPaths.filter((path) => path !== "/dashboard")).toEqual([]);

    rscPaths.length = 0;
    await page.locator("aside").getByRole("link", { name: "Scanner", exact: true }).hover();
    await page.waitForTimeout(750);

    expect([...new Set(rscPaths)]).toEqual(["/scanner"]);
    expect(rscPaths).toHaveLength(2);
    expect(rscPaths.filter((path) => path !== "/scanner")).toEqual([]);
  });

  test("recently visited private routes reuse cached content without the route loading shell", async ({ page }) => {
    await loginAsMatt(page);
    await page.locator("aside").getByRole("link", { name: "Scanner", exact: true }).click();
    await expect(page.getByRole("heading", { name: "My LST Scanner" })).toBeVisible();
    await page.locator("aside").getByRole("link", { name: "Research", exact: true }).click();
    await expect(page.getByRole("heading", { name: "Research", exact: true })).toBeVisible();

    const rscPaths = collectRscPaths(page);
    await page.locator("aside").getByRole("link", { name: "Scanner", exact: true }).click();
    await expect(page.getByRole("heading", { name: "My LST Scanner" })).toBeVisible();
    await page.waitForTimeout(300);

    expect(rscPaths.filter((path) => path === "/scanner")).toHaveLength(0);
    await expect(page.getByText("Loading Scanner")).toHaveCount(0);
  });

  test("same-tab logout and user switch never reuses another user's private route cache", async ({ page }) => {
    await loginAsMatt(page);
    const ticker = `PB${Date.now() % 100000}`;
    await createPrivateMattFixtures(page, ticker);

    await gotoDashboard(page);
    await expect(page.getByText(ticker).first()).toBeVisible();
    await page.locator("aside").getByRole("link", { name: "Research", exact: true }).click();
    await expect(page.getByTestId("research-desktop-table").getByRole("row", { name: new RegExp(ticker) })).toBeVisible();
    await page.locator("aside").getByRole("link", { name: "Tracker", exact: true }).click();
    await expect(page.getByText(ticker).first()).toBeVisible();

    await signOut(page);
    await startForbiddenTextMonitor(page, ticker);
    await page.getByLabel("Email").fill("eric@lst.local");
    await page.getByLabel("Password").fill(process.env.DEV_SEED_PASSWORD ?? "lstbuddy-dev-only");
    await page.getByRole("button", { name: "Sign in" }).click();
    await expect(page.getByRole("heading", { name: "Hey Eric" })).toBeVisible();
    await expect(page.getByText(ticker)).toHaveCount(0);

    await page.locator("aside").getByRole("link", { name: "Research", exact: true }).click();
    await expect(page.getByRole("heading", { name: "Research", exact: true })).toBeVisible();
    await expect(page.getByText(ticker)).toHaveCount(0);

    await gotoDashboard(page, "Eric");
    await expect(page.getByText(ticker)).toHaveCount(0);

    await page.locator("aside").getByRole("link", { name: "Tracker", exact: true }).click();
    await expect(page.getByRole("heading", { name: "Tracker" })).toBeVisible();
    await expect(page.getByText(ticker)).toHaveCount(0);
    await expectNoForbiddenTextLeaks(page);
  });
});
