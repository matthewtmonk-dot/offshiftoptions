import Link from "next/link";
import { Bell, MessageSquareText, ThumbsUp, WalletCards } from "lucide-react";
import { Badge, EmptyState, Initials, Metric, Panel, StatusBadge } from "@/components/ui";
import { getDashboardData } from "@/lib/app-data";
import { money, percent, shortDate, toNumber } from "@/lib/format";
import { requireCurrentUser } from "@/lib/auth";
import {
  annualizedReturnOnRisk,
  cashSecuredReturnOnRisk,
  daysToExpiration,
  distanceToStrikePercent,
  premiumCaptureSummary,
} from "@/domain/finance/calculations";
import { addReactionAction } from "../actions";

export const dynamic = "force-dynamic";

export default async function DashboardPage() {
  const user = await requireCurrentUser();
  const data = await getDashboardData(user.id);
  const snapshot = data.accountSnapshot;
  const firstTrade = data.openTrades[0];
  const firstLeg = firstTrade?.legs[0];
  const firstPosition = firstTrade?.positionSnapshots[0];
  const dte = firstLeg ? daysToExpiration(firstLeg.expiration) : null;
  const ror =
    firstLeg && firstPosition
      ? cashSecuredReturnOnRisk(toNumber(firstLeg.premium), toNumber(firstLeg.strike), firstLeg.contracts, toNumber(firstLeg.fees))
      : null;
  const annualized = ror && dte ? annualizedReturnOnRisk(ror, dte) : null;
  const capture =
    firstLeg && firstPosition
      ? premiumCaptureSummary(
          toNumber(firstLeg.premium),
          toNumber(firstPosition.optionAsk),
          firstLeg.contracts,
          toNumber(firstLeg.fees),
        )
      : null;

  return (
    <div className="space-y-6">
      <div className="flex flex-col gap-2 md:flex-row md:items-end md:justify-between">
        <div>
          <p className="text-sm font-medium text-emerald-300">Phase 1 demo/manual data</p>
          <h1 className="text-3xl font-semibold text-zinc-50">Hey {user.name}, rules first.</h1>
        </div>
        <Badge tone="info">No trading or order submission</Badge>
      </div>

      <section className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
        <Metric label="Account value" value={snapshot ? money(snapshot.accountValue) : "No data"} subtext="Demo/manual" />
        <Metric label="Cash" value={snapshot ? money(snapshot.cash) : "No data"} subtext="Manual account snapshot" />
        <Metric label="Securing puts" value={snapshot ? money(snapshot.cashSecuringPuts) : "No data"} subtext="CSP collateral" />
        <Metric label="Available cash" value={snapshot ? money(snapshot.availableCash) : "No data"} subtext="Private demo/manual" />
        <Metric label="Realized P/L" value={snapshot ? money(snapshot.realizedPL) : "No data"} subtext="Private demo/manual dollars" />
        <Metric label="Unrealized P/L" value={snapshot ? money(snapshot.unrealizedPL) : "No data"} subtext="Private demo/manual dollars" />
        <Metric label="Premium collected" value={snapshot ? money(snapshot.premiumCollected) : "No data"} subtext="Demo realized premium" />
        <Metric label="Open CSP count" value={data.openTrades.length} subtext="Current user only" />
      </section>

      <div className="grid gap-4 xl:grid-cols-[1.15fr_0.85fr]">
        <Panel
          title="My Open Puts"
          action={
            <Link className="text-sm font-medium text-emerald-300 hover:text-emerald-200" href="/positions">
              View all
            </Link>
          }
        >
          {firstTrade && firstLeg && firstPosition ? (
            <div className="grid gap-4 lg:grid-cols-[0.9fr_1.1fr]">
              <div className="rounded-lg border border-zinc-800 bg-zinc-900 p-4">
                <div className="mb-3 flex items-center justify-between">
                  <div>
                    <div className="text-3xl font-semibold text-zinc-50">{firstTrade.symbol}</div>
                    <div className="text-sm text-zinc-400">
                      {firstLeg.contracts} CSP at {money(firstLeg.strike)} strike
                    </div>
                  </div>
                  <Badge tone="good">{firstTrade.status}</Badge>
                </div>
                <div className="grid grid-cols-2 gap-3 text-sm">
                  <div>
                    <div className="text-zinc-500">Expiration</div>
                    <div className="font-medium">{shortDate(firstLeg.expiration)}</div>
                  </div>
                  <div>
                    <div className="text-zinc-500">DTE</div>
                    <div className="font-medium">{dte}</div>
                  </div>
                  <div>
                    <div className="text-zinc-500">Stock price</div>
                    <div className="font-medium">{money(firstPosition.stockPrice)}</div>
                  </div>
                  <div>
                    <div className="text-zinc-500">Distance</div>
                    <div className="font-medium">{percent(distanceToStrikePercent(toNumber(firstPosition.stockPrice), toNumber(firstLeg.strike)) ?? 0)}</div>
                  </div>
                </div>
              </div>
              <div className="grid gap-3 sm:grid-cols-3">
                <Metric label="Captured" value={capture?.capturedPercent === null || !capture ? "N/A" : percent(capture.capturedPercent)} subtext={capture ? `${money(capture.originalPremium)} received` : "No data"} />
                <Metric label="ROR" value={ror === null ? "N/A" : percent(ror)} subtext={annualized === null ? "DTE unavailable" : `${percent(annualized)} annualized`} />
                <Metric label="BTC estimate" value={capture ? money(capture.estimatedBuyToClose) : "N/A"} subtext="Uses current ask" />
              </div>
            </div>
          ) : (
            <EmptyState>No open manual CSP positions are seeded for this user.</EmptyState>
          )}
        </Panel>

        <Panel
          title="Recommendations"
          action={
            <Link className="text-sm font-medium text-emerald-300 hover:text-emerald-200" href="/recommendations">
              Open
            </Link>
          }
        >
          <div className="space-y-3">
            {data.incomingRecommendations.map((recommendation) => (
              <div key={recommendation.id} className="rounded-lg border border-zinc-800 bg-zinc-900 p-3">
                <div className="flex items-start justify-between gap-3">
                  <div>
                    <div className="font-semibold text-zinc-50">{recommendation.sender.name} recommended {recommendation.ticker}</div>
                    <div className="mt-1 text-sm text-zinc-400">&quot;{recommendation.message}&quot;</div>
                  </div>
                  <Badge tone={recommendation.status === "NEW" ? "info" : "good"}>{recommendation.status}</Badge>
                </div>
                <div className="mt-3 flex flex-wrap gap-2">
                  {recommendation.reasonTags.map((tag) => (
                    <Badge key={tag}>{tag}</Badge>
                  ))}
                </div>
              </div>
            ))}
            {data.incomingRecommendations.length === 0 ? <EmptyState>No recommendations yet.</EmptyState> : null}
          </div>
        </Panel>
      </div>

      <div className="grid gap-4 xl:grid-cols-3">
        <Panel
          title="LST Scanner"
          action={
            <div className="flex items-center gap-2">
              <Badge tone="warn">DEMO</Badge>
              <Link className="text-sm font-medium text-emerald-300 hover:text-emerald-200" href="/scanner">
                Results
              </Link>
            </div>
          }
        >
          <div className="space-y-3">
            {data.latestScanRun?.results.slice(0, 4).map((result) => (
              <div key={result.id} className="flex items-center justify-between rounded-lg border border-zinc-800 bg-zinc-900 p-3">
                <div>
                  <div className="font-semibold">{result.ticker}</div>
                  <div className="text-sm text-zinc-400">
                    {result.passedCriteria} / {result.totalCriteria} criteria passed
                  </div>
                </div>
                <StatusBadge status={result.summaryStatus} />
              </div>
            ))}
          </div>
        </Panel>

        <Panel
          title="Buddy Chat"
          action={
            <Link className="text-sm font-medium text-emerald-300 hover:text-emerald-200" href="/chat">
              Chat
            </Link>
          }
        >
          <div className="space-y-3">
            {data.recentMessages.map((message) => (
              <div key={message.id} className="flex gap-3">
                <Initials name={message.sender.name} />
                <div>
                  <div className="text-sm font-medium text-zinc-200">
                    {message.sender.name} {message.ticker ? <span className="text-emerald-300">${message.ticker}</span> : null}
                  </div>
                  <div className="text-sm text-zinc-400">{message.body}</div>
                </div>
              </div>
            ))}
            {data.recentMessages.length === 0 ? <EmptyState>No chat messages yet.</EmptyState> : null}
          </div>
        </Panel>

        <Panel
          title="Buddy Activity"
          action={
            <Link className="text-sm font-medium text-emerald-300 hover:text-emerald-200" href="/notifications">
              Alerts
            </Link>
          }
        >
          <div className="space-y-3">
            {data.activities.map((activity) => (
              <div key={activity.id} className="rounded-lg border border-zinc-800 bg-zinc-900 p-3">
                <div className="flex items-start gap-3">
                  <Initials name={activity.actor.name} />
                  <div className="min-w-0 flex-1">
                    <div className="text-sm font-medium text-zinc-100">{activity.title}</div>
                    {activity.body ? <div className="mt-1 text-sm text-zinc-400">{activity.body}</div> : null}
                    <form action={addReactionAction} className="mt-2">
                      <input type="hidden" name="targetType" value="ACTIVITY" />
                      <input type="hidden" name="targetId" value={activity.id} />
                      <button
                        type="submit"
                        className="inline-flex min-h-9 items-center gap-2 rounded-md border border-zinc-700 px-3 text-xs text-zinc-300 transition hover:border-emerald-400/60 hover:text-emerald-200"
                      >
                        <ThumbsUp className="size-3.5" aria-hidden />
                        Atta Boy
                      </button>
                    </form>
                  </div>
                </div>
              </div>
            ))}
            {data.activities.length === 0 ? <EmptyState>No shared activity yet.</EmptyState> : null}
          </div>
        </Panel>
      </div>

      <section className="grid gap-3 sm:grid-cols-3">
        <Link href="/positions" className="flex min-h-20 items-center gap-3 rounded-lg border border-zinc-800 bg-zinc-900 p-4 transition hover:border-emerald-400/50">
          <WalletCards className="size-5 text-emerald-300" aria-hidden />
          <span className="font-medium">Position clarity</span>
        </Link>
        <Link href="/chat" className="flex min-h-20 items-center gap-3 rounded-lg border border-zinc-800 bg-zinc-900 p-4 transition hover:border-emerald-400/50">
          <MessageSquareText className="size-5 text-emerald-300" aria-hidden />
          <span className="font-medium">Buddy check-ins</span>
        </Link>
        <Link href="/notifications" className="flex min-h-20 items-center gap-3 rounded-lg border border-zinc-800 bg-zinc-900 p-4 transition hover:border-emerald-400/50">
          <Bell className="size-5 text-emerald-300" aria-hidden />
          <span className="font-medium">In-app notifications</span>
        </Link>
      </section>
    </div>
  );
}
