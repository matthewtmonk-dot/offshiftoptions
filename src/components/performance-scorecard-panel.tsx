import { Gauge, Landmark, Trophy } from "lucide-react";
import { InfoTip } from "@/components/info-tip";
import { Badge } from "@/components/ui";
import type { PerformanceScorecard, ScorecardCell } from "@/lib/performance-scorecard";

const TONE_TEXT = {
  good: "text-emerald-300",
  warn: "text-amber-300",
  bad: "text-red-300",
  neutral: "text-zinc-400",
} as const;

function Cell({ cell }: { cell: ScorecardCell }) {
  return (
    <div>
      <div className={`text-2xl font-bold tabular-nums ${TONE_TEXT[cell.tone]}`}>{cell.value}</div>
      <div className="mt-0.5 text-xs text-zinc-400">{cell.detail}</div>
    </div>
  );
}

function RowLabel({ title, subtitle, help }: { title: string; subtitle: string; help: string }) {
  return (
    <div>
      <div className="flex items-center gap-1 text-sm font-semibold text-zinc-100">
        {title}
        <InfoTip label={title} align="start">{help}</InfoTip>
      </div>
      <div className="text-xs text-zinc-500">{subtitle}</div>
    </div>
  );
}

/**
 * Tracker > Performance "Account scorecard": the money in the account, how much of it is actually working,
 * and the average weekly return measured on that working money AND on the whole account (so idle cash
 * shows up as a lower number). Pure presentation of lib/performance-scorecard.ts.
 */
export function PerformanceScorecardPanel({ scorecard }: { scorecard: PerformanceScorecard }) {
  return (
    <section className="rounded-lg border border-zinc-800 bg-zinc-950 p-4 shadow-sm shadow-black/20" data-testid="account-scorecard">
      <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
        <div>
          <p className="text-xs font-semibold uppercase tracking-wide text-sky-300">Account Scorecard</p>
          <h2 className="mt-1 text-xl font-semibold text-zinc-50">How the account is doing</h2>
        </div>
        <Badge tone="info">Mine only</Badge>
      </div>

      <dl className="grid gap-3 sm:grid-cols-3">
        <div className="rounded-lg border border-zinc-800 bg-zinc-900/70 p-3">
          <dt className="flex items-center gap-2 text-[11px] font-semibold uppercase tracking-normal text-zinc-500">
            <Landmark className="size-4 text-zinc-400" aria-hidden />
            Account value
          </dt>
          <dd className="mt-2 text-xl font-semibold text-zinc-50">{scorecard.accountValue.value}</dd>
          <div className="mt-1 text-xs text-zinc-500">{scorecard.accountValue.detail}</div>
        </div>
        <div className="rounded-lg border border-zinc-800 bg-zinc-900/70 p-3">
          <dt className="flex items-center gap-2 text-[11px] font-semibold uppercase tracking-normal text-zinc-500">
            <Gauge className="size-4 text-zinc-400" aria-hidden />
            Money put to work
            <InfoTip label="Money put to work" align="start">
              Cash set aside to secure your open puts, plus the cost of any shares you were assigned. The rest of the account is cash plus any holdings outside these tracked campaigns - the app only counts what it tracks as campaigns, so this is not necessarily idle cash.
            </InfoTip>
          </dt>
          <dd className="mt-2 text-xl font-semibold text-zinc-50">{scorecard.moneyInUse.value}</dd>
          <div className="mt-1 text-xs text-zinc-500">{scorecard.moneyInUse.detail}</div>
        </div>
        <div className="rounded-lg border border-zinc-800 bg-zinc-900/70 p-3">
          <dt className="flex items-center gap-2 text-[11px] font-semibold uppercase tracking-normal text-zinc-500">
            <Trophy className="size-4 text-zinc-400" aria-hidden />
            Win - loss record
            <InfoTip label="Win - loss record" align="start">
              Positions that closed with a confirmed result. A win is a net gain after fees, a loss a net loss. Positions still open, or waiting on a fee, are not counted yet.
            </InfoTip>
          </dt>
          <dd className="mt-2 text-sm text-zinc-300">
            <span className="text-zinc-500">This week:</span> <span className="font-semibold text-zinc-50">{scorecard.record.thisWeek}</span>
          </dd>
          <dd className="mt-0.5 text-sm text-zinc-300">
            <span className="text-zinc-500">All time:</span> <span className="font-semibold text-zinc-50">{scorecard.record.allTime}</span>
          </dd>
        </div>
      </dl>

      <div className="mt-4 overflow-hidden rounded-lg border border-zinc-800">
        <div className="hidden grid-cols-[minmax(0,0.8fr)_minmax(0,1fr)_minmax(0,1fr)] gap-4 border-b border-zinc-800 bg-zinc-900/70 px-3 py-2 text-xs font-semibold uppercase tracking-wide text-zinc-500 md:grid">
          <span>Average return per week</span>
          <span>This week so far</span>
          <span>All time</span>
        </div>
        {(
          [
            { title: "On the money put to work", subtitle: "Is the working money earning its keep?", data: scorecard.onMoneyInUse },
            { title: "On the whole account", subtitle: "Everything else in the account counts against it", data: scorecard.onWholeAccount },
          ] as const
        ).map((row) => (
          <div key={row.title} className="grid gap-3 border-b border-zinc-800 px-3 py-3 last:border-b-0 md:grid-cols-[minmax(0,0.8fr)_minmax(0,1fr)_minmax(0,1fr)] md:gap-4">
            <RowLabel title={row.title} subtitle={row.subtitle} help={row.data.help} />
            <div>
              <div className="mb-0.5 text-[11px] font-semibold uppercase tracking-wide text-zinc-500 md:hidden">This week so far</div>
              <Cell cell={row.data.thisWeek} />
            </div>
            <div>
              <div className="mb-0.5 text-[11px] font-semibold uppercase tracking-wide text-zinc-500 md:hidden">All time</div>
              <Cell cell={row.data.allTime} />
            </div>
          </div>
        ))}
      </div>
    </section>
  );
}
