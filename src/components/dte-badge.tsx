import { dteUrgency, type DteUrgency } from "@/domain/finance/strikeGauge";

const TONE: Record<DteUrgency, string> = {
  urgent: "border-amber-400/60 bg-amber-400/20 text-amber-200",
  soon: "border-sky-400/50 bg-sky-400/15 text-sky-200",
  normal: "border-zinc-600 bg-zinc-800 text-zinc-200",
  unknown: "border-zinc-700 bg-zinc-900 text-zinc-400",
};

/**
 * Days to expiration as a bold, color-coded badge: amber when it expires today or tomorrow, blue for
 * the next few days, gray beyond that. Color is never the only signal - the number and "DTE" are always
 * there. `short` renders "11d" for tight rows; the default renders "11 DTE" like the Tracker always has.
 */
export function DteBadge({ dte, short = false }: { dte: number | null; short?: boolean }) {
  const urgency = dteUrgency(dte);
  const label = dte === null || !Number.isFinite(dte) ? "- DTE" : short ? (dte === 0 ? "today" : `${Math.trunc(dte)}d`) : `${Math.trunc(dte)} DTE`;
  return (
    <span
      data-testid="dte-badge"
      data-urgency={urgency}
      title={urgency === "urgent" ? "Expires today or tomorrow" : "Calendar days until this option expires"}
      className={`inline-flex items-center rounded border px-1.5 py-0.5 align-baseline text-xs font-bold tabular-nums ${TONE[urgency]}`}
    >
      {label}
    </span>
  );
}
