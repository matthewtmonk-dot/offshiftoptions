import { InfoTip } from "@/components/info-tip";
import type { WeeklyPaceDisplay } from "@/lib/weekly-pace-display";

const TONE_TEXT = {
  good: "text-emerald-300",
  warn: "text-amber-300",
  bad: "text-red-300",
} as const;

/**
 * "Average per week" with a hover definition. Used by the Dashboard's whole-account card and the Tracker's
 * campaign summary so both read the same way. `compact` is the one-line form for tight spaces.
 */
export function WeeklyPaceRow({
  pace,
  label = "Average per week",
  compact = false,
}: {
  pace: WeeklyPaceDisplay;
  label?: string;
  compact?: boolean;
}) {
  if (compact) {
    return (
      <span className="inline-flex items-center gap-0.5 text-xs text-zinc-500" data-testid="weekly-pace">
        {label}: <span className={`font-semibold ${TONE_TEXT[pace.tone]}`}>{pace.value}</span>
        <InfoTip label={label} align="start">{pace.help}</InfoTip>
      </span>
    );
  }
  return (
    <div data-testid="weekly-pace">
      <div className="flex items-center gap-1 text-xs font-medium uppercase tracking-wide text-zinc-500">
        {label}
        <InfoTip label={label} align="start">{pace.help}</InfoTip>
      </div>
      <div className={`text-xl font-bold tabular-nums ${TONE_TEXT[pace.tone]}`}>{pace.value}</div>
      <div className="text-xs text-zinc-400">{pace.detail}</div>
    </div>
  );
}
