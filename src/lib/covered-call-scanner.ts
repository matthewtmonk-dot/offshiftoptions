import "server-only";

import { evaluateCoveredCallCampaign, expirationWindowFor, weeklyHorizonFor, type CoveredCallCampaignScan } from "@/domain/scanner/covered-call-scan";
import { scannerRulesFromRecords } from "@/domain/scanner/profile";
import type { OptionContractSnapshot } from "@/providers/market-data/types";
import { getAssignedCampaignsForCoveredCallScanForUser } from "./app-data";
import { getSchwabMarketDataProviderForUser } from "./broker-connections";
import { DEFAULT_ROLL_BUFFER_PERCENT } from "@/domain/finance/rollStatus";
import { EARNINGS_SCANNER_TRUST_WINDOW_MS, getEarningsEvidenceLookup } from "./earnings-calendar-cache";
import { marketDate } from "@/domain/finance/marketCalendar";
import { getQuoteSnapshotsForUser } from "./live-quotes";
import { prisma } from "./prisma";
import { ensureMyLstScannerProfileForUser } from "./workflows";

export type CoveredCallScanForUser = {
  /** False when the user has no usable Schwab market-data connection - every eligible campaign's
   * reasonCode then reads CHAIN_UNAVAILABLE rather than silently looking empty. Campaigns already
   * ineligible on share count alone (NO_SHARES_AVAILABLE/FULLY_COVERED) are unaffected either way -
   * they never needed a chain request. */
  schwabConnected: boolean;
  campaigns: CoveredCallCampaignScan[];
};

/**
 * Covered Call scanner orchestration (Covered Call Phase 4, see PROJECT_HANDOFF.md) - a
 * deliberately separate path from rerunLiveSchwabScannerForUser (the CSP live scan). This is
 * read-only decision support: it never places, previews, modifies, or cancels a broker order, and
 * never creates a CampaignEvent, BrokerRecord, or ScanRun - nothing here persists anything.
 * Computed fresh on every call (like the Tracker's own live Roll Status), not stored as scan
 * history.
 *
 * The universe is exactly this user's own ASSIGNED campaigns (see
 * getAssignedCampaignsForCoveredCallScanForUser) - never a market-wide scan, never another user's
 * or account's shares. Liquidity/DTE/earnings thresholds are reused from the user's existing "My
 * LST" ScannerProfile where directionally appropriate (see covered-call-scan.ts's own audit of
 * which CSP rules apply) rather than standing up a second parallel profile.
 */
export async function getCoveredCallScanForUser(userId: string, asOf: Date = new Date()): Promise<CoveredCallScanForUser> {
  const campaigns = await getAssignedCampaignsForCoveredCallScanForUser(userId);
  if (!campaigns.length) {
    return { schwabConnected: false, campaigns: [] };
  }

  const tickers = [...new Set(campaigns.map((campaign) => campaign.ticker.toUpperCase()))];

  const [profile, settings, quotes, earnings, provider] = await Promise.all([
    ensureMyLstScannerProfileForUser(userId),
    prisma.userSettings.findUnique({ where: { userId }, select: { rollBufferPercent: true } }),
    getQuoteSnapshotsForUser(userId, tickers),
    getEarningsEvidenceLookup(tickers, asOf, EARNINGS_SCANNER_TRUST_WINDOW_MS),
    getSchwabMarketDataProviderForUser(userId),
  ]);
  const records = await prisma.scannerRule.findMany({ where: { profileId: profile.id }, orderBy: { sortOrder: "asc" } });
  const rules = scannerRulesFromRecords(records, { includeCoveredCallRules: true });
  const rollBufferPercent = Number(settings?.rollBufferPercent ?? DEFAULT_ROLL_BUFFER_PERCENT);
  const horizon = expirationWindowFor(weeklyHorizonFor(rules), asOf);

  const chainsByTicker = new Map<string, OptionContractSnapshot[] | null>();
  if (provider) {
    await Promise.all(
      tickers.map(async (ticker) => {
        try {
          const chain = await provider.getOptionChain(ticker, { ...horizon, contractType: "CALL" });
          chainsByTicker.set(ticker, chain);
        } catch {
          // A chain fetch failure is evidence-incomplete, never treated as "no contracts."
          chainsByTicker.set(ticker, null);
        }
      }),
    );
  }

  const scans = campaigns.map((campaign) => {
    const ticker = campaign.ticker.toUpperCase();
    const evidence = earnings.get(ticker);
    const dated = evidence && (evidence.status === "SCHEDULED" || evidence.status === "STALE") && evidence.reportDate ? evidence : null;
    return evaluateCoveredCallCampaign({
      campaignId: campaign.id,
      ticker: campaign.ticker,
      events: campaign.events,
      status: campaign.status,
      currentPrice: quotes.get(ticker)?.price ?? null,
      options: provider ? (chainsByTicker.get(ticker) ?? null) : null,
      rules,
      earnings: dated?.reportDate
        ? {
            daysUntilReport: Math.round((dated.reportDate.getTime() - marketDate(asOf).getTime()) / (24 * 60 * 60 * 1000)),
            reportDate: dated.reportDate.toISOString().slice(0, 10),
            evidence: dated.status as "SCHEDULED" | "STALE",
          }
        : null,
      earningsEvidence: dated ? undefined : evidence?.status === "AMBIGUOUS" ? "AMBIGUOUS" : "NO_EVIDENCE",
      rollBufferPercent,
      asOf,
    });
  });

  return { schwabConnected: provider !== null, campaigns: scans };
}
