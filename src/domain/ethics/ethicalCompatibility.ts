/**
 * Ethical compatibility - a POLICY-ALIGNMENT score (0-100) for a company, not a probability that the company is
 * moral or immoral. Pure and deterministic: it turns already-researched, human-readable assessments into a score,
 * a color rating and a gate, and never looks anything up itself.
 *
 * Matt's framework (see docs/ROADMAP_DECISION_SYSTEM.md): what matters is DIRECT, substantial, intentional
 * participation, not distant association or politics. So each category is rated by how direct the involvement is,
 * not by whether the topic merely appears somewhere in the business:
 *
 *   NONE         reviewed; no involvement found
 *   INCIDENTAL   distant / ordinary commercial association, passive minority stake, minor donations - ~no weight
 *   MINOR        small but real involvement (e.g. gambling under 5% of the business) - a warning
 *   MODERATE     meaningful concern worth a review (e.g. gambling 5-10%, distribution, a controlled subsidiary)
 *   SUBSTANTIAL  substantial, intentional involvement (e.g. gambling over 10%, dedicated financing)
 *   DIRECT       the company itself does it, or it is the defining business -> hard exclusion once VERIFIED
 *
 * Evidence confidence is tracked SEPARATELY from the rating: a hard exclusion only takes effect when the evidence is
 * HIGH-confidence (verified from a primary source). A DIRECT finding on weaker evidence is flagged for Matt's review
 * instead, and a model-or-secondary-source judgment can therefore never exclude a company on its own.
 *
 * "No concerns found" is NOT the same as "verified acceptable". A clean category only earns full marks when its
 * evidence is HIGH confidence; an unverified (MEDIUM / LOW) clean category costs a small uncertainty deduction, and a
 * core category nobody has assessed yet costs a larger one. So a company that merely has not shown a concern after a
 * light review tops out around 80 ("no concerns found, not verified") and only a verified company can reach green.
 * Revenue percentages are only ever carried when a source states them; nothing here invents one.
 */

export const ETHICS_CATEGORIES = ["ABORTION", "PORNOGRAPHY", "GAMBLING", "PREDATORY_LENDING", "SUBSTANCES", "ASSOCIATIONS"] as const;
export type EthicsCategory = (typeof ETHICS_CATEGORIES)[number];

/** The four categories Matt treats as core - a company is only fully "reviewed" once these are all assessed. */
export const CORE_ETHICS_CATEGORIES: readonly EthicsCategory[] = ["ABORTION", "PORNOGRAPHY", "GAMBLING", "PREDATORY_LENDING"];

export const ETHICS_CATEGORY_LABELS: Record<EthicsCategory, string> = {
  ABORTION: "Abortion",
  PORNOGRAPHY: "Pornography",
  GAMBLING: "Gambling",
  PREDATORY_LENDING: "Predatory lending",
  SUBSTANCES: "Substances & marketing",
  ASSOCIATIONS: "Donations & associations",
};

export const INVOLVEMENT_LEVELS = ["NONE", "INCIDENTAL", "MINOR", "MODERATE", "SUBSTANTIAL", "DIRECT"] as const;
export type InvolvementLevel = (typeof INVOLVEMENT_LEVELS)[number];

export const EVIDENCE_CONFIDENCES = ["HIGH", "MEDIUM", "LOW"] as const;
export type EvidenceConfidence = (typeof EVIDENCE_CONFIDENCES)[number];

export const ETHICS_RATINGS = ["GREEN", "LIGHT_GREEN", "YELLOW", "RED", "EXCLUDED", "UNREVIEWED"] as const;
export type EthicsRating = (typeof ETHICS_RATINGS)[number];

export const ETHICS_DECISIONS = ["APPROVED", "EXCLUDED", "UNDER_REVIEW"] as const;
export type EthicsDecision = (typeof ETHICS_DECISIONS)[number];

export type CategoryAssessment = {
  category: EthicsCategory;
  level: InvolvementLevel;
  confidence: EvidenceConfidence;
  /** One or two plain sentences. */
  summary: string;
  /** Share of the business tied to this category - ONLY when a source states it; otherwise null. */
  revenueSharePercent?: number | null;
};

// Points taken off 100 for each level, before the category multiplier. Starting guidelines - meant to be tuned.
const LEVEL_POINTS: Record<InvolvementLevel, number> = { NONE: 0, INCIDENTAL: 2, MINOR: 10, MODERATE: 25, SUBSTANTIAL: 55, DIRECT: 100 };
// Abortion is Matt's most serious concern; associations the least.
const CATEGORY_MULTIPLIER: Record<EthicsCategory, number> = {
  ABORTION: 1.5,
  PORNOGRAPHY: 1.2,
  GAMBLING: 1,
  PREDATORY_LENDING: 1,
  SUBSTANCES: 0.7,
  ASSOCIATIONS: 0.5,
};
// Categories where a verified DIRECT finding is a hard exclusion on its own.
const HARD_EXCLUSION_CATEGORIES: readonly EthicsCategory[] = ["ABORTION", "PORNOGRAPHY", "GAMBLING", "PREDATORY_LENDING"];

