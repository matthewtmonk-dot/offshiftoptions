import "server-only";

import { earningsFloorFrom, latestReportedPeriod, type EarningsFloor } from "@/domain/finance/earningsFloor";
import { marketDate } from "@/domain/finance/marketCalendar";
import { cikFor, normalizeQualityTicker, secFetchJson, secUserAgent } from "./company-quality";
import { prisma } from "./prisma";

/**
 * "No earnings before" floors from SEC filings (the rule itself is in domain/finance/earningsFloor.ts), stored per
 * ticker in SecReportedPeriod. Public data only; the only outside host contacted is sec.gov, through the same
 * identified, throttled fetch the company-quality check uses.
 *
 * Nothing here is allowed to break a scan or an option check: every read tolerates a database that has not had the
 * migration applied (it simply reports no floors, so every earnings rule behaves exactly as before), and every SEC or
 * database failure is swallowed. A stored period never needs refreshing while its floor is still in the future - a newer
 * filing could only move the floor later.
 */

/** Stop starting new SEC requests after this long, so an option-check batch stays quick. */
export const EARNINGS_FLOOR_FETCH_BUDGET_MS = 8_000;
export const EARNINGS_FLOOR_MAX_FETCHES = 20;
/** A stored period whose floor has passed: the next report is probably filed within weeks, so look again daily. */
const PASSED_FLOOR_RECHECK_MS = 20 * 60 * 60 * 1000;
/** No 10-Q/10-K at all (a fund or a foreign filer): unlikely to change, look again weekly. */
const NO_REPORT_RECHECK_MS = 7 * 24 * 60 * 60 * 1000;

type StoredPeriod = { ticker: string; form: string | null; periodEnd: Date | null; filedAt: Date | null; fetchedAt: Date };

function normalize(tickers: string[]): string[] {
  return [...new Set(tickers.map(normalizeQualityTicker).filter((ticker): ticker is string => ticker !== null))];
}

/** The floor a stored period implies, only while it is still in the future. */
function usableFloor(row: StoredPeriod | undefined, today: Date): EarningsFloor | null {
  if (!row || !row.periodEnd || !row.filedAt || (row.form !== "10-Q" && row.form !== "10-K")) return null;
  const floor = earningsFloorFrom({ form: row.form, periodEnd: row.periodEnd, filedAt: row.filedAt });
  return floor.notBefore > today.toISOString().slice(0, 10) ? floor : null;
}

async function readStored(tickers: string[]): Promise<Map<string, StoredPeriod>> {
  const rows: StoredPeriod[] = await prisma.secReportedPeriod.findMany({
    where: { ticker: { in: tickers } },
    select: { ticker: true, form: true, periodEnd: true, filedAt: true, fetchedAt: true },
  });
  return new Map(rows.map((row) => [row.ticker, row]));
}

function floorsFrom(stored: Map<string, StoredPeriod>, today: Date): Map<string, EarningsFloor> {
  const floors = new Map<string, EarningsFloor>();
  for (const [ticker, row] of stored) {
    const floor = usableFloor(row, today);
    if (floor) floors.set(ticker, floor);
  }
  return floors;
}

/** Stored floors only - never contacts the SEC. Keyed by upper-case ticker; empty on any failure. */
export async function getEarningsFloorLookup(tickers: string[], now: Date = new Date()): Promise<Map<string, EarningsFloor>> {
  const normalized = normalize(tickers);
  if (!normalized.length) return new Map();
  try {
    return floorsFrom(await readStored(normalized), marketDate(now));
  } catch {
    return new Map();
  }
}

/**
 * Stored floors, after first asking the SEC about any of these tickers that has nothing stored (or whose stored
 * answer is due a re-check). Bounded by EARNINGS_FLOOR_MAX_FETCHES and EARNINGS_FLOOR_FETCH_BUDGET_MS; tickers are
 * served in the order given. Never throws.
 */
export async function ensureEarningsFloors(tickers: string[], now: Date = new Date()): Promise<Map<string, EarningsFloor>> {
  const normalized = normalize(tickers);
  if (!normalized.length) return new Map();
  const today = marketDate(now);
  let stored: Map<string, StoredPeriod>;
  try {
    stored = await readStored(normalized);
  } catch {
    return new Map(); // table not set up (or database unavailable): no floors, earnings rules behave as before
  }

  const userAgent = secUserAgent();
  if (userAgent) {
    const due = normalized.filter((ticker) => {
      const row = stored.get(ticker);
      if (!row) return true;
      if (usableFloor(row, today)) return false;
      return now.getTime() - row.fetchedAt.getTime() > (row.periodEnd ? PASSED_FLOOR_RECHECK_MS : NO_REPORT_RECHECK_MS);
    });
    const startedAt = Date.now();
    try {
      for (const ticker of due.slice(0, EARNINGS_FLOOR_MAX_FETCHES)) {
        if (Date.now() - startedAt > EARNINGS_FLOOR_FETCH_BUDGET_MS) break;
        const cik = await cikFor(ticker, userAgent, now.getTime());
        if (cik === "UNAVAILABLE") break;
        let period = null;
        if (cik !== null) {
          const submissions = await secFetchJson(`https://data.sec.gov/submissions/CIK${cik}.json`, userAgent);
          if (!submissions.ok) {
            if (submissions.status === 404) await save(stored, { ticker, cik, period: null }, now);
            continue; // any other failure: keep whatever is stored and try again another time
          }
          period = latestReportedPeriod(submissions.json, today);
        }
        await save(stored, { ticker, cik, period }, now);
      }
    } catch {
      // keep what was read and written so far
    }
  }
  return floorsFrom(stored, today);
}

async function save(
  stored: Map<string, StoredPeriod>,
  entry: { ticker: string; cik: string | null; period: ReturnType<typeof latestReportedPeriod> },
  now: Date,
) {
  const values = {
    cik: entry.cik,
    form: entry.period?.form ?? null,
    periodEnd: entry.period?.periodEnd ?? null,
    filedAt: entry.period?.filedAt ?? null,
    fetchedAt: now,
  };
  await prisma.secReportedPeriod.upsert({ where: { ticker: entry.ticker }, create: { ticker: entry.ticker, ...values }, update: values });
  stored.set(entry.ticker, { ticker: entry.ticker, ...values });
}
