"use server";

import { revalidatePath } from "next/cache";
import { requireCurrentUser } from "@/lib/auth";
import {
  normalizeQualityTicker,
  refreshCompanyQuality,
  removeCompanyQualityReview,
  saveCompanyQualityReview,
  type QualityRefreshOutcome,
  type SaveReviewResult,
} from "@/lib/company-quality";

const MAX_TICKERS_PER_CALL = 60;

/**
 * "Check company quality": refreshes the SEC-based reading for the given tickers (a bounded batch per call - the button
 * calls this again until nothing remains). Signed-in users only; tickers are validated and capped server-side.
 */
export async function refreshCompanyQualityAction(tickers: string[]): Promise<QualityRefreshOutcome> {
  await requireCurrentUser();
  if (!Array.isArray(tickers)) return { ok: false, error: "Nothing to check." };
  const clean = [...new Set(tickers.filter((t): t is string => typeof t === "string").map(normalizeQualityTicker).filter((t): t is string => t !== null))].slice(0, MAX_TICKERS_PER_CALL);
  if (!clean.length) return { ok: true, processed: 0, remaining: 0, notFound: 0, failed: 0 };
  const outcome = await refreshCompanyQuality(clean);
  if (outcome.ok && outcome.processed > 0) revalidatePath("/scanner");
  return outcome;
}

/** The owner's written "I've looked at this" for a CAUTION or VERIFY company. A REJECT is refused. */
export async function saveCompanyQualityReviewAction(ticker: string, note: string): Promise<SaveReviewResult> {
  const user = await requireCurrentUser();
  const result = await saveCompanyQualityReview(user.id, String(ticker ?? ""), String(note ?? ""));
  if (result.ok) revalidatePath("/scanner");
  return result;
}

export async function removeCompanyQualityReviewAction(ticker: string): Promise<SaveReviewResult> {
  const user = await requireCurrentUser();
  const result = await removeCompanyQualityReview(user.id, String(ticker ?? ""));
  if (result.ok) revalidatePath("/scanner");
  return result;
}
