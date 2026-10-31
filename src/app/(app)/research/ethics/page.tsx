import Link from "next/link";
import { EthicsBadge } from "@/components/ethics-badge";
import { Panel } from "@/components/ui";
import { ETHICS_CATEGORY_LABELS, ETHICS_RATING_LABELS } from "@/domain/ethics/ethicalCompatibility";
import { requireCurrentUser } from "@/lib/auth";
import { ethicsIsSetUp, getEthicsDetailForUser, getEthicsSummariesForUser, type EthicsSummary } from "@/lib/ethics";
import { EthicsDecisionForm, EthicsImportForm } from "./ethics-forms";

export const dynamic = "force-dynamic";

const SOURCE_LABELS: Record<string, string> = { PRIMARY_FILING: "Company filing", COMPANY: "Company", REGULATOR: "Regulator", NEWS: "News", SECONDARY: "Secondary" };
const SUPPORTS_LABELS: Record<string, string> = { SUPPORTS_CONCERN: "supports a concern", SUPPORTS_CLEARANCE: "supports clearance", CONTEXT: "context" };

function Row({ summary, selected }: { summary: EthicsSummary; selected: boolean }) {
  return (
    <li>
      <Link
        href={`/research/ethics?ticker=${encodeURIComponent(summary.ticker)}`}
        className={`flex items-start gap-3 rounded-md border px-3 py-2 hover:border-zinc-600 ${selected ? "border-sky-400/50 bg-sky-400/5" : "border-zinc-800 bg-zinc-900/40"}`}
      >
        <EthicsBadge ticker={summary.ticker} summary={summary} />
        <span className="min-w-0 flex-1">
          <span className="block text-sm font-semibold text-zinc-50">
            {summary.ticker} <span className="font-normal text-zinc-400">{summary.companyName}</span>
          </span>
          <span className="block truncate text-xs text-zinc-400">{summary.summary ?? summary.concerns[0] ?? ETHICS_RATING_LABELS[summary.rating]}</span>
        </span>
        <span className="shrink-0 text-right text-[11px] text-zinc-500">
          {summary.recheckNeeded ? <span className="block text-amber-300">recheck</span> : null}
          {summary.reviewDue ? <span className="block text-amber-300">refresh due</span> : null}
          {summary.decision ? <span className="block text-zinc-300">{summary.decision.replace("_", " ").toLowerCase()}</span> : null}
        </span>
      </Link>
    </li>
  );
}

function Section({ title, items, selected }: { title: string; items: EthicsSummary[]; selected: string | null }) {
  if (items.length === 0) return null;
  return (
    <section className="space-y-1.5">
      <h2 className="text-xs font-semibold uppercase tracking-normal text-zinc-500">
        {title} ({items.length})
      </h2>
      <ul className="space-y-1.5">
        {items.map((summary) => (
          <Row key={summary.ticker} summary={summary} selected={summary.ticker === selected} />
        ))}
      </ul>
    </section>
  );
}

