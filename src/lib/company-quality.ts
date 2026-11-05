import "server-only";

import { evaluateCompanyQuality, type CompanyQualityTier } from "@/domain/scanner/companyQuality";
import { qualityGateFor, type QualityGate } from "@/domain/scanner/qualityGate";
import { parseCompanyFacts } from "@/domain/scanner/secCompanyFacts";
import { prisma } from "./prisma";

/**
 * Company-quality readings from the SEC's free "Company Facts" data, cached in the database and shown next to each
 * candidate. Read-only toward every outside service; the only outside host contacted is sec.gov.
 *
 * SEC fair-access rules this module follows: every request carries a User-Agent that identifies the requester with a
 * contact address (read from the SEC_USER_AGENT environment variable, never written to the repo), and requests are spaced
 * far below the SEC's 10-per-second limit.
 *
 * Reads tolerate a database that has not had the company-quality migration applied yet: they report "not configured"
 * (and nothing is gated), so the code can be deployed before or after the migration without breaking any page.
 */

export const QUALITY_FRESH_DAYS = 7;
const REQUEST_SPACING_MS = 250;
const REQUEST_TIMEOUT_MS = 20_000;
const TICKER_MAP_TTL_MS = 12 * 60 * 60 * 1000;
export const QUALITY_REFRESH_BATCH_SIZE = 8;
const TICKER_PATTERN = /^[A-Z][A-Z0-9.\-]{0,9}$/;

export type CompanyQualityView = {
  ticker: string;
  status: "OK" | "NOT_FOUND" | "FAILED";
  tier: CompanyQualityTier | null;
  reasons: string[];
  runwayQuarters: number | null;
  dataAgeDays: number | null;
  fetchedAt: string;
  reviewed: { note: string; at: string } | null;
  gate: QualityGate | null;
};

export function secUserAgent(): string | null {
  const value = process.env.SEC_USER_AGENT?.trim();
  // The SEC asks for a name and a contact address; require an @ so a placeholder cannot slip through.
  return value && value.includes("@") ? value : null;
}

export function normalizeQualityTicker(raw: string): string | null {
  const ticker = raw.trim().toUpperCase();
  return TICKER_PATTERN.test(ticker) ? ticker : null;
}

function isNotSetUpError(error: unknown): boolean {
  if (!error || typeof error !== "object") return false;
  const code = (error as { code?: string }).code;
  if (code === "P2021" || code === "P2022") return true;
  const message = String((error as { message?: string }).message ?? "");
  return /CompanyQuality/.test(message) && /does not exist|doesn't exist|no such table/i.test(message);
}

const TIERS = new Set(["A", "B", "CAUTION", "VERIFY", "REJECT"]);

/** Cached readings plus the owner's reviews for these tickers. `configured` is false when nothing should be gated. */
export async function getCompanyQualityForUser(
  userId: string,
  tickers: string[],
): Promise<{ configured: boolean; secReady: boolean; byTicker: Record<string, CompanyQualityView> }> {
  const secReady = secUserAgent() !== null;
  const normalized = [...new Set(tickers.map(normalizeQualityTicker).filter((t): t is string => t !== null))];
  try {
    const [snapshots, reviews] = await Promise.all([
      prisma.companyQualitySnapshot.findMany({ where: { ticker: { in: normalized } } }),
      prisma.companyQualityReview.findMany({ where: { userId, ticker: { in: normalized } } }),
    ]);
    const reviewByTicker = new Map(reviews.map((row) => [row.ticker, row]));
    const snapshotByTicker = new Map(snapshots.map((row) => [row.ticker, row]));
    const configured = secReady;
    const byTicker: Record<string, CompanyQualityView> = {};
    for (const ticker of normalized) {
      const snapshot = snapshotByTicker.get(ticker);
      const review = reviewByTicker.get(ticker);
      const tier = snapshot?.tier && TIERS.has(snapshot.tier) ? (snapshot.tier as CompanyQualityTier) : null;
      const reviewed = review ? { note: review.note, at: review.reviewedAt.toISOString() } : null;
      byTicker[ticker] = {
        ticker,
        status: (snapshot?.status as CompanyQualityView["status"]) ?? "NOT_FOUND",
        tier,
        reasons: Array.isArray(snapshot?.reasons) ? (snapshot!.reasons as unknown[]).filter((r): r is string => typeof r === "string") : [],
        runwayQuarters: snapshot?.runwayQuarters ?? null,
        dataAgeDays: snapshot?.dataAgeDays ?? null,
        fetchedAt: snapshot?.fetchedAt.toISOString() ?? "",
        reviewed,
        gate: qualityGateFor({ configured, tier, reviewed: reviewed !== null }),
      };
      if (!snapshot) byTicker[ticker].status = "NOT_FOUND";
    }
    return { configured, secReady, byTicker };
  } catch (error) {
    if (isNotSetUpError(error)) return { configured: false, secReady, byTicker: {} };
    throw error;
  }
}

