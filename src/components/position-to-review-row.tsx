import { DteBadge } from "@/components/dte-badge";
import { Badge } from "@/components/ui";
import { LivePositionAssessmentBadge, LivePositionAssessmentEvidenceLine } from "@/components/live-position-assessment-badge";
import { CreditKeptMeter } from "@/components/credit-kept-meter";
import { PositionStrikeGauge } from "@/components/position-strike-gauge";
import type { PositionToReviewDisplayRow } from "@/domain/finance/positionReviewRows";
import { money, shortCalendarDate } from "@/lib/format";
import { activityTone, currentActivityLabel } from "@/domain/finance/positionActivity";
import { daysToExpiration } from "@/domain/finance/marketSession";
import { dteChipLabel } from "@/domain/finance/strikeGauge";

/**
 * Attention-First Freshness Phase 1 (Codex blocker repair B1) - the one compact row renderer used
 * by Dashboard's "Open Positions" list AND the new client-side "Attention Now" list
 * (client-freshness.tsx), so a row can never look visually different depending on which section
 * renders it. Deliberately has no "use client" directive of its own and no server-only imports -
 * safe to render from either a Server Component tree (Open Positions, server-rendered) or a Client
 * Component tree (Attention Now, client-filtered) - LivePositionAssessmentBadge/EvidenceLine are
 * themselves already client components and work as children from either.
 *
 * Dashboard visual pass - laid out like a trading watchlist row: identity + contract on the left, a
 * price-vs-strike gauge in the middle (active legs only), the assessment badge on the right, and a
 * thin accent rail colored by the SAME activity tone the badge uses. Presentation only - the
 * activity label, settlement detection, evidence line and badge are all exactly what they were.
 */
const RAIL_BY_TONE = {
  info: "border-l-sky-400",
  warn: "border-l-amber-400",
  neutral: "border-l-zinc-700",
} as const;

export function PositionToReviewRowView({ row, now = new Date(), loading = false }: { row: PositionToReviewDisplayRow; now?: Date; loading?: boolean }) {
  // Compact position UX - the SAME louder activity-first label/color Tracker's cards use (never a
  // second, independently-invented interpretation of `row.stage`), so Dashboard's triage view and
  // Tracker's investigation view never disagree about what state a position is in. Weekend /
  // Settlement Clarity - now also expiration-aware (row.expiration is the currently open leg's own
  // expiration, put or call - see positionsToReviewRows), so an expired-unresolved covered call
  // reads SETTLEMENT PENDING here exactly like an expired put, never left looking still-active.
  // `row.display` lets this recognize a SAME-DAY, session-ended expiration too (blocker repair B1)
  // - never waiting for the calendar date to roll over.
  const activityLabel = currentActivityLabel(row.stage, row.expiration, now, row.display);
  const awaitingSettlement = activityLabel === "SETTLEMENT PENDING";
  const tone = activityTone(activityLabel);
  // An awaiting-settlement leg has no meaningful "days left"/price-vs-strike story - never draw a
  // gauge or a countdown for it (a negative DTE next to "DTE" reads too easily as an active one).
  const dteValue = !awaitingSettlement && row.expiration ? daysToExpiration(row.expiration, now) : null;
  const dteLabel = dteChipLabel(dteValue);
  const showGauge = !awaitingSettlement && row.display !== null;
  // Credit kept only applies to a still-active short put; never shown for a settlement-pending leg.
  const creditKept = !awaitingSettlement ? (row.creditKept ?? null) : null;
  const showMiddle = showGauge || creditKept !== null;
  return (
    <div className={`grid items-center gap-x-4 gap-y-2 rounded-lg border border-l-[3px] border-zinc-800 bg-zinc-900 px-3.5 py-2.5 ${RAIL_BY_TONE[tone]} ${showMiddle ? "md:grid-cols-[minmax(0,1.1fr)_minmax(0,1fr)_9.75rem]" : "md:grid-cols-[minmax(0,1fr)_auto]"}`}>
      <div className="min-w-0">
        <div className="flex flex-wrap items-baseline gap-x-2 gap-y-1">
          <span className="text-lg font-bold tracking-tight text-zinc-50">{row.ticker}</span>
          <Badge tone={tone}>{activityLabel}</Badge>
          {dteLabel ? <DteBadge dte={dteValue} short /> : null}
        </div>
        {row.legType ? (
          <div className="mt-1 text-[13px] text-zinc-300 tabular-nums">
            {money(row.strike)} {row.legType === "PUT" ? "Put" : "Call"}
            {/* Weekend / Settlement Clarity - an expired-unresolved leg reads "expired <date>",
                never the same forward-looking date phrasing an active, future-dated leg gets -
                a past date alone (or a negative DTE elsewhere) is too easy to misread as active. */}
            {row.expiration ? ` · ${awaitingSettlement ? "expired " : ""}${shortCalendarDate(row.expiration)}` : ""}
            {row.quantity !== null ? ` · ${row.quantity}${row.quantityUnit === "contracts" ? "x" : " sh"}` : ""}
          </div>
        ) : null}
        {row.display ? <LivePositionAssessmentEvidenceLine display={row.display} now={now} /> : null}
      </div>
      {showMiddle ? (
        <div className="space-y-1.5">
          {showGauge && row.display ? <PositionStrikeGauge display={row.display} now={now} /> : null}
          {creditKept ? <CreditKeptMeter summary={creditKept} /> : null}
        </div>
      ) : null}
      <div className="flex shrink-0 items-center gap-2 md:justify-end">
        {row.display ? <LivePositionAssessmentBadge display={row.display} now={now} /> : <Badge tone="neutral">{loading ? "Checking…" : "Review needed"}</Badge>}
      </div>
    </div>
  );
}
