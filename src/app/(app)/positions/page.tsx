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
  estimatedBuyToCloseCost,
  premiumCapturedPercent,
  remainingPremium,
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
          const dte = daysToExpiration(leg.expiration, new Date("2026-08-28T12:00:00Z"));
          const ror = cashSecuredReturnOnRisk(premium, strike, leg.contracts, toNumber(leg.fees));
          const captured = premiumCapturedPercent(premium, mark);
          const btc = estimatedBuyToCloseCost(leg.contracts, ask, toNumber(leg.fees));

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
                    <Metric label="Break-even" value={money(cspBreakEven(strike, premium))} />
                    <Metric label="Distance $" value={money(distanceToStrikeDollars(stockPrice, strike))} />
                    <Metric label="Distance %" value={percent(distanceToStrikePercent(stockPrice, strike) ?? 0)} />
                  </div>
                </div>

                <div className="space-y-3">
                  <div className="grid gap-3 sm:grid-cols-3">
                    <Metric label="Premium received" value={money(premium)} />
                    <Metric label="BTC estimate" value={money(btc)} subtext="Uses current ask plus fees" />
                    <Metric label="Captured" value={captured === null ? "N/A" : percent(captured)} />
                  </div>
                  <div className="grid gap-3 sm:grid-cols-3">
                    <Metric label="Remaining premium" value={money(remainingPremium(premium, mark), 2)} />
                    <Metric label="Return on risk" value={ror === null ? "N/A" : percent(ror)} />
                    <Metric label="Bid/ask spread" value={money(bidAskSpreadDollars(bid, ask), 2)} subtext={percent(bidAskSpreadPercent(bid, ask) ?? 0)} />
                  </div>
                  <div className="rounded-lg border border-zinc-800 bg-zinc-900 p-4">
                    <h2 className="mb-3 text-sm font-semibold uppercase tracking-normal text-zinc-300">Option Details</h2>
                    <dl className="grid gap-3 text-sm sm:grid-cols-2 lg:grid-cols-4">
                      <div>
                        <dt className="text-zinc-500">
                          <Definition term="Delta">How sensitive the option is to changes in the underlying stock.</Definition>
                        </dt>
                        <dd className="font-medium">{toNumber(snapshot.delta).toFixed(2)}</dd>
                      </div>
                      <div>
                        <dt className="text-zinc-500">
                          <Definition term="Gamma">How quickly delta changes.</Definition>
                        </dt>
                        <dd className="font-medium">{toNumber(snapshot.gamma).toFixed(3)}</dd>
                      </div>
                      <div>
                        <dt className="text-zinc-500">
                          <Definition term="Theta">Time decay.</Definition>
                        </dt>
                        <dd className="font-medium">{toNumber(snapshot.theta).toFixed(3)}</dd>
                      </div>
                      <div>
                        <dt className="text-zinc-500">
                          <Definition term="Vega">Sensitivity to implied volatility.</Definition>
                        </dt>
                        <dd className="font-medium">{toNumber(snapshot.vega).toFixed(3)}</dd>
                      </div>
                      <div>
                        <dt className="text-zinc-500">IV</dt>
                        <dd className="font-medium">{percent(toNumber(snapshot.impliedVolatility) * 100)}</dd>
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
                        <dt className="text-zinc-500">Mark</dt>
                        <dd className="font-medium">{money(mark, 2)}</dd>
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
