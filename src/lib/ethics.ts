import "server-only";

import {
  ETHICS_CATEGORIES,
  ETHICS_DECISIONS,
  EVIDENCE_CONFIDENCES,
  INVOLVEMENT_LEVELS,
  ethicsGate,
  ethicsReviewDue,
  evaluateEthicalCompatibility,
  isMaterialEthicsChange,
  type CategoryAssessment,
  type EthicsDecision,
  type EthicsGate,
  type EthicsRating,
} from "@/domain/ethics/ethicalCompatibility";
import type { EthicsImportDocument } from "@/domain/ethics/ethicsImport";
import { prisma } from "./prisma";

/**
 * Company-level ethics research (see src/domain/ethics/ethicalCompatibility.ts). Researched once, cached, rechecked
 * on a review date or on material new evidence - never recomputed per option contract. Everything is scoped to the
 * signed-in user (the standards and the final decision are theirs).
 *
 * Reads tolerate a database that has not had the CompanyEthics migration applied yet (see
 * .github/workflows/apply-database-migrations.yml): they report "not set up" instead of throwing, so the code can be
 * deployed before or after the migration without breaking any page.
 */

export type EthicsSummary = {
  ticker: string;
  companyName: string | null;
  rating: EthicsRating;
  score: number | null;
  confidence: "HIGH" | "MEDIUM" | "LOW" | null;
  gate: EthicsGate;
  decision: EthicsDecision | null;
  decisionNote: string | null;
  needsReview: boolean;
  incomplete: boolean;
  recheckNeeded: boolean;
  recheckReason: string | null;
  reviewDue: boolean;
  summary: string | null;
  researchedAt: string;
  concerns: string[];
  assessments: CategoryAssessment[];
};

export type EthicsEvidenceItem = { category: string; claim: string; sourceUrl: string; sourceType: string; supports: string; publishedAt: string | null };
export type EthicsHistoryItem = { at: string; kind: string; fromRating: string | null; toRating: string | null; note: string | null };

/** True when the error just means the ethics tables are not in the database yet. */
export function isEthicsNotSetUpError(error: unknown): boolean {
  if (!error || typeof error !== "object") return false;
  const code = (error as { code?: string }).code;
  if (code === "P2021" || code === "P2022") return true;
  const message = String((error as { message?: string }).message ?? "");
  return /CompanyEthics/.test(message) && /does not exist|doesn't exist|no such table/i.test(message);
}

function parseAssessments(value: unknown): CategoryAssessment[] {
  if (!Array.isArray(value)) return [];
  const result: CategoryAssessment[] = [];
  for (const item of value) {
    if (!item || typeof item !== "object") continue;
    const row = item as Record<string, unknown>;
    if (!ETHICS_CATEGORIES.includes(row.category as never) || !INVOLVEMENT_LEVELS.includes(row.level as never) || !EVIDENCE_CONFIDENCES.includes(row.confidence as never)) continue;
    result.push({
      category: row.category as CategoryAssessment["category"],
      level: row.level as CategoryAssessment["level"],
      confidence: row.confidence as CategoryAssessment["confidence"],
      summary: typeof row.summary === "string" ? row.summary : "",
      revenueSharePercent: typeof row.revenueSharePercent === "number" ? row.revenueSharePercent : null,
    });
  }
  return result;
}

type ProfileRow = {
  ticker: string;
  companyName: string | null;
  assessments: unknown;
  summary: string | null;
  researchedAt: Date;
  reviewAfter: Date | null;
  recheckNeeded: boolean;
  recheckReason: string | null;
  decision: EthicsDecision | null;
  decisionNote: string | null;
};

