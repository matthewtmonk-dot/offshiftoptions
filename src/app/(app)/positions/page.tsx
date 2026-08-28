import { ThumbsUp } from "lucide-react";
import { Badge, Definition, EmptyState, Metric, Panel } from "@/components/ui";
import { requireCurrentUser } from "@/lib/auth";
import { getPositionsPageData } from "@/lib/app-data";
import { money, percent, shortDate, toNumber } from "@/lib/format";
import {
  bidAskSpreadDollars,
  bidAskSpreadPercent,
  cashSecuredReturnOnRisk,
  cspBreakEven,
  daysToExpiration,
  distanceToStrikeDollars,
  distanceToStrikePercent,
  positionHealthSummary,
  premiumCaptureSummary,
  securedCapital,
} from "@/domain/finance/calculations";
import { addReactionAction } from "../actions";

export const dynamic = "force-dynamic";

export default async function PositionsPage() {
  const user = await requireCurrentUser();
  const trades = await getPositionsPageData(user.id);

  return (
    <div className="space-y-6">
      <div>
        <p className="text-sm font-medium text-emerald-300">Manual/demo CSP tracking</p>
        <h1 className="text-3xl font-semibold text-zinc-50">My Open Positions</h1>
      </div>

      <div className="space-y-4">
        {trades.map((trade) => {
          const leg = trade.legs[0];
          const snapshot = trade.positionSnapshots[0];
          if (!leg || !snapshot) {
            return null;
          }

          const stockPrice = toNumber(snapshot.stockPrice);
          const strike = toNumber(leg.strike);
          const premium = toNumber(leg.premium);
          const bid = toNumber(snapshot.optionBid);
          const ask = toNumber(snapshot.optionAsk);
          const mark = toNumber(snapshot.optionMark);
          const fees = toNumber(leg.fees);
          const dte = daysToExpiration(leg.expiration);
          const distanceDollars = distanceToStrikeDollars(stockPrice, strike);
          const distancePercent = distanceToStrikePercent(stockPrice, strike);
          const ror = cashSecuredReturnOnRisk(premium, strike, leg.contracts, fees);
          const capture = premiumCaptureSummary(premium, ask, leg.contracts, fees);
          const health = positionHealthSummary({
            status: trade.status,
            dte,
            distanceDollars,
            distancePercent,
            absoluteDelta: snapshot.delta === null ? null : Math.abs(toNumber(snapshot.delta)),
          });

          return (
            <Panel
              key={trade.id}
              title={`${trade.symbol} cash-secured put`}
              action={<Badge tone={trade.status === "OPEN" ? "good" : "neutral"}>{trade.status}</Badge>}
            >
              <div className="grid gap-4 xl:grid-cols-[0.9fr_1.1fr]">
                <div className="rounded-lg border border-zinc-800 bg-zinc-900 p-4">
                  <div className="mb-5 flex items-start justify-between gap-4">
                    <div>
                      <div className="text-4xl font-semibold text-zinc-50">{trade.symbol}</div>
                      <div className="mt-1 text-sm text-zinc-400">
                        {leg.contracts} contract at {money(strike)} strike, expires {shortDate(leg.expiration)}
                      </div>
                    </div>
                    <Badge tone={trade.visibility === "PRIVATE" ? "warn" : "info"}>{trade.visibility}</Badge>
                  </div>

                  <div className="grid gap-3 sm:grid-cols-2">
                    <Metric label="Current stock" value={money(stockPrice)} />
                    <Metric label="Strike" value={money(strike)} />
                    <Metric label="DTE" value={dte} subtext="Days to expiration" />
                    <Metric label="Break-even" value={money(cspBreakEven(strike, premium))} subtext="Strike minus per-share premium" />
                    <Metric label="Distance $" value={money(distanceDollars)} />
                    <Metric label="Distance %" value={distancePercent === null ? "N/A" : percent(distancePercent)} />
                  </div>
                </div>

                <div className="space-y-3">
                  <div className="rounded-lg border border-zinc-800 bg-zinc-900 p-4">
                    <div className="mb-2 flex flex-wrap items-center gap-2">
                      <h2 className="text-sm font-semibold uppercase tracking-normal text-zinc-300">Position Health</h2>
                      <Badge tone={healthTone(health.status)}>{health.status.replaceAll("_", " ")}</Badge>
                    </div>
                    <ul className="space-y-1 text-sm text-zinc-400">
                      {health.reasons.map((reason) => (
                        <li key={reason}>{reason}</li>
                      ))}
                    </ul>
                  </div>

                  <div className="grid gap-3 sm:grid-cols-3">
                    <Metric label="Received" value={money(capture.originalPremium)} subtext={`${money(premium, 2)} per share`} />
                    <Metric label="Estimated BTC" value={money(capture.estimatedBuyToClose)} subtext="Uses current ask plus fees" />
                    <Metric label="Captured $" value={money(capture.grossPremiumProfit)} />
                  </div>
                  <div className="grid gap-3 sm:grid-cols-3">
                    <Metric label="Captured %" value={capture.capturedPercent === null ? "N/A" : percent(capture.capturedPercent)} />
                    <Metric label="Remaining" value={money(capture.remainingPremium)} />
                    <Metric label="Secured capital" value={money(securedCapital(strike, leg.contracts))} />
                  </div>
                  <div className="grid gap-3 sm:grid-cols-3">
                    <Metric label="Current bid" value={money(bid, 2)} />
                    <Metric label="Current ask" value={money(ask, 2)} />
                    <Metric label="Current mark" value={money(mark, 2)} />
                  </div>
                  <div className="grid gap-3 sm:grid-cols-3">
                    <Metric label="Return on risk" value={ror === null ? "N/A" : percent(ror)} />
                    <Metric label="Bid/ask spread" value={money(bidAskSpreadDollars(bid, ask), 2)} subtext={percent(bidAskSpreadPercent(bid, ask) ?? 0)} />
                    <Metric label="Remaining/contract" value={money(ask * 100, 2)} />
                  </div>

                  <div className="rounded-lg border border-zinc-800 bg-zinc-900 p-4">
                    <h2 className="mb-3 text-sm font-semibold uppercase tracking-normal text-zinc-300">Option Details</h2>
                    <dl className="grid gap-3 text-sm sm:grid-cols-2 lg:grid-cols-4">
                      <div>
                        <dt className="text-zinc-500">
                          <Definition term="Delta">How sensitive the option is to changes in the underlying stock.</Definition>
                        </dt>
                        <dd className="font-medium">{snapshot.delta === null ? "N/A" : toNumber(snapshot.delta).toFixed(2)}</dd>
                      </div>
                      <div>
                        <dt className="text-zinc-500">
                          <Definition term="Gamma">How quickly delta changes.</Definition>
                        </dt>
                        <dd className="font-medium">{snapshot.gamma === null ? "N/A" : toNumber(snapshot.gamma).toFixed(3)}</dd>
                      </div>
                      <div>
                        <dt className="text-zinc-500">
                          <Definition term="Theta">Time decay.</Definition>
                        </dt>
                        <dd className="font-medium">{snapshot.theta === null ? "N/A" : toNumber(snapshot.theta).toFixed(3)}</dd>
                      </div>
                      <div>
                        <dt className="text-zinc-500">
                          <Definition term="Vega">Sensitivity to implied volatility.</Definition>
                        </dt>
                        <dd className="font-medium">{snapshot.vega === null ? "N/A" : toNumber(snapshot.vega).toFixed(3)}</dd>
                      </div>
                      <div>
                        <dt className="text-zinc-500">IV</dt>
                        <dd className="font-medium">{snapshot.impliedVolatility === null ? "N/A" : percent(toNumber(snapshot.impliedVolatility) * 100)}</dd>
                      </div>
                      <div>
                        <dt className="text-zinc-500">Open interest</dt>
                        <dd className="font-medium">{snapshot.openInterest ?? "N/A"}</dd>
                      </div>
                      <div>
                        <dt className="text-zinc-500">Volume</dt>
                        <dd className="font-medium">{snapshot.optionVolume ?? "N/A"}</dd>
                      </div>
                      <div>
                        <dt className="text-zinc-500">Bid/ask spread %</dt>
                        <dd className="font-medium">{percent(bidAskSpreadPercent(bid, ask) ?? 0)}</dd>
                      </div>
                    </dl>
                  </div>
                  <form action={addReactionAction}>
                    <input type="hidden" name="targetType" value="TRADE" />
                    <input type="hidden" name="targetId" value={trade.id} />
                    <button
                      type="submit"
                      className="inline-flex min-h-10 items-center gap-2 rounded-md border border-zinc-700 px-3 text-sm text-zinc-300 transition hover:border-emerald-400/60 hover:text-emerald-200"
                    >
                      <ThumbsUp className="size-4" aria-hidden />
                      Atta Boy
                    </button>
                  </form>
                </div>
              </div>
            </Panel>
          );
        })}
        {trades.length === 0 ? <EmptyState>No manual/demo trades are seeded for this user.</EmptyState> : null}
      </div>
    </div>
  );
}

function healthTone(status: string) {
  if (status === "COMFORTABLE") {
    return "good";
  }
  if (status === "IN_THE_MONEY" || status === "NEAR_STRIKE") {
    return "bad";
  }
  if (status === "WATCH" || status === "EXPIRED") {
    return "warn";
  }
  return "neutral";
}