// Uncertainty: points taken off (before the category multiplier) when a category shows no concern but is not verified,
// or has not been assessed at all. This is what stops insufficient research from reading as a perfect score.
const UNVERIFIED_CLEAN_POINTS: Record<EvidenceConfidence, number> = { HIGH: 0, MEDIUM: 3, LOW: 8 };
const UNASSESSED_CORE_POINTS = 12;

export const GAMBLING_MINOR_BELOW_PERCENT = 5;
export const GAMBLING_MODERATE_UP_TO_PERCENT = 10;
export const GAMBLING_DEFINING_FROM_PERCENT = 50;

/** Matt's sliding scale for diversified companies with some gambling: <5% warning, 5-10% review, more = substantial. */
export function gamblingLevelFromRevenueShare(percent: number): InvolvementLevel {
  if (!Number.isFinite(percent) || percent <= 0) return "NONE";
  if (percent < GAMBLING_MINOR_BELOW_PERCENT) return "MINOR";
  if (percent <= GAMBLING_MODERATE_UP_TO_PERCENT) return "MODERATE";
  if (percent < GAMBLING_DEFINING_FROM_PERCENT) return "SUBSTANTIAL";
  return "DIRECT";
}

const CONFIDENCE_RANK: Record<EvidenceConfidence, number> = { LOW: 0, MEDIUM: 1, HIGH: 2 };

export type EthicsEvaluation = {
  /** 0-100 policy alignment, or null when nothing has been assessed. */
  score: number | null;
  rating: EthicsRating;
  /** Lowest confidence among the assessed categories (the rating is only as solid as its weakest evidence). */
  confidence: EvidenceConfidence | null;
  /** True when a DIRECT/SUBSTANTIAL finding rests on evidence that is not yet verified - Matt should look. */
  needsReview: boolean;
  /** True when one or more core categories have not been assessed yet. */
  incomplete: boolean;
  /** True only when every core category is assessed with HIGH-confidence (primary-source) evidence. */
  verified: boolean;
  /** True when no assessed category shows even a minor concern (says nothing about how well that was verified). */
  noConcernsFound: boolean;
  /** Short plain-language reasons, worst first (for the compact tooltip). */
  concerns: string[];
};

export function evaluateEthicalCompatibility(assessments: readonly CategoryAssessment[]): EthicsEvaluation {
  // One assessment per category: if the same category appears twice, the worse level wins (never silently softened).
  const byCategory = new Map<EthicsCategory, CategoryAssessment>();
  for (const assessment of assessments) {
    const existing = byCategory.get(assessment.category);
    if (!existing || INVOLVEMENT_LEVELS.indexOf(assessment.level) > INVOLVEMENT_LEVELS.indexOf(existing.level)) {
      byCategory.set(assessment.category, assessment);
    }
  }
  const assessed = [...byCategory.values()];
  if (assessed.length === 0) {
    return { score: null, rating: "UNREVIEWED", confidence: null, needsReview: false, incomplete: true, verified: false, noConcernsFound: false, concerns: [] };
  }

  const incomplete = CORE_ETHICS_CATEGORIES.some((category) => !byCategory.has(category));
  const verified = !incomplete && CORE_ETHICS_CATEGORIES.every((category) => byCategory.get(category)?.confidence === "HIGH");
  const noConcernsFound = assessed.every((a) => INVOLVEMENT_LEVELS.indexOf(a.level) < INVOLVEMENT_LEVELS.indexOf("MINOR"));
  const confidence = assessed.reduce<EvidenceConfidence>((lowest, a) => (CONFIDENCE_RANK[a.confidence] < CONFIDENCE_RANK[lowest] ? a.confidence : lowest), "HIGH");

  const verifiedHardExclusion = assessed.some((a) => a.level === "DIRECT" && a.confidence === "HIGH" && HARD_EXCLUSION_CATEGORIES.includes(a.category));
  const unverifiedSevere = assessed.some((a) => (a.level === "DIRECT" || a.level === "SUBSTANTIAL") && a.confidence !== "HIGH");

  const concerns = [...assessed]
    .filter((a) => INVOLVEMENT_LEVELS.indexOf(a.level) >= INVOLVEMENT_LEVELS.indexOf("MINOR"))
    .sort((a, b) => INVOLVEMENT_LEVELS.indexOf(b.level) - INVOLVEMENT_LEVELS.indexOf(a.level) || CATEGORY_MULTIPLIER[b.category] - CATEGORY_MULTIPLIER[a.category])
    .map((a) => `${ETHICS_CATEGORY_LABELS[a.category]}: ${a.level.toLowerCase()}${a.revenueSharePercent != null ? ` (~${a.revenueSharePercent}% of business)` : ""} - ${a.summary}`);

  if (verifiedHardExclusion) {
    return { score: 0, rating: "EXCLUDED", confidence, needsReview: false, incomplete, verified, noConcernsFound, concerns };
  }

  const findingDeduction = assessed.reduce((sum, a) => sum + LEVEL_POINTS[a.level] * CATEGORY_MULTIPLIER[a.category], 0);
  // A category that shows no concern but is not verified costs a little; one nobody assessed yet costs more.
  const uncertaintyDeduction =
    assessed
      .filter((a) => INVOLVEMENT_LEVELS.indexOf(a.level) < INVOLVEMENT_LEVELS.indexOf("MINOR"))
      .reduce((sum, a) => sum + UNVERIFIED_CLEAN_POINTS[a.confidence] * CATEGORY_MULTIPLIER[a.category], 0) +
    CORE_ETHICS_CATEGORIES.filter((category) => !byCategory.has(category)).reduce((sum, category) => sum + UNASSESSED_CORE_POINTS * CATEGORY_MULTIPLIER[category], 0);
  const deduction = findingDeduction + uncertaintyDeduction;
  let score = Math.max(0, Math.round(100 - deduction));
  // A severe finding that is not verified can never read as better than a clear warning, and is always flagged.
  if (unverifiedSevere) score = Math.min(score, 39);

  let rating: EthicsRating = score >= 90 ? "GREEN" : score >= 70 ? "LIGHT_GREEN" : score >= 40 ? "YELLOW" : "RED";
  // Strongly compatible means VERIFIED compatible - never merely "nothing found yet".
  if (!verified && rating === "GREEN") rating = "LIGHT_GREEN";

  return { score, rating, confidence, needsReview: unverifiedSevere, incomplete, verified, noConcernsFound, concerns };
}

