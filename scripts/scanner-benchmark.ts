/**
 * One-off profiling/benchmark harness for the Scanner Responsiveness + Performance
 * slice (Sections C and I of that task). Not part of the app; run manually with:
 *
 *   npx tsx scripts/scanner-benchmark.ts
 *
 * There is no live Schwab OAuth connection available in this environment, so this
 * script cannot measure real Schwab network latency end to end. Instead it:
 *
 *  1. Measures REAL local Postgres overhead for persisting a scan run (the one stage
 *     that is fully measurable here), sequential vs bounded-concurrency writes.
 *  2. Measures the REAL wall-clock effect of bounded concurrency vs strictly
 *     sequential fetching in the actual `evaluateLiveMarketScan` algorithm, using a
 *     demo-data provider wrapped with an artificial per-call delay to stand in for
 *     network latency (explicitly a simulation - the delay value is an estimate, not
 *     a measured Schwab figure).
 *  3. Measures REAL cache-hit behavior (`withMarketDataCache`) by running a "cold"
 *     scan followed immediately by a "warm" scan against the same cached provider.
 */
import { performance } from "node:perf_hooks";
import { evaluateLiveMarketScan, SCAN_FETCH_CONCURRENCY, STARTER_LIVE_SCAN_UNIVERSE } from "../src/domain/scanner/live-scan";
import { defaultScannerRules } from "../src/domain/scanner/profile";
import { DemoMarketDataProvider } from "../src/providers/market-data/mock";
import { withMarketDataCache } from "../src/providers/market-data/cache";
import { mapWithConcurrency } from "../src/lib/concurrency";
import type { MarketDataProvider } from "../src/providers/market-data/types";
import { prisma } from "../src/lib/prisma";

const SCANNER_RULES = defaultScannerRules();

const SIMULATED_CALL_LATENCY_MS = 400; // rough external-REST-call estimate; NOT a measured Schwab figure
const SAMPLES = 5;

