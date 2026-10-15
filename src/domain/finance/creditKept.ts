import { getCurrentOpenPut, type CampaignEventInput } from "./campaigns";
import { resolveCurrentCostToClose, type LinkedPositionRecordInput, type OptionMarkSnapshotInput } from "./currentPositionMark";
import { round } from "./calculations";
import { summarizeCampaignProgress } from "./performance";

/**
 * Dashboard "credit kept" - how much of a short put campaign's collected premium is still ours if
 * the leg were bought back at its current mark: (net credit - cost to close) / net credit.
 *
 * This module adds NO new accounting. Every input is an existing, already-guarded value:
 * the campaign's net option premium and projected-OTM applicability come from
 * summarizeCampaignProgress, and the cost to close comes from resolveCurrentCostToClose (exact
 * contract/account/quantity matching, freshness and provenance rules, missing stays missing).
 * Only the final ratio is new, and it returns null - never a guessed number - whenever any of
 * those inputs is absent, contradictory, or not meaningful (no net credit to measure against).
 *
 * `keptPercent` can be negative: that means buying the put back now would cost more than the
 * credit collected (the leg is currently losing money). It is NOT a probability and NOT advice.
 * A number is `provisional` unless the price is a verified market timestamp AND fees are known -
 * the same gating the Tracker's own current-P/L status uses (CONFIRMED vs PENDING).
 */
export type CreditKeptSummary = {
  /** Campaign net option premium collected, in dollars (rolls included, never gross). */
  netCredit: number;
  /** Total dollars to buy the current put leg back, from the validated mark. */
  costToClose: number;
  /** netCredit - costToClose, in dollars. */
  keptAmount: number;
  /** keptAmount / netCredit * 100, one decimal. May be negative. */
  keptPercent: number;
  /** True unless the mark carries a verified pricing time and fees are fully known. */
  provisional: boolean;
  /** Where the mark came from - shown to the user so a snapshot is never mistaken for a live quote. */
  sourceLabel: string;
  /** The time the mark was valued (verified) or retrieved (snapshot). */
  asOf: Date;
  verifiedPricingTime: boolean;
};

export type CreditKeptCampaignInput = {
  status: string;
  accountId: string;
  ticker: string;
  events: CampaignEventInput[];
};

export function summarizeOpenPutCreditKept({
  campaign,
  linkedRecords,
  optionMark,
  feesFullyKnown,
  now,
}: {
  campaign: CreditKeptCampaignInput;
  linkedRecords: LinkedPositionRecordInput[];
  optionMark: OptionMarkSnapshotInput | null;
  feesFullyKnown: boolean;
  now: Date;
}): CreditKeptSummary | null {
  // Short puts only: an assigned campaign's covered call has no validated mark path yet.
  if (campaign.status !== "OPEN") return null;
  const activePut = getCurrentOpenPut(campaign.events);
  const source = resolveCurrentCostToClose({
    campaignStatus: campaign.status,
    campaignAccountId: campaign.accountId,
    campaignTicker: campaign.ticker,
    activePut,
    linkedRecords,
    optionMark,
    now,
  });
  if (!source) return null;

  const verifiedPricingTime = source.provenance === "VERIFIED_MARKET_TIMESTAMP";
  const progress = summarizeCampaignProgress({
    status: campaign.status as Parameters<typeof summarizeCampaignProgress>[0]["status"],
    events: campaign.events,
    currentCostToClose: source.costToClose,
    costToCloseVerified: verifiedPricingTime,
    feesFullyKnown,
    asOf: now,
  });
  if (!progress.projectedOtmApplicable || progress.currentCostToClose === null || progress.currentPL === null) return null;
  if (progress.netPremiumStatus === "INCOMPLETE") return null;
  // A net debit (or zero) campaign has no credit to be a percentage of.
  if (!(progress.netPremiumCollected > 0)) return null;

  return {
    netCredit: progress.netPremiumCollected,
    costToClose: progress.currentCostToClose,
    keptAmount: progress.currentPL,
    keptPercent: round((progress.currentPL / progress.netPremiumCollected) * 100, 1),
    provisional: progress.currentPLStatus !== "CONFIRMED",
    sourceLabel: source.label,
    asOf: source.asOf,
    verifiedPricingTime,
  };
}
