import { Badge } from "@/components/ui";
import { LivePositionAssessmentBadge, LivePositionAssessmentEvidenceLine } from "@/components/live-position-assessment-badge";
import type { PositionToReviewDisplayRow } from "@/lib/dashboard-view";
import { money, shortCalendarDate } from "@/lib/format";

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
  return (
    <div className="flex items-center justify-between gap-3 rounded-lg border border-zinc-800 bg-zinc-900 px-3.5 py-2.5">
      <div className="min-w-0">
        <div className="flex items-baseline gap-2">
          <span className="text-lg font-bold text-zinc-100">{row.ticker}</span>
          {row.legType ? (
            <span className="text-[15px] text-zinc-300 tabular-nums">
              {money(row.strike)} {row.legType === "PUT" ? "Put" : "Call"}
              {row.expiration ? ` · ${shortCalendarDate(row.expiration)}` : ""}
            </span>
          ) : null}
        </div>
        <div className="mt-0.5 text-xs text-zinc-500">
          {row.stage}
          {row.quantity !== null ? ` · ${row.quantity} ${row.quantityUnit}` : ""}
        </div>
        {row.display ? <LivePositionAssessmentEvidenceLine display={row.display} now={now} /> : null}
      </div>
      <div className="flex shrink-0 items-center gap-2">
        {row.display ? <LivePositionAssessmentBadge display={row.display} now={now} /> : <Badge tone="neutral">{loading ? "Checking…" : "Review needed"}</Badge>}
      </div>
    </div>
  );
}
