"use client";

import type { PositionAssessmentDisplay } from "@/domain/finance/positionReviewAssessment";
import { buildStrikeGaugeGeometry } from "@/domain/finance/strikeGauge";
import { useActiveGuidanceExpired } from "@/components/use-active-guidance-expired";
import { money } from "@/lib/format";

type GaugeSource = { optionType: "PUT" | "CALL"; strike: number; price: number; bufferPercent: number | null; live: boolean };

/**
 * Dashboard visual pass - a small "where is the stock relative to my strike" track, in the spirit of
 * a TradingView range bar. PRESENTATION ONLY: every number comes from the assessment the row already
 * resolved (strike, observed underlying price, applied roll buffer) and the zones are the evaluator's
 * own ITM / within-buffer / comfortable bands (see strikeGauge.ts) - nothing here decides an action.
 *
 * Trust rules mirrored from LivePositionAssessmentBadge, using the SAME expiry hook so the gauge and
 * the badge downgrade together: it only looks "live" while a CURRENT assessment's own server-authorized
 * guidance window is still open. Once that expires (or while the hook is still calibrating - it always
 * starts neutral), or for a LAST_VALID fallback, the gauge is drawn muted with a "Last valid"/"Snapshot"
 * tag, never as if it were a live price. No evidence (e.g. CANNOT_ASSESS with no eligible quote) draws
 * nothing at all - missing evidence stays missing.
 */
function resolveGaugeSource(display: PositionAssessmentDisplay, expired: boolean): GaugeSource | null {
  if (display.state === "CURRENT") {
    const { explanation } = display.current;
    if (!expired && explanation.optionType && explanation.strike !== null && explanation.stockPrice !== null) {
      return { optionType: explanation.optionType, strike: explanation.strike, price: explanation.stockPrice, bufferPercent: explanation.bufferPercent, live: true };
    }
    if (display.lastValid) return fromStored(display.lastValid);
    if (explanation.optionType && explanation.strike !== null && explanation.stockPrice !== null) {
      return { optionType: explanation.optionType, strike: explanation.strike, price: explanation.stockPrice, bufferPercent: explanation.bufferPercent, live: false };
    }
    return null;
  }
  if (display.state === "LAST_VALID") return fromStored(display.lastValid);
  return null;
}

function fromStored(stored: { optionType: "PUT" | "CALL"; strike: number; underlyingPrice: number; appliedRollBufferPercent: number }): GaugeSource {
  return { optionType: stored.optionType, strike: stored.strike, price: stored.underlyingPrice, bufferPercent: stored.appliedRollBufferPercent, live: false };
}

export function PositionStrikeGauge({ display }: { display: PositionAssessmentDisplay; now: Date }) {
  // Unconditional hook call (rules of hooks) - null/null for a non-CURRENT display is "not expired"
  // with no calibration, exactly as in LivePositionAssessmentBadge.
  const expired = useActiveGuidanceExpired(
    display.state === "CURRENT" ? display.current.explanation.activeGuidanceDeadline : null,
    display.state === "CURRENT" ? display.current.explanation.evaluatedAt : null,
  );
  const source = resolveGaugeSource(display, expired);
  if (!source) return null;
  const geometry = buildStrikeGaugeGeometry(source);
  if (!geometry) return null;

  const tag = source.live ? "Current" : display.state === "LAST_VALID" || (display.state === "CURRENT" && display.lastValid) ? "Last valid" : "Snapshot";
  const itm = geometry.moneyness === "ITM";
  const priceTone = !source.live ? "text-zinc-300" : itm ? "text-red-300" : geometry.moneyness === "ATM" ? "text-amber-300" : "text-zinc-50";
  const label = `${tag}: stock ${money(source.price)}, ${source.optionType === "PUT" ? "put" : "call"} strike ${money(source.strike)}, ${geometry.moneyness === "ATM" ? "at the strike" : geometry.moneyness === "ITM" ? "in the money" : "out of the money"}`;
  const labelLeft = (pct: number) => `${Math.min(88, Math.max(12, pct))}%`;

  return (
    <div className={`w-full ${source.live ? "" : "opacity-70"}`} data-testid="position-strike-gauge" data-gauge-state={source.live ? "live" : "muted"}>
      <div role="img" aria-label={label} className="relative h-12">
        {/* Price label above the dot, strike label below the tick - opposite sides so they never collide. */}
        <span className={`absolute top-0 -translate-x-1/2 whitespace-nowrap text-xs font-semibold tabular-nums ${priceTone}`} style={{ left: labelLeft(geometry.pricePct) }}>
          {money(source.price)}
        </span>
        <div className="absolute inset-x-0 top-[22px] h-2 overflow-hidden rounded-full bg-zinc-800">
          <Zone zone={geometry.itm} className="bg-red-400/40" />
          {geometry.watch ? <Zone zone={geometry.watch} className="bg-amber-400/55" /> : null}
          <Zone zone={geometry.otm} className="bg-emerald-400/35" />
        </div>
        <span aria-hidden className="absolute top-[19px] h-[14px] w-0.5 -translate-x-1/2 rounded bg-zinc-200" style={{ left: `${geometry.strikePct}%` }} />
        <span
          aria-hidden
          className={`absolute top-[20px] size-3 -translate-x-1/2 rounded-full border-2 ${source.live ? "border-zinc-950 bg-zinc-50 shadow shadow-black/40" : "border-zinc-500 bg-zinc-900"}`}
          style={{ left: `${geometry.pricePct}%` }}
        />
        <span className="absolute bottom-0 -translate-x-1/2 whitespace-nowrap text-[11px] text-zinc-400 tabular-nums" style={{ left: labelLeft(geometry.strikePct) }}>
          {money(source.strike)} strike
        </span>
      </div>
      {!source.live ? <div className="text-[11px] uppercase tracking-wide text-zinc-500">{tag}</div> : null}
    </div>
  );
}

function Zone({ zone, className }: { zone: { startPct: number; endPct: number }; className: string }) {
  const width = Math.max(0, zone.endPct - zone.startPct);
  if (width <= 0) return null;
  return <span aria-hidden className={`absolute inset-y-0 ${className}`} style={{ left: `${zone.startPct}%`, width: `${width}%` }} />;
}