export default async function EthicsPage({ searchParams }: { searchParams: Promise<{ ticker?: string }> }) {
  const user = await requireCurrentUser();
  const params = await searchParams;
  const setUp = await ethicsIsSetUp(user.id);
  const summaries = setUp ? [...(await getEthicsSummariesForUser(user.id)).values()] : [];

  const review = summaries.filter((s) => s.gate === "REVIEW");
  const blocked = summaries.filter((s) => s.gate === "BLOCKED");
  const ok = summaries.filter((s) => s.gate === "OK");
  const focusTicker = (params.ticker ?? review[0]?.ticker ?? summaries[0]?.ticker ?? "").toUpperCase() || null;
  const detail = setUp && focusTicker ? await getEthicsDetailForUser(user.id, focusTicker) : null;

  return (
    <div className="space-y-4">
      <div>
        <p className="text-sm font-medium text-emerald-300">Research</p>
        <h1 className="text-3xl font-semibold text-zinc-50">Ethics</h1>
        <p className="mt-1 max-w-2xl text-sm text-zinc-400">
          A policy-alignment score for each company, based on how directly it takes part in the activities you screen for - not on mere association. Evidence confidence is shown separately, and your decision always has the final say.{" "}
          <Link href="/research" className="text-sky-300 hover:text-sky-200">Back to Research</Link>
        </p>
      </div>

      {!setUp ? (
        <Panel title="Not set up yet">
          <p className="text-sm text-zinc-300">The database update for ethics research hasn&apos;t been applied yet, so nothing can be saved. Claude will walk you through the one-click step.</p>
        </Panel>
      ) : (
        <div className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_minmax(0,1.2fr)]">
          <div className="space-y-4">
            {summaries.length === 0 ? <p className="rounded-md border border-dashed border-zinc-800 p-4 text-sm text-zinc-400">Nothing researched yet. Ask Claude to research companies, then import the file below.</p> : null}
            <Section title="Needs your review" items={review} selected={focusTicker} />
            <Section title="Excluded" items={blocked} selected={focusTicker} />
            <Section title="Compatible" items={ok} selected={focusTicker} />
            <details className="rounded-md border border-zinc-800 bg-zinc-900/40 p-3">
              <summary className="cursor-pointer text-sm font-medium text-zinc-200">Import research</summary>
              <div className="mt-2">
                <EthicsImportForm />
              </div>
            </details>
          </div>

          <div>
            {detail ? (
              <Panel title={`${detail.summary.ticker} - ${detail.summary.companyName ?? "company"}`}>
                <div className="space-y-3 text-sm">
                  <p className="text-zinc-300">
                    <strong>{ETHICS_RATING_LABELS[detail.summary.gate === "BLOCKED" ? "EXCLUDED" : detail.summary.rating]}</strong>
                    {detail.summary.score !== null ? ` · score ${detail.summary.score}/100` : ""} · evidence confidence <strong>{detail.summary.confidence?.toLowerCase() ?? "n/a"}</strong> · researched {detail.summary.researchedAt}
                  </p>
                  {detail.summary.summary ? <p className="text-zinc-300">{detail.summary.summary}</p> : null}
                  {detail.summary.recheckNeeded ? <p className="text-amber-300">{detail.summary.recheckReason}</p> : null}

                  <div>
                    <h3 className="text-xs font-semibold uppercase tracking-normal text-zinc-500">Categories</h3>
                    <ul className="mt-1 space-y-1.5">
                      {detail.summary.assessments.map((a) => (
                        <li key={a.category} className="rounded border border-zinc-800 px-2 py-1.5">
                          <div className="flex justify-between gap-2 text-xs">
                            <span className="font-medium text-zinc-200">{ETHICS_CATEGORY_LABELS[a.category]}</span>
                            <span className={a.level === "NONE" || a.level === "INCIDENTAL" ? "text-zinc-400" : "font-medium text-amber-200"}>
                              {a.level.toLowerCase()}
                              {a.revenueSharePercent != null ? ` (~${a.revenueSharePercent}% of business)` : ""} · {a.confidence.toLowerCase()} confidence
                            </span>
                          </div>
                          <p className="mt-0.5 text-xs text-zinc-400">{a.summary}</p>
                        </li>
                      ))}
                    </ul>
                  </div>

                  {detail.evidence.length > 0 ? (
                    <div>
                      <h3 className="text-xs font-semibold uppercase tracking-normal text-zinc-500">Sources</h3>
                      <ul className="mt-1 space-y-1 text-xs">
                        {detail.evidence.map((item, index) => (
                          <li key={`${item.sourceUrl}-${index}`} className="text-zinc-400">
                            <span className="text-zinc-300">{item.category === "GENERAL" ? "Business overview" : (ETHICS_CATEGORY_LABELS[item.category as keyof typeof ETHICS_CATEGORY_LABELS] ?? item.category)}:</span> {item.claim}{" "}
                            <a href={item.sourceUrl} target="_blank" rel="noopener noreferrer" className="text-sky-300 underline underline-offset-2 hover:text-sky-200">
                              {SOURCE_LABELS[item.sourceType] ?? item.sourceType}
                            </a>{" "}
                            <span className="text-zinc-500">({SUPPORTS_LABELS[item.supports] ?? item.supports}{item.publishedAt ? `, ${item.publishedAt}` : ""})</span>
                          </li>
                        ))}
                      </ul>
                    </div>
                  ) : null}

                  <div>
                    <h3 className="text-xs font-semibold uppercase tracking-normal text-zinc-500">Your decision</h3>
                    {detail.summary.decisionNote ? <p className="mt-1 text-xs text-zinc-400">Note: {detail.summary.decisionNote}</p> : null}
                    <div className="mt-1">
                      <EthicsDecisionForm ticker={detail.summary.ticker} current={detail.summary.decision} />
                    </div>
                  </div>

                  {detail.history.length > 0 ? (
                    <details>
                      <summary className="cursor-pointer text-xs text-zinc-500">History ({detail.history.length})</summary>
                      <ul className="mt-1 space-y-0.5 text-xs text-zinc-500">
                        {detail.history.map((item, index) => (
                          <li key={`${item.at}-${index}`}>
                            {item.at.slice(0, 10)} · {item.kind.toLowerCase()}
                            {item.fromRating || item.toRating ? ` · ${item.fromRating ?? "-"} → ${item.toRating ?? "cleared"}` : ""}
                            {item.note ? ` · ${item.note}` : ""}
                          </li>
                        ))}
                      </ul>
                    </details>
                  ) : null}
                </div>
              </Panel>
            ) : (
              <p className="rounded-md border border-dashed border-zinc-800 p-4 text-sm text-zinc-400">Select a company to see its categories, sources and your decision.</p>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
