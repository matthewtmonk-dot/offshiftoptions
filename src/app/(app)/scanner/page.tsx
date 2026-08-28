import { Send } from "lucide-react";
import { EmptyState, FieldLabel, Panel, StatusBadge } from "@/components/ui";
import { requireCurrentUser } from "@/lib/auth";
import { getScannerPageData } from "@/lib/app-data";
import { prisma } from "@/lib/prisma";
import { recommendStockAction } from "../actions";

export const dynamic = "force-dynamic";

export default async function ScannerPage() {
  const user = await requireCurrentUser();
  const [profile, buddies] = await Promise.all([
    getScannerPageData(user.id),
    prisma.user.findMany({ where: { id: { not: user.id } }, orderBy: { name: "asc" } }),
  ]);
  const run = profile?.scanRuns[0];

  return (
    <div className="space-y-6">
      <div>
        <p className="text-sm font-medium text-emerald-300">Demo scanner profile</p>
        <h1 className="text-3xl font-semibold text-zinc-50">My LST Scanner</h1>
      </div>

      <Panel title="Rules">
        <div className="grid gap-2 md:grid-cols-2 xl:grid-cols-3">
          {profile?.rules.map((rule) => (
            <div key={rule.id} className="rounded-lg border border-zinc-800 bg-zinc-900 p-3">
              <div className="font-medium text-zinc-100">{rule.name}</div>
              <div className="mt-1 text-sm text-zinc-400">
                {rule.operator} {JSON.stringify(rule.valueJson)}
              </div>
            </div>
          ))}
          {!profile?.rules.length ? <EmptyState>No scanner rules are seeded yet.</EmptyState> : null}
        </div>
      </Panel>

      <Panel title={run ? `Run ${run.source}` : "Latest Run"}>
        <div className="grid gap-4 xl:grid-cols-2">
          {run?.results.map((result) => (
            <article key={result.id} className="rounded-lg border border-zinc-800 bg-zinc-900 p-4">
              <div className="mb-4 flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
                <div>
                  <div className="flex items-center gap-2">
                    <h2 className="text-2xl font-semibold text-zinc-50">{result.ticker}</h2>
                    <StatusBadge status={result.summaryStatus} />
                  </div>
                  <p className="mt-1 text-sm text-zinc-400">
                    {result.passedCriteria} / {result.totalCriteria} criteria passed
                  </p>
                </div>
                <form action={recommendStockAction} className="flex flex-col gap-2 sm:w-64">
                  <input type="hidden" name="ticker" value={result.ticker} />
                  <input type="hidden" name="reasonTags" value="Scanner looks good,Worth researching" />
                  <select
                    name="recipientId"
                    className="min-h-10 rounded-md border border-zinc-700 bg-zinc-950 px-2 text-sm text-zinc-100"
                    required
                    aria-label={`Recommend ${result.ticker} to buddy`}
                  >
                    {buddies.map((buddy) => (
                      <option key={buddy.id} value={buddy.id}>
                        {buddy.name}
                      </option>
                    ))}
                  </select>
                  <input
                    name="message"
                    className="min-h-10 rounded-md border border-zinc-700 bg-zinc-950 px-2 text-sm text-zinc-100"
                    defaultValue={`Take a look at ${result.ticker}.`}
                    aria-label={`Recommendation message for ${result.ticker}`}
                  />
                  <button
                    type="submit"
                    className="inline-flex min-h-10 items-center justify-center gap-2 rounded-md bg-emerald-400 px-3 text-sm font-semibold text-zinc-950 hover:bg-emerald-300"
                  >
                    <Send className="size-4" aria-hidden />
                    Recommend
                  </button>
                </form>
              </div>

              <div className="space-y-2">
                {result.criterionResults.map((criterion) => (
                  <div key={criterion.id} className="grid gap-2 rounded-md border border-zinc-800 bg-zinc-950 p-3 text-sm md:grid-cols-[140px_92px_1fr]">
                    <div className="font-medium text-zinc-100">{criterion.criterionName}</div>
                    <StatusBadge status={criterion.status} />
                    <div className="text-zinc-400">{criterion.explanation}</div>
                  </div>
                ))}
              </div>
            </article>
          ))}
          {!run?.results.length ? <EmptyState>No scan results are seeded yet.</EmptyState> : null}
        </div>
      </Panel>

      <Panel title="Scanner Notes">
        <div className="grid gap-3 md:grid-cols-3">
          <div>
            <FieldLabel>Values</FieldLabel>
            <p className="mt-1 text-sm text-zinc-400">Phase 1 values are demo/manual, not live option-chain data.</p>
          </div>
          <div>
            <FieldLabel>Outcome</FieldLabel>
            <p className="mt-1 text-sm text-zinc-400">The summary is derived from individual criterion results.</p>
          </div>
          <div>
            <FieldLabel>Unknown</FieldLabel>
            <p className="mt-1 text-sm text-zinc-400">Missing data remains UNKNOWN instead of being forced into a pass/fail bucket.</p>
          </div>
        </div>
      </Panel>
    </div>
  );
}