/** Tickers (of those asked about) that have no reading or a reading older than QUALITY_FRESH_DAYS. */
export async function tickersNeedingQualityRefresh(tickers: string[], now = new Date()): Promise<string[]> {
  const normalized = [...new Set(tickers.map(normalizeQualityTicker).filter((t): t is string => t !== null))];
  if (!normalized.length) return [];
  try {
    const rows = await prisma.companyQualitySnapshot.findMany({ where: { ticker: { in: normalized } }, select: { ticker: true, fetchedAt: true, status: true } });
    const cutoff = now.getTime() - QUALITY_FRESH_DAYS * 86_400_000;
    const fresh = new Set(rows.filter((row) => row.status !== "FAILED" && row.fetchedAt.getTime() >= cutoff).map((row) => row.ticker));
    return normalized.filter((ticker) => !fresh.has(ticker));
  } catch (error) {
    if (isNotSetUpError(error)) return [];
    throw error;
  }
}

// --- SEC access -----------------------------------------------------------------------------------------------------

let tickerMap: { at: number; byTicker: Map<string, string> } | null = null;
let lastRequestAt = 0;

async function secFetchJson(url: string, userAgent: string): Promise<{ ok: true; json: unknown } | { ok: false; status: number | "TIMEOUT" | "ERROR" }> {
  const wait = REQUEST_SPACING_MS - (Date.now() - lastRequestAt);
  if (wait > 0) await new Promise((resolve) => setTimeout(resolve, wait));
  lastRequestAt = Date.now();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    const response = await fetch(url, { headers: { "User-Agent": userAgent, Accept: "application/json" }, signal: controller.signal, cache: "no-store" });
    if (!response.ok) return { ok: false, status: response.status };
    return { ok: true, json: await response.json() };
  } catch (error) {
    return { ok: false, status: (error as { name?: string })?.name === "AbortError" ? "TIMEOUT" : "ERROR" };
  } finally {
    clearTimeout(timer);
  }
}

async function cikFor(ticker: string, userAgent: string, now: number): Promise<string | null | "UNAVAILABLE"> {
  if (!tickerMap || now - tickerMap.at > TICKER_MAP_TTL_MS) {
    const result = await secFetchJson("https://www.sec.gov/files/company_tickers.json", userAgent);
    if (!result.ok) return "UNAVAILABLE";
    const byTicker = new Map<string, string>();
    for (const entry of Object.values((result.json ?? {}) as Record<string, { cik_str?: number | string; ticker?: string }>)) {
      if (entry && typeof entry.ticker === "string" && entry.cik_str !== undefined) byTicker.set(entry.ticker.toUpperCase(), String(entry.cik_str).padStart(10, "0"));
    }
    tickerMap = { at: now, byTicker };
  }
  return tickerMap.byTicker.get(ticker) ?? tickerMap.byTicker.get(ticker.replace(".", "-")) ?? null;
}

export type QualityRefreshOutcome =
  | { ok: true; processed: number; remaining: number; notFound: number; failed: number }
  | { ok: false; error: string };