function toSummary(row: ProfileRow, now: Date): EthicsSummary {
  const assessments = parseAssessments(row.assessments);
  // Recomputed from the stored assessments (the source of truth) so a tuned rule applies immediately.
  const evaluation = evaluateEthicalCompatibility(assessments);
  const decision = row.decision && ETHICS_DECISIONS.includes(row.decision) ? row.decision : null;
  return {
    ticker: row.ticker,
    companyName: row.companyName,
    rating: evaluation.rating,
    score: evaluation.score,
    confidence: evaluation.confidence,
    gate: ethicsGate({ rating: evaluation.rating, needsReview: evaluation.needsReview, decision, recheckNeeded: row.recheckNeeded }),
    decision,
    decisionNote: row.decisionNote,
    needsReview: evaluation.needsReview,
    incomplete: evaluation.incomplete,
    recheckNeeded: row.recheckNeeded,
    recheckReason: row.recheckReason,
    reviewDue: ethicsReviewDue(row.reviewAfter, now),
    summary: row.summary,
    researchedAt: row.researchedAt.toISOString().slice(0, 10),
    concerns: evaluation.concerns,
    assessments,
  };
}

const PROFILE_SELECT = {
  ticker: true,
  companyName: true,
  assessments: true,
  summary: true,
  researchedAt: true,
  reviewAfter: true,
  recheckNeeded: true,
  recheckReason: true,
  decision: true,
  decisionNote: true,
} as const;

/** Summaries for the given tickers (or all of the user's researched companies). Empty map when not set up. */
export async function getEthicsSummariesForUser(userId: string, tickers?: string[], now: Date = new Date()): Promise<Map<string, EthicsSummary>> {
  try {
    const rows = await prisma.companyEthicsProfile.findMany({
      where: { userId, ...(tickers ? { ticker: { in: [...new Set(tickers.map((t) => t.toUpperCase()))] } } : {}) },
      select: PROFILE_SELECT,
      orderBy: { ticker: "asc" },
    });
    return new Map(rows.map((row) => [row.ticker, toSummary(row, now)]));
  } catch (error) {
    if (isEthicsNotSetUpError(error)) return new Map();
    throw error;
  }
}

export async function getEthicsDetailForUser(
  userId: string,
  ticker: string,
  now: Date = new Date(),
): Promise<{ summary: EthicsSummary; evidence: EthicsEvidenceItem[]; history: EthicsHistoryItem[] } | null> {
  try {
    const row = await prisma.companyEthicsProfile.findUnique({
      where: { userId_ticker: { userId, ticker: ticker.toUpperCase() } },
      select: {
        ...PROFILE_SELECT,
        evidence: { select: { category: true, claim: true, sourceUrl: true, sourceType: true, supports: true, publishedAt: true }, orderBy: { retrievedAt: "desc" }, take: 40 },
        history: { select: { at: true, kind: true, fromRating: true, toRating: true, note: true }, orderBy: { at: "desc" }, take: 20 },
      },
    });
    if (!row) return null;
    return {
      summary: toSummary(row, now),
      evidence: row.evidence.map((item) => ({ ...item, publishedAt: item.publishedAt ? item.publishedAt.toISOString().slice(0, 10) : null })),
      history: row.history.map((item) => ({ ...item, at: item.at.toISOString() })),
    };
  } catch (error) {
    if (isEthicsNotSetUpError(error)) return null;
    throw error;
  }
}

/** Whether the ethics tables exist at all (so the page can say "not set up yet" instead of "nothing researched"). */
export async function ethicsIsSetUp(userId: string): Promise<boolean> {
  try {
    await prisma.companyEthicsProfile.count({ where: { userId } });
    return true;
  } catch (error) {
    if (isEthicsNotSetUpError(error)) return false;
    throw error;
  }
}

export type EthicsImportResult = { imported: number; changed: Array<{ ticker: string; from: EthicsRating | null; to: EthicsRating; material: boolean }> };

const DAY_MS = 24 * 60 * 60 * 1000;