function median(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

function delay(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function withArtificialLatency(provider: MarketDataProvider, ms: number): MarketDataProvider {
  return {
    async getQuote(symbol) {
      await delay(ms);
      return provider.getQuote(symbol);
    },
    async getPriceHistory(symbol, days) {
      await delay(ms);
      return provider.getPriceHistory(symbol, days);
    },
    async getOptionChain(symbol) {
      await delay(ms);
      return provider.getOptionChain(symbol);
    },
    async getInstrument(symbol) {
      await delay(ms);
      return provider.getInstrument(symbol);
    },
    async getMarketHours(date) {
      await delay(ms);
      return provider.getMarketHours(date);
    },
  };
}

/** Serializes every call through the wrapped provider - simulates the old one-ticker-at-a-time loop. */
function withMaxConcurrency(provider: MarketDataProvider, limit: number): MarketDataProvider {
  let active = 0;
  const queue: (() => void)[] = [];

  async function gate<T>(run: () => Promise<T>): Promise<T> {
    if (active >= limit) {
      await new Promise<void>((resolve) => queue.push(resolve));
    }
    active += 1;
    try {
      return await run();
    } finally {
      active -= 1;
      const next = queue.shift();
      if (next) {
        next();
      }
    }
  }

  return {
    getQuote: (symbol: string) => gate(() => provider.getQuote(symbol)),
    getPriceHistory: (symbol: string, days: number) => gate(() => provider.getPriceHistory(symbol, days)),
    getOptionChain: (symbol: string) => gate(() => provider.getOptionChain(symbol)),
    getInstrument: (symbol: string) => gate(() => provider.getInstrument(symbol)),
    getMarketHours: (date: Date) => gate(() => provider.getMarketHours(date)),
  };
}

async function benchmarkFetchConcurrency() {
  console.log("\n=== Stock/option fetch: sequential vs bounded concurrency (simulated latency) ===");
  console.log(`Universe size: ${STARTER_LIVE_SCAN_UNIVERSE.length} tickers, simulated per-call latency: ${SIMULATED_CALL_LATENCY_MS}ms`);

  const baseProvider = withArtificialLatency(new DemoMarketDataProvider(), SIMULATED_CALL_LATENCY_MS);

  const sequentialTimes: number[] = [];
  for (let i = 0; i < SAMPLES; i += 1) {
    const provider = withMaxConcurrency(baseProvider, 1);
    const start = performance.now();
    await evaluateLiveMarketScan({ provider, rules: SCANNER_RULES, universe: STARTER_LIVE_SCAN_UNIVERSE });
    sequentialTimes.push(performance.now() - start);
  }

  const concurrentTimes: number[] = [];
  for (let i = 0; i < SAMPLES; i += 1) {
    const start = performance.now();
    await evaluateLiveMarketScan({ provider: baseProvider, rules: SCANNER_RULES, universe: STARTER_LIVE_SCAN_UNIVERSE });
    concurrentTimes.push(performance.now() - start);
  }

  console.log(`BEFORE (sequential, concurrency=1)  median: ${median(sequentialTimes).toFixed(0)}ms  samples: ${sequentialTimes.map((t) => t.toFixed(0)).join(", ")}`);
  console.log(`AFTER  (bounded, concurrency=${SCAN_FETCH_CONCURRENCY})       median: ${median(concurrentTimes).toFixed(0)}ms  samples: ${concurrentTimes.map((t) => t.toFixed(0)).join(", ")}`);
}

async function benchmarkCache() {
  console.log("\n=== Market-data cache: cold vs warm scan (real withMarketDataCache) ===");
  const cachedProvider = withMarketDataCache(
    withArtificialLatency(new DemoMarketDataProvider(), SIMULATED_CALL_LATENCY_MS),
    "benchmark:cache-test",
  );

  const coldStart = performance.now();
  await evaluateLiveMarketScan({ provider: cachedProvider, rules: SCANNER_RULES, universe: STARTER_LIVE_SCAN_UNIVERSE });
  const coldMs = performance.now() - coldStart;

  const warmStart = performance.now();
  await evaluateLiveMarketScan({ provider: cachedProvider, rules: SCANNER_RULES, universe: STARTER_LIVE_SCAN_UNIVERSE });
  const warmMs = performance.now() - warmStart;

  console.log(`Cold scan (no cache entries yet): ${coldMs.toFixed(0)}ms`);
  console.log(`Warm scan (same provider, run immediately after, within all TTLs): ${warmMs.toFixed(0)}ms`);
  console.log("Quote TTL 15s / price history TTL 1h / option-chain TTL 30s - a warm re-run inside those windows reuses cached data instead of making fresh calls.");
}

async function benchmarkPersist() {
  console.log("\n=== ScanResult persistence: sequential vs bounded concurrency (real local Postgres) ===");
  const matt = await prisma.user.findUniqueOrThrow({ where: { email: "matt@lst.local" }, select: { id: true } });
  const profile = await prisma.scannerProfile.findFirstOrThrow({ where: { ownerId: matt.id }, select: { id: true } });

  const candidateCount = STARTER_LIVE_SCAN_UNIVERSE.length;
  const createdRunIds: string[] = [];

  async function persistSequential() {
    const run = await prisma.scanRun.create({ data: { profileId: profile.id, ownerId: matt.id, source: "BENCHMARK" } });
    createdRunIds.push(run.id);
    for (let i = 0; i < candidateCount; i += 1) {
      await prisma.scanResult.create({
        data: {
          runId: run.id,
          ticker: `BENCH${i}`,
          summaryStatus: "PASS",
          passedCriteria: 5,
          totalCriteria: 5,
          snapshotJson: { price: 10 },
          criterionResults: { create: [{ criterionName: "Stock price", actualValue: "10", operator: "BETWEEN", desiredValue: "[5,30]", status: "PASS", explanation: "ok" }] },
        },
      });
    }
  }

  async function persistConcurrent() {
    const run = await prisma.scanRun.create({ data: { profileId: profile.id, ownerId: matt.id, source: "BENCHMARK" } });
    createdRunIds.push(run.id);
    await mapWithConcurrency(Array.from({ length: candidateCount }, (_, i) => i), 6, (i) =>
      prisma.scanResult.create({
        data: {
          runId: run.id,
          ticker: `BENCH${i}`,
          summaryStatus: "PASS",
          passedCriteria: 5,
          totalCriteria: 5,
          snapshotJson: { price: 10 },
          criterionResults: { create: [{ criterionName: "Stock price", actualValue: "10", operator: "BETWEEN", desiredValue: "[5,30]", status: "PASS", explanation: "ok" }] },
        },
      }),
    );
  }

  const sequentialTimes: number[] = [];
  for (let i = 0; i < SAMPLES; i += 1) {
    const start = performance.now();
    await persistSequential();
    sequentialTimes.push(performance.now() - start);
  }

  const concurrentTimes: number[] = [];
  for (let i = 0; i < SAMPLES; i += 1) {
    const start = performance.now();
    await persistConcurrent();
    concurrentTimes.push(performance.now() - start);
  }

  console.log(`${candidateCount} candidates per run, ${SAMPLES} samples each.`);
  console.log(`BEFORE (sequential creates)   median: ${median(sequentialTimes).toFixed(0)}ms  samples: ${sequentialTimes.map((t) => t.toFixed(0)).join(", ")}`);
  console.log(`AFTER  (concurrency=6 creates) median: ${median(concurrentTimes).toFixed(0)}ms  samples: ${concurrentTimes.map((t) => t.toFixed(0)).join(", ")}`);

  await prisma.scanRun.deleteMany({ where: { id: { in: createdRunIds } } });
}

async function main() {
  await benchmarkFetchConcurrency();
  await benchmarkCache();
  await benchmarkPersist();
  await prisma.$disconnect();
}

main().catch(async (error) => {
  console.error(error);
  await prisma.$disconnect();
  process.exitCode = 1;
});
