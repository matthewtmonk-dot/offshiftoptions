import { reasonMessage, type CoveredCallCampaignScan, type CoveredCallCandidate } from "@/domain/scanner/covered-call-scan";
import type { CoveredCallScanForUser } from "@/lib/covered-call-scanner";
import { Badge, EmptyState } from "@/components/ui";
import { money, percent, shortCalendarDate } from "@/lib/format";

/**
 * Covered Call scanner UI (Covered Call Phase 4, see PROJECT_HANDOFF.md) - one compact card per
 * ASSIGNED campaign, never a market-wide results table. Read-only decision support: nothing here
 * links to placing, previewing, modifying, or cancelling a broker order.
 */
export function CoveredCallScannerSection({ scan, highlightTicker }: { scan: CoveredCallScanForUser; highlightTicker: string | null }) {
  if (!scan.campaigns.length) {
    return <EmptyState>No assigned shares are currently available for covered calls.</EmptyState>;
  }

  const ordered = highlightTicker
    ? [...scan.campaigns].sort((left, right) => Number(right.ticker.toUpperCase() === highlightTicker.toUpperCase()) - Number(left.ticker.toUpperCase() === highlightTicker.toUpperCase()))
    : scan.campaigns;

  return (
    <div className="space-y-3">
      <p className="text-xs text-zinc-500">
        Read-only. Trade execution stays in Schwab/thinkorswim - nothing here places, previews, modifies, or cancels an order.
      </p>
      {!scan.schwabConnected ? (
        <div className="rounded-md border border-amber-400/30 bg-amber-400/10 px-3 py-2 text-sm text-amber-100">
          Connect Schwab in Account settings for live stock prices and option chains. Shares held and adjusted basis below are still accurate.
        </div>
      ) : null}
      {ordered.map((campaignScan) => (
        <CoveredCallCard key={campaignScan.campaignId} scan={campaignScan} highlighted={highlightTicker?.toUpperCase() === campaignScan.ticker.toUpperCase()} />
      ))}
    </div>
  );
}

function CoveredCallCard({ scan, highlighted }: { scan: CoveredCallCampaignScan; highlighted: boolean }) {
  const dte = scan.basisSafeCandidates[0]?.dte ?? scan.belowBasisCandidates[0]?.dte ?? scan.unknownBasisCandidates[0]?.dte ?? null;

  return (
    <div
      className={`rounded-lg border bg-zinc-950 p-4 shadow-sm shadow-black/20 ${highlighted ? "border-emerald-400/60" : "border-zinc-800"}`}
      data-testid={`covered-call-card-${scan.ticker}`}
    >
      <div className="flex flex-wrap items-center gap-2">
        <span className="text-xl font-semibold text-zinc-50">{scan.ticker}</span>
        <span className="text-sm text-zinc-400">{scan.sharesHeld} shares held</span>
        {scan.openCall ? <Badge tone="warn">Call open</Badge> : null}
      </div>

      <div className="mt-1 flex flex-wrap gap-x-4 gap-y-1 text-sm text-zinc-400">
        <span>Adjusted basis: {scan.adjustedBasis === null ? "UNKNOWN" : money(scan.adjustedBasis)}</span>
        <span>Current: {scan.currentPrice === null ? "Unavailable" : money(scan.currentPrice)}</span>
        <span>
          {scan.availableShares} shares available · up to {scan.maxContracts} {scan.maxContracts === 1 ? "call" : "calls"}
        </span>
      </div>

      {scan.earningsCriterion ? (
        <p className={`mt-1 text-xs ${scan.earningsCriterion.status === "FAIL" ? "text-amber-300" : "text-zinc-500"}`}>
          Earnings: {scan.earningsDate ? `${scan.earningsDate} (${scan.earningsDistance} days away)` : "UNKNOWN"}
          {scan.earningsCriterion.status === "FAIL" ? " · inside your earnings-distance minimum" : ""}
        </p>
      ) : null}

      {scan.openCall ? (
        <div className="mt-3 rounded-md border border-amber-900/50 bg-amber-950/20 p-3 text-sm text-amber-100">
          Shares already covered by an open call: {money(scan.openCall.strike)} strike · {shortCalendarDate(scan.openCall.expiration)} ·{" "}
          {scan.openCall.contracts} {scan.openCall.contracts === 1 ? "contract" : "contracts"}.
          {scan.availableShares >= 100 ? " Remaining uncovered shares are scanned below." : ""}
        </div>
      ) : null}

      {scan.reasonCode ? (
        <div className="mt-3 rounded-md border border-zinc-800 bg-zinc-900/50 p-3 text-sm text-zinc-400">{reasonMessage(scan.reasonCode)}</div>
      ) : null}

      {scan.selectedExpiration ? (
        <p className="mt-3 text-sm font-medium text-zinc-200">
          Weekly expiration: {shortCalendarDate(new Date(scan.selectedExpiration))}
          {dte !== null ? ` · ${dte} DTE` : ""}
        </p>
      ) : null}

      {scan.basisSafeCandidates.length ? <CandidateGroup title="Candidate strikes" candidates={scan.basisSafeCandidates} tone="safe" /> : null}
      {scan.belowBasisCandidates.length ? (
        <CandidateGroup title="Below basis - review manually" candidates={scan.belowBasisCandidates} tone="warn" />
      ) : null}
      {scan.unknownBasisCandidates.length ? (
        <CandidateGroup title="Candidate strikes (adjusted basis unknown)" candidates={scan.unknownBasisCandidates} tone="unknown" />
      ) : null}
    </div>
  );
}

