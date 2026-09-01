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
import { requireCurrentUser } from "@/lib/auth";
import { getResearchPageData } from "@/lib/app-data";
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
};

export type ResearchCampaignSummary = {
  count: number;
  realizedPL: number;
  rollCount: number;
  lastOpenedAt: Date;
};

export default async function ResearchPage({
  searchParams,
}: {
  searchParams: Promise<{ error?: string }>;
}) {
  const user = await requireCurrentUser();
  const params = await searchParams;
  const { users, ownWatchlist, visibleItems, latestRun, campaigns } = await getResearchPageData(user.id);

  const scanByTicker = new Map<string, ResearchScanSnapshot>();
  for (const result of latestRun?.results ?? []) {
    if (scanByTicker.has(result.ticker)) {
      continue;
    }
    scanByTicker.set(result.ticker, buildScanSnapshot(result));
  }

  const campaignByTicker = new Map<string, ResearchCampaignSummary>();
  for (const campaign of campaigns) {
    const summary = summarizeCampaign({ status: campaign.status, events: campaign.events });
    const existing = campaignByTicker.get(campaign.ticker);
    const rollCount = campaign.events.filter((event) => event.type === "ROLL_PUT_OPEN").length;
    if (existing) {
      existing.count += 1;
      existing.realizedPL += summary.realizedPL ?? 0;
      existing.rollCount += rollCount;
      if (campaign.openedAt > existing.lastOpenedAt) {
        existing.lastOpenedAt = campaign.openedAt;
      }
    } else {
      campaignByTicker.set(campaign.ticker, {
        count: 1,
        realizedPL: summary.realizedPL ?? 0,
        rollCount,
        lastOpenedAt: campaign.openedAt,
      });
    }
  }

  return (
    <div className="space-y-3">
      <ResearchWorkspace
        items={ownWatchlist?.items ?? []}
        buddyItems={visibleItems}
        buddies={users}
        scanByTicker={Object.fromEntries(scanByTicker)}
        campaignByTicker={Object.fromEntries(campaignByTicker)}
        error={params.error}
      />
    </div>
  );
}

/**
 * Mirrors scanner/page.tsx's toDomainSummary/toViewResult scoring exactly (same domain
 * functions, same GATING_RULE_KEYS) so a ticker's score/label here always matches what the
 * Scanner itself would show for the same run. Deliberately duplicated in full rather than
 * imported from the Scanner route, to avoid touching the already-approved Scanner redesign
 * for this slice - see PROJECT_HANDOFF.md Research section.
 */
function buildScanSnapshot(result: NonNullable<Awaited<ReturnType<typeof getResearchPageData>>["latestRun"]>["results"][number]): ResearchScanSnapshot {
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
