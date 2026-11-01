import "server-only";

import { summarizeCampaign } from "@/domain/finance/campaigns";
import { themeKeyOf, type ExistingExposure } from "@/domain/portfolio/portfolioPlan";
import { themeForTicker } from "@/domain/portfolio/themes";
import type { CompanyClassification } from "@/domain/portfolio/candidates";
import { getTickerFundamentalsMap } from "./alpha-vantage-fundamentals";
import { prisma } from "./prisma";
import { runSchwabBalancesDiagnosticForUser } from "./schwab-balances-diagnostic";

export type PlanExposure = {
  existing: ExistingExposure[];
  /** Open campaigns whose collateral / share basis could not be determined; the plan must not be trusted while > 0. */
  unknownCount: number;
};

/** Sector / industry from the shared Alpha Vantage cache (public company data). Missing tickers are simply absent. */
export async function getClassificationForTickers(tickers: string[]): Promise<Record<string, CompanyClassification>> {
  const map = await getTickerFundamentalsMap(tickers);
  return Object.fromEntries([...map].map(([ticker, row]) => [ticker, { companyName: row.name, sector: row.sector, industry: row.industry }]));
}

/** What is already committed, per company: open put collateral and the cost basis of assigned shares still held. */
export async function getPlanExposureForUser(userId: string): Promise<PlanExposure> {
  const campaigns = await prisma.campaign.findMany({
    where: { ownerId: userId, status: { in: ["OPEN", "ASSIGNED"] } },
    include: { events: { orderBy: [{ occurredAt: "asc" }, { sortOrder: "asc" }] } },
  });

  const rows: Array<{ ticker: string; kind: "PUT" | "SHARES"; amount: number }> = [];
  let unknownCount = 0;
  for (const campaign of campaigns) {
    const summary = summarizeCampaign({ status: campaign.status, events: campaign.events });
    if (campaign.status === "OPEN") {
      if (summary.currentCollateralCommitted === null) unknownCount += 1;
      else rows.push({ ticker: campaign.ticker, kind: "PUT", amount: summary.currentCollateralCommitted });
    } else if (campaign.status === "ASSIGNED" && summary.sharesHeld > 0) {
      if (summary.remainingShareBasis === null) unknownCount += 1;
      else rows.push({ ticker: campaign.ticker, kind: "SHARES", amount: summary.remainingShareBasis });
    }
  }

  const classification = await getClassificationForTickers(rows.map((row) => row.ticker));
  const existing = rows.map((row): ExistingExposure => {
    const info = classification[row.ticker];
    const sector = info?.sector ?? null;
    return { ...row, sector, theme: themeKeyOf({ theme: themeForTicker(row.ticker), industry: info?.industry ?? null, sector }) };
  });
  return { existing, unknownCount };
}

export type TradingCapital =
  | { ok: true; availableToTrade: number; accountValue: number; cashBalance: number | null; unsettledCash: number | null; accountType: string | null; asOf: string }
  | { ok: false; message: string };

/**
 * Schwab's own cash-available-for-trading figure (thinkorswim's "Option Buying Power" on this cash account, verified
 * equal on Nov 1, 2026) plus account value. Read-only; nothing is saved.
 */
export async function getTradingCapitalForUser(userId: string): Promise<TradingCapital> {
  const result = await runSchwabBalancesDiagnosticForUser(userId);
  if (result.status !== "OK") return { ok: false, message: result.message };
  if (result.balances.malformedResponse) return { ok: false, message: "Schwab answered, but without account balances." };
  const current = new Map(result.balances.current.map((field) => [field.name, field.value]));
  const availableToTrade = current.get("cashAvailableForTrading");
  const accountValue = current.get("liquidationValue");
  if (availableToTrade === undefined || accountValue === undefined) {
    return { ok: false, message: "Schwab did not report cash available for trading or account value for this account type." };
  }
  return { ok: true, availableToTrade, accountValue, cashBalance: current.get("cashBalance") ?? null, unsettledCash: current.get("unsettledCash") ?? null, accountType: result.balances.accountType, asOf: result.timestamp };
}