function CandidateGroup({ title, candidates, tone }: { title: string; candidates: CoveredCallCandidate[]; tone: "safe" | "warn" | "unknown" }) {
  return (
    <div className="mt-3">
      <div className={`text-xs font-semibold uppercase tracking-normal ${tone === "warn" ? "text-amber-300" : "text-zinc-400"}`}>{title}</div>
      <div className="mt-1 space-y-2">
        {candidates.map((candidate) => (
          <CandidateRow key={`${candidate.strike}-${candidate.expiration}`} candidate={candidate} tone={tone} />
        ))}
      </div>
    </div>
  );
}

function CandidateRow({ candidate, tone }: { candidate: CoveredCallCandidate; tone: "safe" | "warn" | "unknown" }) {
  const distanceLabel =
    candidate.distanceStatus === null
      ? null
      : candidate.distanceStatus.color === "GREEN"
        ? "OTM"
        : candidate.distanceStatus.color === "AMBER"
          ? "NEAR STRIKE"
          : "ITM";
  const distanceTone = candidate.distanceStatus === null ? "neutral" : candidate.distanceStatus.color === "GREEN" ? "good" : candidate.distanceStatus.color === "AMBER" ? "warn" : "bad";

  return (
    <div className="grid gap-x-3 gap-y-1 border-t border-zinc-800 pt-2 text-sm sm:grid-cols-4" data-testid={`covered-call-candidate-${candidate.strike}`}>
      <div>
        <div className="font-semibold text-zinc-100">{money(candidate.strike)} Call</div>
        <div className="text-xs text-zinc-500">
          {shortCalendarDate(new Date(candidate.expiration))} · {candidate.dte} DTE
        </div>
      </div>
      <div>
        <div className="text-zinc-200">Bid {money(candidate.bid)}</div>
        <div className="text-xs text-zinc-500">Premium {money(candidate.premiumPerContract)}/contract</div>
      </div>
      <div>
        {distanceLabel ? <Badge tone={distanceTone}>{distanceLabel}</Badge> : <span className="text-xs text-zinc-500">Distance unavailable</span>}
        <div className="mt-1 text-xs text-zinc-500">{candidate.distanceStatus?.distanceText ?? "No current price"}</div>
      </div>
      <div>
        <div className="text-xs text-zinc-500">OI {candidate.openInterest ?? "UNKNOWN"}</div>
        <div className="text-xs text-zinc-500">Exit if called away: {money(candidate.effectiveExitPrice)}</div>
      </div>
      <div className="sm:col-span-4 flex flex-wrap gap-x-4 gap-y-1 text-xs text-zinc-400">
        {candidate.strikeVsBasis ? (
          <span>
            Strike vs basis: {candidate.strikeVsBasis.differenceDollars >= 0 ? "+" : ""}
            {money(candidate.strikeVsBasis.differenceDollars)} / {candidate.strikeVsBasis.differencePct >= 0 ? "+" : ""}
            {percent(candidate.strikeVsBasis.differencePct)}
          </span>
        ) : (
          <span>Strike vs basis: UNKNOWN</span>
        )}
        <span>
          Return on basis: {candidate.returnOnAdjustedBasisPercent === null ? "UNKNOWN" : `${percent(candidate.returnOnAdjustedBasisPercent)}`}
          {candidate.annualizedReturnOnAdjustedBasis !== null ? ` (${percent(candidate.annualizedReturnOnAdjustedBasis)} annualized)` : ""}
        </span>
        <span>
          Est. campaign outcome if called away:{" "}
          {candidate.estimatedCampaignPLIfCalledAway === null
            ? "UNKNOWN"
            : `${candidate.estimatedCampaignPLIfCalledAway >= 0 ? "+" : ""}${money(candidate.estimatedCampaignPLIfCalledAway)}`}
        </span>
        {!candidate.liquidityPass ? <span className="text-amber-300">Liquidity below your configured minimum</span> : null}
      </div>
      {tone === "warn" ? (
        <div className="sm:col-span-4 rounded-md border border-amber-900/50 bg-amber-950/20 p-2 text-xs text-amber-200">
          BELOW ADJUSTED BASIS - assignment at this strike would exit the shares below adjusted basis.
        </div>
      ) : null}
    </div>
  );
}
