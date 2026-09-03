import { chromium, expect, type Page } from "@playwright/test";

type RouteKey = "Dashboard" | "Scanner" | "Research" | "Tracker";

type NavSample = {
  durationMs: number;
  rscCount: number;
  clickRscCount: number;
  prefetchRscCount?: number;
  rscPaths: string[];
  loadingShellDisplayed: boolean;
  cachedContentDisplayed: boolean;
};

type Summary = {
  medianDurationMs: number;
  medianRscCount: number;
  loadingShellDisplayedSamples: number;
  cachedContentDisplayedSamples: number;
  samples: NavSample[];
};

const baseURL = process.env.PLAYWRIGHT_BASE_URL ?? "http://localhost:3001";
const sampleCount = Number(process.env.PERF_SAMPLES ?? 5);
const runCacheProbe = process.env.PERF_CACHE_PROBE === "1";
const password = process.env.DEV_SEED_PASSWORD ?? "lstbuddy-dev-only";

const routes: Record<RouteKey, { label: string; heading: RegExp | string; loading: string }> = {
  Dashboard: { label: "Dashboard", heading: /Hey Matt/, loading: "Loading Dashboard" },
  Scanner: { label: "Scanner", heading: "My LST Scanner", loading: "Loading Scanner" },
  Research: { label: "Research", heading: /^Research$/, loading: "Loading Research" },
  Tracker: { label: "Tracker", heading: "Tracker", loading: "Loading Tracker" },
};

const firstVisitPairs: [RouteKey, RouteKey][] = [
  ["Dashboard", "Scanner"],
  ["Dashboard", "Research"],
  ["Scanner", "Research"],
];

const recentReturnPairs: [RouteKey, RouteKey, RouteKey][] = [
  ["Scanner", "Research", "Scanner"],
  ["Research", "Dashboard", "Research"],
  ["Dashboard", "Tracker", "Dashboard"],
];

const routerCachePairs: [RouteKey, RouteKey, RouteKey][] = [
  ["Dashboard", "Scanner", "Dashboard"],
  ["Scanner", "Research", "Scanner"],
  ["Research", "Dashboard", "Research"],
  ["Dashboard", "Tracker", "Dashboard"],
];

let browser: Awaited<ReturnType<typeof chromium.launch>>;

main().catch(async (error: unknown) => {
  if (browser) {
    await browser.close();
  }
  console.error(error);
  process.exitCode = 1;
});

async function main() {
  browser = await chromium.launch();
  try {
    const firstVisit: Record<string, Summary> = {};
    for (const [from, to] of firstVisitPairs) {
      firstVisit[`${from}->${to}`] = await summarizeSamples(() => measureFirstVisit(from, to));
    }

    const recentReturn: Record<string, Summary> = {};
    for (const [from, via, back] of recentReturnPairs) {
      recentReturn[`${from}->${via}->${back}`] = await summarizeSamples(() => measureRecentReturn(from, via, back));
    }

    const intentPrefetch = {
      "hover Scanner then click": await summarizeSamples(() => measureIntentPrefetch({ hover: true })),
      "click Scanner no prior hover": await summarizeSamples(() => measureIntentPrefetch({ hover: false })),
    };
    const idlePrefetchCount = await measureIdlePrivatePrefetchCount();
    const routerCacheProbe = runCacheProbe ? await measureRouterCacheProbe() : "skipped";

    console.log(
      JSON.stringify(
        {
          baseURL,
          samples: sampleCount,
          idlePrivateRscPrefetchCount: idlePrefetchCount,
          firstVisit,
          recentReturn,
          intentPrefetch,
          routerCacheProbe,
        },
        null,
        2,
      ),
    );
  } finally {
    await browser.close();
  }
}

async function summarizeSamples(run: () => Promise<NavSample>): Promise<Summary> {
  const samples: NavSample[] = [];
  for (let index = 0; index < sampleCount; index += 1) {
    samples.push(await run());
  }

  return {
    medianDurationMs: median(samples.map((sample) => sample.durationMs)),
    medianRscCount: median(samples.map((sample) => sample.rscCount)),
    loadingShellDisplayedSamples: samples.filter((sample) => sample.loadingShellDisplayed).length,
    cachedContentDisplayedSamples: samples.filter((sample) => sample.cachedContentDisplayed).length,
    samples,
  };
}

async function measureFirstVisit(from: RouteKey, to: RouteKey): Promise<NavSample> {
  const page = await newLoggedInPage();
  try {
    await navigateTo(page, from);
    return await measureNavigation(page, to);
  } finally {
    await page.context().close();
  }
}