/** Writes validated research. The user's own decisions are never overwritten - a worse new finding only flags a recheck. */
export async function importEthicsResearchForUser(userId: string, document: EthicsImportDocument): Promise<EthicsImportResult> {
  const changed: EthicsImportResult["changed"] = [];

  for (const company of document.companies) {
    const assessments: CategoryAssessment[] = company.assessments.map((a) => ({ ...a, revenueSharePercent: a.revenueSharePercent ?? null }));
    const evaluation = evaluateEthicalCompatibility(assessments);
    const researchedAt = new Date(`${company.researchedAt}T00:00:00Z`);
    const reviewAfter = new Date(researchedAt.getTime() + (company.reviewAfterDays ?? 180) * DAY_MS);

    const existing = await prisma.companyEthicsProfile.findUnique({
      where: { userId_ticker: { userId, ticker: company.ticker } },
      select: { id: true, assessments: true, decision: true },
    });
    const previousAssessments = existing ? parseAssessments(existing.assessments) : null;
    const previous = previousAssessments ? { rating: evaluateEthicalCompatibility(previousAssessments).rating, assessments: previousAssessments } : null;
    const material = isMaterialEthicsChange(previous, { rating: evaluation.rating, assessments });
    const recheckNeeded = !!existing?.decision && material;

    const data = {
      companyName: company.companyName ?? null,
      assessments: assessments as unknown as object,
      score: evaluation.score,
      rating: evaluation.rating,
      confidence: evaluation.confidence,
      needsReview: evaluation.needsReview,
      incomplete: evaluation.incomplete,
      summary: company.summary ?? null,
      researchedAt,
      reviewAfter,
      recheckNeeded,
      recheckReason: recheckNeeded ? `New research is worse than before (${previous?.rating} -> ${evaluation.rating}). Your earlier decision needs a second look.` : null,
    };

    await prisma.$transaction(async (tx) => {
      const profile = existing
        ? await tx.companyEthicsProfile.update({ where: { id: existing.id }, data })
        : await tx.companyEthicsProfile.create({ data: { ...data, userId, ticker: company.ticker } });
      await tx.companyEthicsEvidence.deleteMany({ where: { profileId: profile.id } });
      if (company.evidence.length) {
        await tx.companyEthicsEvidence.createMany({
          data: company.evidence.map((item) => ({
            profileId: profile.id,
            category: item.category,
            claim: item.claim,
            sourceUrl: item.sourceUrl,
            sourceType: item.sourceType,
            supports: item.supports,
            publishedAt: item.publishedAt ? new Date(`${item.publishedAt}T00:00:00Z`) : null,
          })),
        });
      }
      await tx.companyEthicsHistory.create({
        data: {
          profileId: profile.id,
          kind: "RESEARCH",
          fromRating: previous?.rating ?? null,
          toRating: evaluation.rating,
          note: material ? "Material change from earlier research." : null,
        },
      });
    });
    changed.push({ ticker: company.ticker, from: previous?.rating ?? null, to: evaluation.rating, material });
  }
  return { imported: document.companies.length, changed };
}

/** Records the user's own call. null clears it (back to the computed rating). Returns false when no profile exists. */
export async function setEthicsDecisionForUser(userId: string, ticker: string, decision: EthicsDecision | null, note: string | null, now: Date = new Date()): Promise<boolean> {
  const existing = await prisma.companyEthicsProfile.findUnique({
    where: { userId_ticker: { userId, ticker: ticker.toUpperCase() } },
    select: { id: true, decision: true, rating: true },
  });
  if (!existing) return false;
  const cleanNote = note?.trim().slice(0, 500) || null;
  await prisma.$transaction([
    prisma.companyEthicsProfile.update({
      where: { id: existing.id },
      data: { decision, decisionNote: decision ? cleanNote : null, decidedAt: decision ? now : null, recheckNeeded: false, recheckReason: null },
    }),
    prisma.companyEthicsHistory.create({
      data: { profileId: existing.id, kind: "DECISION", fromRating: existing.decision, toRating: decision, note: cleanNote },
    }),
  ]);
  return true;
}
