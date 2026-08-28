export const RECOMMENDATION_REASON_TAGS = [
  "Scanner looks good",
  "RSI",
  "Bollinger Bands",
  "Premium",
  "Delta",
  "Fundamentals",
  "Support",
  "Worth researching",
] as const;

export const RECOMMENDATION_STATUSES = ["NEW", "WATCHING", "PASSED", "ARCHIVED"] as const;

export type RecommendationStatus = (typeof RECOMMENDATION_STATUSES)[number];

export function isRecommendationStatus(value: string): value is RecommendationStatus {
  return RECOMMENDATION_STATUSES.includes(value as RecommendationStatus);
}

export function normalizeReasonTags(values: unknown[]) {
  const allowed = new Set<string>(RECOMMENDATION_REASON_TAGS);
  const tags = values
    .flatMap((value) => String(value ?? "").split(","))
    .map((tag) => tag.trim())
    .filter((tag) => allowed.has(tag));

  return [...new Set(tags)];
}
