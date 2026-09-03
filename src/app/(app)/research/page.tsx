import { summarizeCampaign } from "@/domain/finance/campaigns";
import { GATING_RULE_KEYS, SCANNER_RULE_DEFINITIONS } from "@/domain/scanner/profile";
import {
  honestSetupLabel,
  honestSetupScore,
  type CriterionResult,
  type CriterionStatus,
  type ScannerOperator,
  type ScanSummary,
} from "@/domain/scanner/scanner";
import { DEFAULT_RESEARCH_COLUMNS, sanitizeResearchColumns, isResearchSortKey, type ResearchSortKey } from "@/domain/research/columns";
import { IntentPrefetchLink } from "@/components/intent-prefetch-link";
import { requireCurrentUser } from "@/lib/auth";
import { getResearchPageData, normalizeTrackerScope, type TrackerScope } from "@/lib/app-data";
import { ResearchWorkspace } from "./research-workspace";

export const dynamic = "force-dynamic";

const ruleKeyByName = new Map(SCANNER_RULE_DEFINITIONS.map((definition) => [definition.name, definition.key]));

export type ResearchBuddy = { id: string; name: string };

type ResearchPageData = Awaited<ReturnType<typeof getResearchPageData>>;
export type ResearchItemRecord = NonNullable<ResearchPageData["ownWatchlist"]>["items"][number];
export type ResearchBuddyItemRecord = ResearchPageData["visibleItems"][number];

export type ResearchScanSnapshot = {
  score: number;
  label: ReturnType<typeof honestSetupLabel>;
  status: CriterionStatus;
  price: number | null;
  rsi: number | null;
  bbPercent: number | null;
  source: string;
  asOf: Date;
};

export type ResearchCampaignSummary = {
  count: number;
  realizedPL: number;
  rollCount: number;
  assignmentCount: number;
  lastOpenedAt: Date;
};

export default async function ResearchPage({
  searchParams,
}: {
  searchParams: Promise<{ error?: string; scope?: string }>;
}) {
  const user = await requireCurrentUser();
  const params = await searchParams;
  const scope: TrackerScope = normalizeTrackerScope(params.scope);
  const { users, ownWatchlist, visibleItems, latestRun, campaigns, settings } = await getResearchPageData(user.id);
  const buddyName = users[0]?.name ?? "Buddy";

  const scanByTicker = new Map<string, ResearchScanSnapshot>();
  for (const result of latestRun?.results ?? []) {
    if (scanByTicker.has(result.ticker)) {
      continue;
    }
    scanByTicker.set(result.ticker, buildScanSnapshot(result, latestRun!.source, latestRun!.createdAt));
  }

  const campaignByTicker = new Map<string, ResearchCampaignSummary>();
  for (const campaign of campaigns) {
    const summary = summarizeCampaign({ status: campaign.status, events: campaign.events });
    const existing = campaignByTicker.get(campaign.ticker);
    const rollCount = campaign.events.filter((event) => event.type === "ROLL_PUT_OPEN").length;
    const assignmentCount = campaign.events.filter((event) => event.type === "ASSIGNMENT").length;
    if (existing) {
      existing.count += 1;
      existing.realizedPL += summary.realizedPL ?? 0;
      existing.rollCount += rollCount;
      existing.assignmentCount += assignmentCount;
      if (campaign.openedAt > existing.lastOpenedAt) {
        existing.lastOpenedAt = campaign.openedAt;
      }
    } else {
      campaignByTicker.set(campaign.ticker, {
        count: 1,
        realizedPL: summary.realizedPL ?? 0,
        rollCount,
        assignmentCount,
        lastOpenedAt: campaign.openedAt,
      });
    }
  }

  const savedColumns = sanitizeResearchColumns(settings?.researchColumns);
  const columns = savedColumns.length ? savedColumns : DEFAULT_RESEARCH_COLUMNS;
  const sortKey: ResearchSortKey = isResearchSortKey(settings?.researchSortKey) ? settings!.researchSortKey : "added";

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h1 className="text-2xl font-semibold text-zinc-50">Research</h1>
        <div className="flex flex-wrap gap-2">
          {(["mine", "buddy", "both"] as TrackerScope[]).map((option) => (
            <IntentPrefetchLink key={option} href={researchHref(option)} className={scopeSegmentClass(scope === option)}>
              {option === "mine" ? "Mine" : option === "buddy" ? buddyName : "Both"}
            </IntentPrefetchLink>
          ))}
        </div>
      </div>

      <ResearchWorkspace
        scope={scope}
        buddyName={buddyName}
        items={ownWatchlist?.items ?? []}
        buddyItems={visibleItems}
        buddies={users}
        scanByTicker={Object.fromEntries(scanByTicker)}
        campaignByTicker={Object.fromEntries(campaignByTicker)}
        initialColumns={columns}
        initialSortKey={sortKey}
        error={params.error}
      />
    </div>
  );
}