/** Refreshes up to QUALITY_REFRESH_BATCH_SIZE of the given tickers. Call again until `remaining` is 0. */
export async function refreshCompanyQuality(tickers: string[], now = new Date()): Promise<QualityRefreshOutcome> {
  const userAgent = secUserAgent();
  if (!userAgent) return { ok: false, error: "The SEC contact setting (SEC_USER_AGENT) is not configured on the server yet." };
  const stale = await tickersNeedingQualityRefresh(tickers, now);
  const batch = stale.slice(0, QUALITY_REFRESH_BATCH_SIZE);
  let notFound = 0;
  let failed = 0;
  for (const ticker of batch) {
    const cik = await cikFor(ticker, userAgent, now.getTime());
    if (cik === "UNAVAILABLE") {
      return { ok: false, error: "Could not reach the SEC right now. Try again in a minute." };
    }
    if (cik === null) {
      notFound += 1;
      await upsertSnapshot(ticker, { status: "NOT_FOUND", cik: null, sic: null, tier: "VERIFY", reasons: ["No SEC filings were found for this ticker (it may be a fund, a foreign company, or a very recent listing), so quality cannot be judged automatically."], runwayQuarters: null, fcfTtm: null, dataAgeDays: null, failureReason: null }, now);
      continue;
    }
    const facts = await secFetchJson(`https://data.sec.gov/api/xbrl/companyfacts/CIK${cik}.json`, userAgent);
    if (!facts.ok) {
      failed += 1;
      if (facts.status === 404) {
        notFound += 1;
        await upsertSnapshot(ticker, { status: "NOT_FOUND", cik, sic: null, tier: "VERIFY", reasons: ["The SEC has no financial-statement data for this company, so quality cannot be judged automatically."], runwayQuarters: null, fcfTtm: null, dataAgeDays: null, failureReason: null }, now);
        failed -= 1;
      } else {
        await markFailed(ticker, facts.status === 429 ? "RATE_LIMITED" : "SEC_FETCH_FAILED", now);
      }
      continue;
    }
    const submissions = await secFetchJson(`https://data.sec.gov/submissions/CIK${cik}.json`, userAgent);
    const sicRaw = submissions.ok ? Number((submissions.json as { sic?: string | number } | null)?.sic) : NaN;
    const sic = Number.isFinite(sicRaw) && sicRaw > 0 ? sicRaw : null;
    const quality = evaluateCompanyQuality(parseCompanyFacts(facts.json, { now, sic }));
    await upsertSnapshot(ticker, { status: "OK", cik, sic, tier: quality.tier, reasons: quality.reasons, runwayQuarters: quality.runwayQuarters, fcfTtm: quality.fcfTtm, dataAgeDays: null, failureReason: null }, now);
  }
  const remaining = Math.max(0, stale.length - batch.length);
  return { ok: true, processed: batch.length, remaining, notFound, failed };
}

type SnapshotValues = {
  status: "OK" | "NOT_FOUND";
  cik: string | null;
  sic: number | null;
  tier: CompanyQualityTier;
  reasons: string[];
  runwayQuarters: number | null;
  fcfTtm: number | null;
  dataAgeDays: number | null;
  failureReason: null;
};

async function upsertSnapshot(ticker: string, values: SnapshotValues, now: Date) {
  await prisma.companyQualitySnapshot.upsert({
    where: { ticker },
    create: { ticker, ...values, fetchedAt: now },
    update: { ...values, fetchedAt: now },
  });
}

/** A failed refresh keeps any previous good reading (only the status/failure fields change). */
async function markFailed(ticker: string, reason: "RATE_LIMITED" | "SEC_FETCH_FAILED", now: Date) {
  const existing = await prisma.companyQualitySnapshot.findUnique({ where: { ticker }, select: { ticker: true } });
  if (existing) {
    await prisma.companyQualitySnapshot.update({ where: { ticker }, data: { status: "FAILED", failureReason: reason } });
  } else {
    await prisma.companyQualitySnapshot.create({ data: { ticker, status: "FAILED", failureReason: reason, fetchedAt: now } });
  }
}

// --- Owner reviews --------------------------------------------------------------------------------------------------

export type SaveReviewResult = { ok: true } | { ok: false; error: string };

export async function saveCompanyQualityReview(userId: string, rawTicker: string, rawNote: string): Promise<SaveReviewResult> {
  const ticker = normalizeQualityTicker(rawTicker);
  if (!ticker) return { ok: false, error: "That ticker doesn't look valid." };
  const note = rawNote.trim();
  if (note.length < 10) return { ok: false, error: "Write a sentence or two about why you are comfortable with this company (at least 10 characters)." };
  if (note.length > 600) return { ok: false, error: "Keep the note under 600 characters." };
  const snapshot = await prisma.companyQualitySnapshot.findUnique({ where: { ticker }, select: { tier: true } });
  if (snapshot?.tier === "REJECT") return { ok: false, error: "A REJECT reading cannot be overridden while it persists." };
  await prisma.companyQualityReview.upsert({
    where: { userId_ticker: { userId, ticker } },
    create: { userId, ticker, note },
    update: { note, reviewedAt: new Date() },
  });
  return { ok: true };
}

export async function removeCompanyQualityReview(userId: string, rawTicker: string): Promise<SaveReviewResult> {
  const ticker = normalizeQualityTicker(rawTicker);
  if (!ticker) return { ok: false, error: "That ticker doesn't look valid." };
  await prisma.companyQualityReview.deleteMany({ where: { userId, ticker } });
  return { ok: true };
}
