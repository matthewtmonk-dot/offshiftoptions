import type { PositionEarningsNote } from "@/domain/finance/positionEarningsWarning";

/**
 * Earnings caution under an open position. Amber and visible when a report lands before the position's expiry (or
 * within a week for bare shares); a muted one-liner when the date can't be confirmed; nothing when earnings are clear.
 * No "use client": usable from the server-rendered Dashboard and Tracker and from client lists alike.
 */
export function PositionEarningsNoteView({ note, testId = "position-earnings-note" }: { note: PositionEarningsNote | null | undefined; testId?: string }) {
  if (!note) return null;
  const { warning, rollCaution } = note;
  if (warning.level === "NONE" && !rollCaution) return null;
  const urgent = warning.level === "BEFORE_EXPIRY" || warning.level === "SHARES_SOON";
  return (
    <div className="mt-1 space-y-0.5 text-[13px]" data-testid={testId} data-level={warning.level}>
      {warning.level !== "NONE" ? (
        <p className={urgent ? "font-medium text-amber-300" : "text-zinc-500"}>
          {urgent ? <span aria-hidden>⚠ </span> : null}
          {warning.message}
        </p>
      ) : null}
      {rollCaution ? <p className="text-amber-300">{rollCaution}</p> : null}
    </div>
  );
}