function researchHref(scope: TrackerScope) {
  const params = new URLSearchParams();
  params.set("scope", scope);
  return `/research?${params.toString()}`;
}

function scopeSegmentClass(active: boolean) {
  return `rounded-md border px-3 py-2 text-sm transition ${
    active
      ? "border-emerald-400/70 bg-emerald-400/15 text-emerald-100"
      : "border-zinc-800 bg-zinc-900 text-zinc-300 hover:border-zinc-600 hover:text-zinc-50"
  }`;
}

/**
 * Mirrors scanner/page.tsx's toDomainSummary/toViewResult scoring exactly (same domain
 * functions, same GATING_RULE_KEYS) so a ticker's score/label here always matches what the
 * Scanner itself would show for the same run. Deliberately duplicated in full rather than
 * imported from the Scanner route, to avoid touching the already-approved Scanner redesign
 * for this slice - see PROJECT_HANDOFF.md Research section.
 */
function buildScanSnapshot(
  result: NonNullable<Awaited<ReturnType<typeof getResearchPageData>>["latestRun"]>["results"][number],
  source: string,
  asOf: Date,
): ResearchScanSnapshot {
  const criteria: CriterionResult[] = result.criterionResults.map((criterion) => ({
    key: ruleKeyByName.get(criterion.criterionName) ?? criterion.criterionName,
    name: criterion.criterionName,
    actualValue: parseActualValue(criterion.actualValue),
    operator: criterion.operator as ScannerOperator,
    desiredValue: criterion.desiredValue,
    status: criterion.status as CriterionStatus,
    explanation: criterion.explanation,
  }));
  const summary: ScanSummary = {
    status: result.summaryStatus as CriterionStatus,
    passed: result.passedCriteria,
    total: result.totalCriteria,
    results: criteria,
  };

  return {
    score: honestSetupScore(summary, GATING_RULE_KEYS),
    label: honestSetupLabel(summary, GATING_RULE_KEYS),
    status: summary.status,
    price: snapshotNumber(result.snapshotJson, "price"),
    rsi: snapshotNumber(result.snapshotJson, "rsi"),
    bbPercent: snapshotNumber(result.snapshotJson, "bbPercent"),
    source,
    asOf,
  };
}

function parseActualValue(raw: string | null) {
  if (raw === null || raw === "") {
    return null;
  }
  if (raw === "true") {
    return true;
  }
  if (raw === "false") {
    return false;
  }

  const parsed = Number(raw);
  return Number.isFinite(parsed) ? parsed : raw;
}

function snapshotNumber(snapshot: unknown, key: string) {
  if (!snapshot || typeof snapshot !== "object" || !(key in snapshot)) {
    return null;
  }

  const value = (snapshot as Record<string, unknown>)[key];
  if (value === null || value === undefined || value === "") {
    return null;
  }

  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}
