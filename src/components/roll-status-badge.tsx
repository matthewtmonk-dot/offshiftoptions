import { Badge } from "@/components/ui";
import type { RollStatus } from "@/domain/finance/rollStatus";

const TONE_BY_COLOR = {
  GREEN: "good",
  AMBER: "warn",
  RED: "bad",
} as const;

const EMOJI_BY_COLOR = {
  GREEN: "🟢",
  AMBER: "🟡",
  RED: "🔴",
} as const;

/** Compact Roll Status display for an open cash-secured put - color, label, and percentage
 * distance from strike are all shown together so color is never the only signal. */
export function RollStatusBadge({ status }: { status: RollStatus }) {
  return (
    <div className="flex flex-col items-end gap-0.5">
      <Badge tone={TONE_BY_COLOR[status.color]}>
        <span aria-hidden>{EMOJI_BY_COLOR[status.color]}</span>
        <span className="ml-1">{status.label}</span>
      </Badge>
      <p className="text-xs text-zinc-400">
        {status.distanceText}
        {status.bufferNote ? ` · ${status.bufferNote}` : ""}
      </p>
    </div>
  );
}

export function RollStatusUnavailableBadge() {
  return (
    <div className="flex flex-col items-end gap-0.5">
      <Badge tone="neutral">Roll status unavailable</Badge>
      <p className="text-xs text-zinc-500">No live price</p>
    </div>
  );
}