async function measureRecentReturn(from: RouteKey, via: RouteKey, back: RouteKey): Promise<NavSample> {
  const page = await newLoggedInPage();
  try {
    await navigateTo(page, from);
    await navigateTo(page, via);
    return await measureNavigation(page, back);
  } finally {
    await page.context().close();
  }
}

async function measureIntentPrefetch({ hover }: { hover: boolean }): Promise<NavSample> {
  const page = await newLoggedInPage();
  try {
    await navigateTo(page, "Dashboard");
    const recorder = recordRsc(page);
    const rscStart = recorder.paths.length;
    if (hover) {
      await navLink(page, "Scanner").hover();
      await page.waitForTimeout(350);
    }
    const clickStart = recorder.paths.length;

    const sample = await measureNavigation(page, "Scanner", recorder, { rscStart, clickStart });
    if (hover) {
      sample.prefetchRscCount = clickStart - rscStart;
    }
    return sample;
  } finally {
    await page.context().close();
  }
}

async function measureIdlePrivatePrefetchCount() {
  const page = await newLoggedInPage();
  try {
    const recorder = recordRsc(page);
    await page.waitForTimeout(1500);
    return recorder.paths.filter((path) => path !== "/dashboard").length;
  } finally {
    await page.context().close();
  }
}

async function measureRouterCacheProbe() {
  const delays = [5, 15, 30, 60];
  const result: Record<string, Record<string, NavSample>> = {};
  for (const [from, via, back] of routerCachePairs) {
    const key = `${from}->${via}->${back}`;
    result[key] = {};
    for (const delay of delays) {
      const page = await newLoggedInPage();
      try {
        await navigateTo(page, from);
        await navigateTo(page, via);
        await page.waitForTimeout(delay * 1000);
        result[key][`${delay}s`] = await measureNavigation(page, back);
      } finally {
        await page.context().close();
      }
    }
  }
  return result;
}

async function newLoggedInPage() {
  const context = await browser.newContext({ baseURL, serviceWorkers: "block", viewport: { width: 1366, height: 768 } });
  const page = await context.newPage();
  await page.goto("/login");
  await page.getByLabel("Email").fill("matt@lst.local");
  await page.getByLabel("Password").fill(password);
  await page.getByRole("button", { name: "Sign in" }).click();
  await waitForRoute(page, "Dashboard");
  return page;
}

async function navigateTo(page: Page, route: RouteKey) {
  if (route === "Dashboard" && new URL(page.url()).pathname === "/dashboard") {
    await waitForRoute(page, route);
    return;
  }

  await navLink(page, route).click();
  await waitForRoute(page, route);
}

async function measureNavigation(
  page: Page,
  route: RouteKey,
  existingRecorder?: ReturnType<typeof recordRsc>,
  options: { rscStart?: number; clickStart?: number } = {},
): Promise<NavSample> {
  const recorder = existingRecorder ?? recordRsc(page);
  const rscStart = options.rscStart ?? recorder.paths.length;
  let loadingShellDisplayed = false;

  const startedAt = Date.now();
  await navLink(page, route).click();
  while (Date.now() - startedAt < 15_000) {
    if ((await page.getByText(routes[route].loading).count()) > 0) {
      loadingShellDisplayed = true;
    }
    if ((await page.getByRole("heading", { name: routes[route].heading }).count()) > 0) {
      break;
    }
    await page.waitForTimeout(25);
  }
  await waitForRoute(page, route);
  const durationMs = Date.now() - startedAt;

  const rscPaths = recorder.paths.slice(rscStart);
  const clickRscPaths = recorder.paths.slice(options.clickStart ?? rscStart);
  return {
    durationMs,
    rscCount: rscPaths.length,
    clickRscCount: clickRscPaths.length,
    rscPaths,
    loadingShellDisplayed,
    cachedContentDisplayed: durationMs < 200 && !loadingShellDisplayed && clickRscPaths.length === 0,
  };
}

function navLink(page: Page, route: RouteKey) {
  return page.locator("aside").getByRole("link", { name: routes[route].label, exact: true });
}

async function waitForRoute(page: Page, route: RouteKey) {
  await expect(page.getByRole("heading", { name: routes[route].heading })).toBeVisible({ timeout: 15_000 });
}

function recordRsc(page: Page) {
  const paths: string[] = [];
  page.on("request", (request) => {
    const url = new URL(request.url());
    if (url.searchParams.has("_rsc")) {
      paths.push(url.pathname);
    }
  });
  return { paths };
}

function median(values: number[]) {
  const sorted = [...values].sort((left, right) => left - right);
  return sorted[Math.floor(sorted.length / 2)] ?? 0;
}