export type EthicsGate = "OK" | "REVIEW" | "BLOCKED" | "UNREVIEWED";

/**
 * What the rest of the app should do with this company. Matt's own decision always wins over the computed rating
 * (he is the final authority), except that material new evidence flagged for recheck turns an approval back into a review.
 */
export function ethicsGate(input: { rating: EthicsRating; needsReview: boolean; decision: EthicsDecision | null; recheckNeeded?: boolean }): EthicsGate {
  const { rating, needsReview, decision, recheckNeeded = false } = input;
  if (decision === "EXCLUDED") return "BLOCKED";
  if (decision === "UNDER_REVIEW") return "REVIEW";
  if (decision === "APPROVED") return recheckNeeded ? "REVIEW" : "OK";
  if (rating === "EXCLUDED") return "BLOCKED";
  if (rating === "UNREVIEWED") return "UNREVIEWED";
  if (needsReview || rating === "RED" || rating === "YELLOW") return "REVIEW";
  return "OK";
}

/** True when new research moved the company in a worse direction - the trigger to reconsider a past decision. */
export function isMaterialEthicsChange(
  previous: { rating: EthicsRating; assessments: readonly CategoryAssessment[] } | null,
  next: { rating: EthicsRating; assessments: readonly CategoryAssessment[] },
): boolean {
  if (!previous) return false;
  const order: EthicsRating[] = ["UNREVIEWED", "GREEN", "LIGHT_GREEN", "YELLOW", "RED", "EXCLUDED"];
  if (order.indexOf(next.rating) > order.indexOf(previous.rating) && previous.rating !== "UNREVIEWED") return true;
  return next.assessments.some((n) => {
    const before = previous.assessments.find((p) => p.category === n.category);
    return !!before && INVOLVEMENT_LEVELS.indexOf(n.level) > INVOLVEMENT_LEVELS.indexOf(before.level);
  });
}

/** Re-research is due when the scheduled review date has passed. */
export function ethicsReviewDue(reviewAfter: Date | null, now: Date): boolean {
  return !!reviewAfter && reviewAfter.getTime() <= now.getTime();
}

/** The label to show a person: separates "verified compatible" from "no concerns found yet, not verified". */
export function ethicsRatingLabel(rating: EthicsRating, flags: { verified: boolean; noConcernsFound: boolean }): string {
  if (rating === "GREEN") return "Verified compatible";
  if (rating === "LIGHT_GREEN" && flags.noConcernsFound && !flags.verified) return "No concerns found - not verified";
  return ETHICS_RATING_LABELS[rating];
}

export const ETHICS_RATING_LABELS: Record<EthicsRating, string> = {
  GREEN: "Strongly compatible",
  LIGHT_GREEN: "Generally acceptable",
  YELLOW: "Review concerns",
  RED: "Significant conflict",
  EXCLUDED: "Excluded",
  UNREVIEWED: "Not yet reviewed",
};
