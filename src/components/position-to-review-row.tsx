import { Badge } from "@/components/ui";
import { LivePositionAssessmentBadge, LivePositionAssessmentEvidenceLine } from "@/components/live-position-assessment-badge";
import type { PositionToReviewDisplayRow } from "@/domain/finance/positionReviewRows";
import { money, shortCalendarDate } from "@/lib/format";
import { activityTone, currentActivityLabel } from "@/domain/finance/positionActivity";

/**
 * Attention-First Freshness Phase 1 (Codex blocker repair B1) - the one compact row renderer used
 * by Dashboard's "Open Positions" list AND the new client-side "Attention Now" list
 * (client-freshness.tsx), so a row can never look visually different depending on which section
 * renders it. Deliberately has no "use client" directive of its own and no server-only imports -
 * safe to render from either a Server Component tree (Open Positions, server-rendered) or a Client
 * Component tree (Attention Now, client-filtered) - LivePositionAssessmentBadge/EvidenceLine are
 * themselves already client components and work as children from either.
 */
export function PositionToReviewRowView({ row, now = new Date(), loading = false }: { row: PositionToReviewDisplayRow; now?: Date; loading?: boolean }) {
  // Compact position UX - the SAME louder activity-first label/color Tracker's cards use (never a
  // second, independently-invented interpretation of `row.stage`), so Dashboard's triage view and
  // Tracker's investigation view never disagree about what state a position is in. Weekend /
  // Settlement Clarity - now also expiration-aware (row.expiration is the currently open leg's own
  // expiration, put or call - see positionsToReviewRows), so an expired-unresolved covered call
  // reads SETTLEMENT PENDING here exactly like an expired put, never left looking still-active.
  const activityLabel = currentActivityLabel(row.stage, row.expiration, now);
  const awaitingSettlement = activityLabel === "SETTLEMENT PENDING";
  return (
    <div className="flex items-center justify-between gap-3 rounded-lg border border-zinc-800 bg-zinc-900 px-3 py-2">
      <div className="min-w-0">
        <div className="flex flex-wrap items-baseline gap-1.5">
          <span className="text-base font-bold text-zinc-100">{row.ticker}</span>
          <Badge tone={activityTone(activityLabel)}>{activityLabel}</Badge>
          {row.legType ? (
            <span className="text-[13px] text-zinc-300 tabular-nums">
              {money(row.strike)} {row.legType === "PUT" ? "Put" : "Call"}
              {/* Weekend / Settlement Clarity - an expired-unresolved leg reads "expired <date>",
                  never the same forward-looking date phrasing an active, future-dated leg gets -
                  a past date alone (or a negative DTE elsewhere) is too easy to misread as active. */}
              {row.expiration ? ` · ${awaitingSettlement ? "expired " : ""}${shortCalendarDate(row.expiration)}` : ""}
              {row.quantity !== null ? ` · ${row.quantity}${row.quantityUnit === "contracts" ? "x" : " sh"}` : ""}
            </span>
          ) : null}
        </div>
        {row.display ? <LivePositionAssessmentEvidenceLine display={row.display} now={now} /> : null}
      </div>
      <div className="flex shrink-0 items-center gap-2">
        {row.display ? <LivePositionAssessmentBadge display={row.display} now={now} /> : <Badge tone="neutral">{loading ? "Checking…" : "Review needed"}</Badge>}
      </div>
    </div>
  );
}
