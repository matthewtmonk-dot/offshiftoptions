"use server";

import type { ReactionTargetType } from "@/generated/prisma/enums";
import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { getCurrentSessionTokenHash, requireCurrentUser, signOut } from "@/lib/auth";
import { changePasswordForUser } from "@/lib/account";
import {
  addAccountLedgerEntryForUser,
  addReactionForUser,
  addRecommendationCommentForUser,
  addWatchlistCommentForUser,
  assignCampaignPutForUser,
  closeCampaignPutForUser,
  createCampaignForUser,
  createTradingAccountForUser,
  createRecommendationForUser,
  createWatchlistItemForUser,
  markAllNotificationsReadForUser,
  markConversationReadForUser,
  markNotificationReadForUser,
  removeSchwabDeveloperCredentialsForUser,
  removeWatchlistItemForUser,
  rerunDemoScannerForUser,
  rerunLiveSchwabScannerForUser,
  type LiveScanRunSummary,
  resetScannerSettingsToLstCoreForUser,
  rollCampaignPutForUser,
  safeReturnPath,
  saveSchwabDeveloperCredentialsForUser,
  saveStockNoteForUser,
  sendChatMessageForUser,
  setResearchStatusForUser,
  syncSchwabAccountForUser,
  toggleCampaignVisibilityForUser,
  toggleTradingAccountVisibilityForUser,
  toggleWatchlistItemVisibilityForUser,
  updateRecommendationStatusForUser,
  updateResearchColumnsForUser,
  updateResearchDetailsForUser,
  updateRollBufferPercentForUser,
  updateScannerSettingsForUser,
} from "@/lib/workflows";
import type { AppearanceMode } from "@/generated/prisma/enums";
import { updateAppearanceForUser } from "@/lib/appearance";
import {
  categorizeSchwabSyncError,
  disconnectSchwabForUser,
  logSchwabSyncFailure,
  recordSchwabSyncDiagnostics,
  resolveMarketDataProviderForUser,
} from "@/lib/broker-connections";
import { runScannerUniverseDryRun } from "@/lib/scanner-universe-dry-run";
import { runLatestCandleFreshnessDiagnostic } from "@/lib/latest-candle-freshness-diagnostic";
import { OCC_OPTIONABLE_UNIVERSE_SOURCE } from "@/lib/occ-optionable-universe-refresh";
import {
  getTechnicalCacheFreshnessBreakdownForUser,
  getTechnicalCacheReadinessForUser,
  getTechnicalPreparationRunAggregatesForUser,
  refreshTechnicalIndicatorCacheBatchForUser,
  TECHNICAL_REFRESH_BATCH_SIZE,
} from "@/lib/technical-indicator-cache";
import {
  runSchwabTransactionsDiagnosticForUser,
  type SchwabTransactionsDiagnosticResult,
} from "@/lib/schwab-transactions-diagnostic";
import { runSchwabQuoteBatchDiagnosticForUser, type SchwabQuoteBatchDiagnosticResult } from "@/lib/schwab-quote-batch-diagnostic";
import {
  getSanitizedBrokerRecordClassificationForUser,
  type BrokerRecordClassificationReport,
} from "@/lib/broker-record-classification-diagnostic";
import {
  previewMalformedSchwabTransactionRepairForUser,
  repairMalformedSchwabTransactionRecordsForUser,
  type SchwabRecordRepairPreview,
  type SchwabRecordRepairResult,
} from "@/lib/schwab-record-repair";
import {
  getSanitizedCampaignEventSequenceForUser,
  type CampaignEventSequenceReport,
} from "@/lib/campaign-event-sequence-diagnostic";
import {
  previewCampaignHistoryRepairForUser,
  repairCampaignHistoryForUser,
  type CampaignHistoryRepairPreview,
  type CampaignHistoryRepairResult,
} from "@/lib/campaign-history-repair";
import { confirmBrokerImportForUser, discardBrokerImportForUser, previewBrokerImportForUser } from "@/lib/broker-import";
import {
  confirmBrokerPositionAsCampaignForUser,
  skipBrokerReconciliationForUser,
} from "@/lib/broker-reconciliation";
import { reconcileSchwabActivityForUser } from "@/lib/campaign-reconciliation";
import { ValidationError, requireTicker } from "@/lib/tickers";
import {
  runAlphaVantageOverviewDiagnostic,
  runAlphaVantageRemainingTickersDiagnostic,
  type AlphaVantageDiagnosticResult,
} from "@/lib/alpha-vantage-diagnostic";
import {
  processAlphaVantageFundamentalsQueue,
  refreshSingleTickerFundamentals,
  type ProcessQueueSummary,
  type ManualRefreshResult,
} from "@/lib/alpha-vantage-fundamentals";

function redirectWithError(path: string, error: string): never {
  redirect(`${path}?error=${encodeURIComponent(error)}`);
}

function actionReturnPath(formData: FormData, fallback: string) {
  return safeReturnPath(formData.get("returnTo"), fallback);
}

export async function signOutAction() {
  await signOut();
  redirect("/login");
}

const APPEARANCE_VALUES = new Set<AppearanceMode>(["DARK", "LIGHT", "SYSTEM"]);

/**
 * Called directly from the client AppearanceControl component (not via <form action>) so
 * the button click can apply the DOM/cookie change optimistically while this persists to
 * the database in the background. No redirect/revalidate - changing appearance never
 * changes page content in a way that needs a fresh server render of the current view.
 */
export async function updateAppearanceAction(value: string) {
  const user = await requireCurrentUser();
  if (!APPEARANCE_VALUES.has(value as AppearanceMode)) {
    throw new ValidationError("Invalid appearance value.");
  }

  await updateAppearanceForUser(user.id, value as AppearanceMode);
}

export async function addWatchlistItemAction(formData: FormData) {
  const user = await requireCurrentUser();
  const returnTo = actionReturnPath(formData, "/research");

  try {
    await createWatchlistItemForUser(user.id, formData.get("ticker"));
  } catch (error) {
    if (error instanceof ValidationError) {
      redirectWithError(returnTo, error.message);
    }
    throw error;
  }

  revalidatePath("/research");
  revalidatePath("/scanner");
  revalidatePath("/dashboard");
}

/**
 * The one-click Research/Watch/Exclude action from both the Scanner and the Research page.
 * Not a `returnTo`-based redirect action - both callers stay on their current page and just
 * see the badge/filter update after revalidation.
 */
export async function setResearchStatusAction(formData: FormData) {
  const user = await requireCurrentUser();

  try {
    await setResearchStatusForUser(user.id, formData.get("ticker"), formData.get("status"));
  } catch (error) {
    if (error instanceof ValidationError) {
      return { ok: false as const, error: error.message };
    }
    throw error;
  }

  revalidatePath("/research");
  revalidatePath("/scanner");
  return { ok: true as const };
}

export async function updateResearchDetailsAction(formData: FormData) {
  const user = await requireCurrentUser();

  try {
    await updateResearchDetailsForUser(user.id, String(formData.get("itemId") ?? ""), formData);
  } catch (error) {
    if (error instanceof ValidationError) {
      redirectWithError("/research", error.message);
    }
    throw error;
  }

  revalidatePath("/research");
  revalidatePath("/scanner");
}

export type UpdateResearchColumnsResult = { ok: true; columns: string[]; sortKey: string | null } | { ok: false; error: string };

/**
 * Saves the current user's Research column visibility/order/sort. Called directly from the
 * client (not a <form>) whenever the Columns menu changes, so it never blocks on a
 * revalidate/redirect - it's a background preference save, not a data mutation the rest of
 * the page needs to reflect immediately.
 */
export async function updateResearchColumnsAction(columns: string[], sortKey: string | null): Promise<UpdateResearchColumnsResult> {
  const user = await requireCurrentUser();

  try {
    const result = await updateResearchColumnsForUser(user.id, columns, sortKey);
    return { ok: true, ...result };
  } catch (error) {
    if (error instanceof ValidationError) {
      return { ok: false, error: error.message };
    }
    throw error;
  }
}

export async function removeWatchlistItemAction(formData: FormData) {
  const user = await requireCurrentUser();
  await removeWatchlistItemForUser(user.id, String(formData.get("itemId") ?? ""));

  revalidatePath("/research");
  revalidatePath("/scanner");
  revalidatePath("/dashboard");
}

export async function toggleWatchlistItemVisibilityAction(formData: FormData) {
  const user = await requireCurrentUser();
  await toggleWatchlistItemVisibilityForUser(user.id, String(formData.get("itemId") ?? ""));

  revalidatePath("/research");
  revalidatePath("/dashboard");
}

export async function saveStockNoteAction(formData: FormData) {
  const user = await requireCurrentUser();
  await saveStockNoteForUser(
    user.id,
    String(formData.get("itemId") ?? ""),
    formData.get("category"),
    formData.get("body"),
  );

  revalidatePath("/research");
  revalidatePath("/dashboard");
}

export async function addWatchlistCommentAction(formData: FormData) {
  const user = await requireCurrentUser();
  await addWatchlistCommentForUser(user.id, String(formData.get("itemId") ?? ""), formData.get("body"));

  revalidatePath("/research");
  revalidatePath("/dashboard");
}

export async function recommendStockAction(formData: FormData) {
  const user = await requireCurrentUser();
  const returnTo = actionReturnPath(formData, "/recommendations");

  try {
    await createRecommendationForUser(
      user.id,
      formData.get("ticker"),
      String(formData.get("recipientId") ?? ""),
      formData.get("message"),
      formData.getAll("reasonTags"),
    );
  } catch (error) {
    if (error instanceof ValidationError) {
      redirectWithError(returnTo, error.message);
    }
    throw error;
  }

  revalidatePath("/recommendations");
  revalidatePath("/research");
  revalidatePath("/scanner");
  revalidatePath("/dashboard");
}

export async function updateRecommendationStatusAction(formData: FormData) {
  const user = await requireCurrentUser();
  await updateRecommendationStatusForUser(
    user.id,
    String(formData.get("recommendationId") ?? ""),
    formData.get("status"),
  );

  revalidatePath("/recommendations");
  revalidatePath("/dashboard");
}

export async function addRecommendationCommentAction(formData: FormData) {
  const user = await requireCurrentUser();
  await addRecommendationCommentForUser(
    user.id,
    String(formData.get("recommendationId") ?? ""),
    formData.get("body"),
  );

  revalidatePath("/recommendations");
  revalidatePath("/dashboard");
}

export async function addReactionAction(formData: FormData) {
  const user = await requireCurrentUser();
  await addReactionForUser(
    user.id,
    String(formData.get("targetType") ?? "") as ReactionTargetType,
    String(formData.get("targetId") ?? ""),
  );

  revalidatePath("/dashboard");
  revalidatePath("/research");
  revalidatePath("/recommendations");
  revalidatePath("/positions");
  revalidatePath("/notifications");
}

export type SendChatMessageActionResult =
  | { ok: true; messageId: string | null; submittedAt: number }
  | { ok: false; error: string; submittedAt: number };

export async function sendChatMessageAction(formData: FormData): Promise<SendChatMessageActionResult> {
  const user = await requireCurrentUser();

  try {
    const message = await sendChatMessageForUser(
      user.id,
      String(formData.get("conversationId") ?? ""),
      formData.get("body"),
      formData.get("ticker"),
      formData.getAll("attachments"),
    );

    revalidatePath("/chat");
    revalidatePath("/dashboard");
    revalidatePath("/notifications");

    return { ok: true, messageId: message?.id ?? null, submittedAt: Date.now() };
  } catch (error) {
    if (error instanceof ValidationError) {
      return { ok: false, error: error.message, submittedAt: Date.now() };
    }
    throw error;
  }
}

export async function markConversationReadAction(formData: FormData) {
  const user = await requireCurrentUser();
  await markConversationReadForUser(user.id, String(formData.get("conversationId") ?? ""));

  revalidatePath("/chat");
  revalidatePath("/dashboard");
}

export async function markNotificationReadAction(formData: FormData) {
  const user = await requireCurrentUser();
  await markNotificationReadForUser(user.id, String(formData.get("notificationId") ?? ""));

  revalidatePath("/notifications");
  revalidatePath("/dashboard");
}

export async function markAllNotificationsReadAction() {
  const user = await requireCurrentUser();
  await markAllNotificationsReadForUser(user.id);

  revalidatePath("/notifications");
  revalidatePath("/dashboard");
}

export async function updateScannerSettingsAction(formData: FormData) {
  const user = await requireCurrentUser();

  try {
    await updateScannerSettingsForUser(user.id, formData);
  } catch (error) {
    if (error instanceof Error) {
      redirectWithError("/scanner/settings", error.message);
    }
    throw error;
  }

  revalidatePath("/scanner/settings");
  revalidatePath("/scanner");
  revalidatePath("/dashboard");
  redirect("/scanner/settings?saved=1");
}

export async function updateRollBufferAction(formData: FormData) {
  const user = await requireCurrentUser();

  try {
    await updateRollBufferPercentForUser(user.id, formData.get("rollBufferPercent"));
  } catch (error) {
    if (error instanceof Error) {
      redirectWithError("/scanner/settings", error.message);
    }
    throw error;
  }

  revalidatePath("/scanner/settings");
  revalidatePath("/dashboard");
  revalidatePath("/positions");
  redirect("/scanner/settings?saved=rollbuffer");
}

export async function resetScannerSettingsToLstCoreAction() {
  const user = await requireCurrentUser();
  await resetScannerSettingsToLstCoreForUser(user.id);

  revalidatePath("/scanner/settings");
  revalidatePath("/scanner");
  revalidatePath("/dashboard");
  redirect("/scanner/settings?saved=core");
}

export async function runDemoScannerAction() {
  const user = await requireCurrentUser();
  await rerunDemoScannerForUser(user.id);

  revalidatePath("/scanner");
  revalidatePath("/dashboard");
}

export type RunLiveScanResult =
  | ({ ok: true } & LiveScanRunSummary)
  | { ok: false; error: string };

export async function runLiveSchwabScannerAction(): Promise<RunLiveScanResult> {
  const user = await requireCurrentUser();

  try {
    const summary = await rerunLiveSchwabScannerForUser(user.id);
    revalidatePath("/scanner");
    revalidatePath("/dashboard");
    return { ok: true, ...summary };
  } catch (error) {
    if (error instanceof ValidationError) {
      return { ok: false, error: error.message };
    }
    throw error;
  }
}

export async function runSchwabTransactionsDiagnosticAction(): Promise<SchwabTransactionsDiagnosticResult> {
  const user = await requireCurrentUser();
  return runSchwabTransactionsDiagnosticForUser(user.id);
}

export async function runSchwabQuoteBatchDiagnosticAction(): Promise<SchwabQuoteBatchDiagnosticResult> {
  const user = await requireCurrentUser();
  return runSchwabQuoteBatchDiagnosticForUser(user.id);
}

export type ScannerUniverseDryRunActionResult =
  | { status: "UNAVAILABLE"; reason: "NO_USER_CONNECTION" | "TOKEN_UNAVAILABLE"; message: string }
  | {
      status: "OK";
      universeSymbols: number;
      successfullyQuoted: number;
      quoteFailures: number;
      priceSurvivors: number;
      priceAndVolumeSurvivors: number;
      earningsKnown: number;
      earningsUnknown: number;
      estimatedHistoryCallsRequired: number;
      estimatedOptionChainCallsRequired: number;
    };

/**
 * Read-only Stage 1 measurement, using ONLY the current authenticated user's own resolved
 * market-data provider (never a shared/cross-user backend - see resolveMarketDataProviderForUser
 * and its `sharedFallback: "DISABLED_POLICY_NOT_VERIFIED"` contract). Matt's dry run uses Matt's
 * connection; Eric's, once he has one, uses his own. Never fetches history/chains, never creates
 * a ScanRun, never touches Research/campaign data - see runScannerUniverseDryRun.
 */
export async function runScannerUniverseDryRunAction(): Promise<ScannerUniverseDryRunActionResult> {
  const user = await requireCurrentUser();
  const resolved = await resolveMarketDataProviderForUser(user.id);
  if (!resolved.provider) {
    return {
      status: "UNAVAILABLE",
      reason: resolved.reason,
      message:
        resolved.reason === "NO_USER_CONNECTION"
          ? "Connect Schwab from Account before running this read-only measurement."
          : "Reconnect Schwab from Account before running this read-only measurement.",
    };
  }

  const result = await runScannerUniverseDryRun(user.id, resolved.provider);
  return {
    status: "OK",
    universeSymbols: result.universeSymbols,
    successfullyQuoted: result.successfullyQuoted,
    quoteFailures: result.universeSymbols - result.successfullyQuoted,
    priceSurvivors: result.priceSurvivors,
    priceAndVolumeSurvivors: result.priceAndVolumeSurvivors,
    earningsKnown: result.earningsKnown,
    earningsUnknown: result.earningsUnknown,
    estimatedHistoryCallsRequired: result.estimatedHistoryCallsRequired,
    estimatedOptionChainCallsRequired: result.estimatedOptionChainCallsRequired,
  };
}

export type TechnicalCacheWarmActionResult =
  | { status: "UNAVAILABLE"; reason: "NO_USER_CONNECTION" | "TOKEN_UNAVAILABLE"; message: string }
  | {
      status: "OK";
      processedCount: number;
      succeededCount: number;
      deferredCount: number;
      failedCount: number;
      remainingEligibleCount: number;
      elapsedMs: number;
    }
  | {
      /** The global daily-candle-availability gate was not safe to pass - no bulk work was
       * attempted (at most 5 read-only history requests were spent probing). */
      status: "DAILY_CANDLE_NOT_READY" | "CANDLE_GATE_INCONCLUSIVE";
      requiredMarketDate: string;
      freshProbeCount: number;
      staleProbeCount: number;
      unavailableProbeCount: number;
    };

/**
 * Explicit-click warm-cache action - the ONLY way this user's technical cache is refreshed right
 * now (no schedule, no cron secret exists for this yet - see PROJECT_HANDOFF.md "Background
 * invocation design"). Resolves and uses ONLY the current authenticated user's own market-data
 * provider (same resolveMarketDataProviderForUser isolation as the dry run / batch diagnostic) -
 * this deliberately cannot be triggered for, or on behalf of, any other user. Processes at most
 * TECHNICAL_REFRESH_BATCH_SIZE symbols per click - never a long-running single request.
 */
export async function warmTechnicalIndicatorCacheAction(): Promise<TechnicalCacheWarmActionResult> {
  const user = await requireCurrentUser();
  const resolved = await resolveMarketDataProviderForUser(user.id);
  if (!resolved.provider) {
    return {
      status: "UNAVAILABLE",
      reason: resolved.reason,
      message:
        resolved.reason === "NO_USER_CONNECTION"
          ? "Connect Schwab from Account before warming the technical cache."
          : "Reconnect Schwab from Account before warming the technical cache.",
    };
  }

  const result = await refreshTechnicalIndicatorCacheBatchForUser(user.id, resolved.provider, { batchSize: TECHNICAL_REFRESH_BATCH_SIZE });
  if (result.status !== "OK") {
    return {
      status: result.status,
      requiredMarketDate: result.requiredMarketDate.toISOString().slice(0, 10),
      freshProbeCount: result.freshProbeCount,
      staleProbeCount: result.staleProbeCount,
      unavailableProbeCount: result.unavailableProbeCount,
    };
  }
  return {
    status: "OK",
    processedCount: result.processedCount,
    succeededCount: result.succeededCount,
    deferredCount: result.deferredCount,
    failedCount: result.failedCount,
    remainingEligibleCount: result.remainingEligibleCount,
    elapsedMs: result.elapsedMs,
  };
}

export type TechnicalCacheReadinessActionResult =
  | { status: "UNAVAILABLE"; reason: "NO_USER_CONNECTION" | "TOKEN_UNAVAILABLE"; message: string }
  | {
      status: "OK";
      eligibleCount: number;
      readyCount: number;
      pendingCount: number;
      deferredCount: number;
      failedCount: number;
      lastPreparedAt: string | null;
    }
  | {
      status: "DAILY_CANDLE_NOT_READY" | "CANDLE_GATE_INCONCLUSIVE";
      requiredMarketDate: string;
      freshProbeCount: number;
      staleProbeCount: number;
      unavailableProbeCount: number;
    };

/** Read-only - never fetches a quote or history, just reports the current cache state (still
 * needs the user's resolved provider to compute the CURRENT eligible set via Phase A's quote
 * sweep, so this is not entirely free, but it never touches history/option-chain endpoints). */
export async function getTechnicalCacheReadinessAction(): Promise<TechnicalCacheReadinessActionResult> {
  const user = await requireCurrentUser();
  const resolved = await resolveMarketDataProviderForUser(user.id);
  if (!resolved.provider) {
    return {
      status: "UNAVAILABLE",
      reason: resolved.reason,
      message:
        resolved.reason === "NO_USER_CONNECTION"
          ? "Connect Schwab from Account to check technical cache readiness."
          : "Reconnect Schwab from Account to check technical cache readiness.",
    };
  }

  const status = await getTechnicalCacheReadinessForUser(user.id, resolved.provider);
  if (status.status !== "OK") {
    return {
      status: status.status,
      requiredMarketDate: status.requiredMarketDate.toISOString().slice(0, 10),
      freshProbeCount: status.freshProbeCount,
      staleProbeCount: status.staleProbeCount,
      unavailableProbeCount: status.unavailableProbeCount,
    };
  }
  return {
    status: "OK",
    eligibleCount: status.eligibleCount,
    readyCount: status.readyCount,
    pendingCount: status.pendingCount,
    deferredCount: status.deferredCount,
    failedCount: status.failedCount,
    lastPreparedAt: status.lastPreparedAt?.toISOString() ?? null,
  };
}

export type TechnicalCacheFreshnessBreakdownActionResult =
  | { status: "NO_ACTIVE_RUN" }
  | {
      status: "OK";
      eligibleCount: number;
      workflowReadyCount: number;
      freshUsableCount: number;
      staleSnapshotCount: number;
      failedSnapshotCount: number;
      missingSnapshotCount: number;
      pendingCount: number;
      deferredCount: number;
      requiredMarketDate: string;
      newestSnapshotMarketDate: string | null;
      oldestFreshSnapshotMarketDate: string | null;
    };

/** DB-only - no Schwab call, no provider resolution. Refines the plain workflow-completion
 * readyCount above with the live scan's own asOfDate freshness rule (getTechnicalIndicatorSnapshotsForUser),
 * so this panel and the scanner can never disagree about what "ready" means. Never lists individual
 * tickers or exposes broker/account data - aggregate counts and safe date-only fields only. */
export async function getTechnicalCacheFreshnessBreakdownAction(): Promise<TechnicalCacheFreshnessBreakdownActionResult> {
  const user = await requireCurrentUser();
  const breakdown = await getTechnicalCacheFreshnessBreakdownForUser(user.id);
  if (!breakdown.hasActiveRun) {
    return { status: "NO_ACTIVE_RUN" };
  }
  return {
    status: "OK",
    eligibleCount: breakdown.eligibleCount,
    workflowReadyCount: breakdown.workflowReadyCount,
    freshUsableCount: breakdown.freshUsableCount,
    staleSnapshotCount: breakdown.staleSnapshotCount,
    failedSnapshotCount: breakdown.failedSnapshotCount,
    missingSnapshotCount: breakdown.missingSnapshotCount,
    pendingCount: breakdown.pendingCount,
    deferredCount: breakdown.deferredCount,
    requiredMarketDate: breakdown.requiredMarketDate.toISOString().slice(0, 10),
    newestSnapshotMarketDate: breakdown.newestSnapshotMarketDate?.toISOString().slice(0, 10) ?? null,
    oldestFreshSnapshotMarketDate: breakdown.oldestFreshSnapshotMarketDate?.toISOString().slice(0, 10) ?? null,
  };
}

export type TechnicalPreparationRunAggregatesActionResult = {
  status: "OK";
  currentMarketDate: string;
  requiredMarketDate: string;
  runs: {
    marketDate: string;
    runStatus: "IN_PROGRESS" | "COMPLETE";
    eligibleCount: number | null;
    itemCount: number;
    pendingCount: number;
    processingCount: number;
    readyCount: number;
    deferredCount: number;
    failedCount: number;
    isCurrentRunIdentity: boolean;
    createdAt: string;
    updatedAt: string;
  }[];
};

/** DB-only aggregate preparation-run diagnostic. It never resolves a provider, never creates or
 * reconciles a run, never fetches quotes/history, and never lists tickers or account data. */
export async function getTechnicalPreparationRunAggregatesAction(): Promise<TechnicalPreparationRunAggregatesActionResult> {
  const user = await requireCurrentUser();
  const aggregates = await getTechnicalPreparationRunAggregatesForUser(user.id);
  return {
    status: "OK",
    currentMarketDate: aggregates.currentMarketDate.toISOString().slice(0, 10),
    requiredMarketDate: aggregates.requiredMarketDate.toISOString().slice(0, 10),
    runs: aggregates.runs.map((run) => ({
      marketDate: run.marketDate.toISOString().slice(0, 10),
      runStatus: run.status,
      eligibleCount: run.eligibleCount,
      itemCount: run.itemCount,
      pendingCount: run.pendingCount,
      processingCount: run.processingCount,
      readyCount: run.readyCount,
      deferredCount: run.deferredCount,
      failedCount: run.failedCount,
      isCurrentRunIdentity: run.isCurrentRunIdentity,
      createdAt: run.createdAt.toISOString(),
      updatedAt: run.updatedAt.toISOString(),
    })),
  };
}

export type LatestCandleFreshnessDiagnosticActionResult =
  | { status: "UNAVAILABLE"; reason: "NO_USER_CONNECTION" | "TOKEN_UNAVAILABLE"; message: string }
  | {
      status: "OK";
      requiredMarketDate: string;
      rows: { ticker: string; latestCandleMarketDate: string | null; fresh: boolean }[];
    };

/** Read-only, explicit-click - see PROJECT_HANDOFF.md's readiness-mismatch investigation. Fetches
 * real price history (the same window technical preparation itself uses) for up to 5
 * deterministic public OCC symbols via this user's OWN connection only, and reports only whether
 * each one's latest available candle is fresh enough right now - never raw candles, prices, or
 * account data, and never more than 5 history requests. */
export async function runLatestCandleFreshnessDiagnosticAction(): Promise<LatestCandleFreshnessDiagnosticActionResult> {
  const user = await requireCurrentUser();
  const resolved = await resolveMarketDataProviderForUser(user.id);
  if (!resolved.provider) {
    return {
      status: "UNAVAILABLE",
      reason: resolved.reason,
      message:
        resolved.reason === "NO_USER_CONNECTION"
          ? "Connect Schwab from Account to run this read-only diagnostic."
          : "Reconnect Schwab from Account to run this read-only diagnostic.",
    };
  }

  const result = await runLatestCandleFreshnessDiagnostic(resolved.provider, new Date(), { universeSource: OCC_OPTIONABLE_UNIVERSE_SOURCE });
  return { status: "OK", requiredMarketDate: result.requiredMarketDate, rows: result.rows };
}

export async function runBrokerRecordClassificationDiagnosticAction(): Promise<BrokerRecordClassificationReport> {
  const user = await requireCurrentUser();
  return getSanitizedBrokerRecordClassificationForUser(user.id);
}

export async function previewSchwabRecordRepairAction(): Promise<SchwabRecordRepairPreview> {
  const user = await requireCurrentUser();
  return previewMalformedSchwabTransactionRepairForUser(user.id);
}

export async function repairSchwabRecordsAction(matchToken: string): Promise<SchwabRecordRepairResult> {
  const user = await requireCurrentUser();
  const result = await repairMalformedSchwabTransactionRecordsForUser(user.id, matchToken);
  revalidatePath("/positions");
  revalidatePath("/dashboard");
  return result;
}

export async function runCampaignEventSequenceDiagnosticAction(): Promise<CampaignEventSequenceReport> {
  const user = await requireCurrentUser();
  return getSanitizedCampaignEventSequenceForUser(user.id);
}

export async function previewCampaignHistoryRepairAction(): Promise<CampaignHistoryRepairPreview> {
  const user = await requireCurrentUser();
  return previewCampaignHistoryRepairForUser(user.id);
}

export async function repairCampaignHistoryAction(matchToken: string): Promise<CampaignHistoryRepairResult> {
  const user = await requireCurrentUser();
  const result = await repairCampaignHistoryForUser(user.id, matchToken);
  revalidatePath("/positions");
  revalidatePath("/dashboard");
  return result;
}

export async function createTradingAccountAction(formData: FormData) {
  const user = await requireCurrentUser();
  const returnTo = actionReturnPath(formData, "/positions");

  try {
    await createTradingAccountForUser(
      user.id,
      formData.get("name"),
      formData.get("accountType"),
      formData.get("startingBalance"),
      formData.get("manualBalance"),
      formData.get("visibility"),
    );
  } catch (error) {
    if (error instanceof ValidationError) {
      redirectWithError(returnTo, error.message);
    }
    throw error;
  }

  revalidatePath("/positions");
  revalidatePath("/dashboard");
}

export async function toggleTradingAccountVisibilityAction(formData: FormData) {
  const user = await requireCurrentUser();
  await toggleTradingAccountVisibilityForUser(user.id, String(formData.get("accountId") ?? ""));

  revalidatePath("/positions");
  revalidatePath("/dashboard");
}

export async function createCampaignAction(formData: FormData) {
  const user = await requireCurrentUser();
  const returnTo = actionReturnPath(formData, "/positions");

  try {
    await createCampaignForUser(
      user.id,
      String(formData.get("accountId") ?? ""),
      formData.get("ticker"),
      formData.get("tradeDate"),
      formData.get("expiration"),
      formData.get("strike"),
      formData.get("contracts"),
      formData.get("premium"),
      formData.get("fees"),
      formData.get("notes"),
      formData.get("visibility"),
    );
  } catch (error) {
    if (error instanceof ValidationError) {
      redirectWithError(returnTo, error.message);
    }
    throw error;
  }

  revalidatePath("/positions");
  revalidatePath("/dashboard");
}

export async function toggleCampaignVisibilityAction(formData: FormData) {
  const user = await requireCurrentUser();
  await toggleCampaignVisibilityForUser(user.id, String(formData.get("campaignId") ?? ""));

  revalidatePath("/positions");
  revalidatePath("/dashboard");
}

export async function closeCampaignPutAction(formData: FormData) {
  const user = await requireCurrentUser();
  const returnTo = actionReturnPath(formData, "/positions");

  try {
    await closeCampaignPutForUser(
      user.id,
      String(formData.get("campaignId") ?? ""),
      formData.get("occurredAt"),
      formData.get("premium"),
      formData.get("fees"),
      formData.get("notes"),
    );
  } catch (error) {
    if (error instanceof ValidationError) {
      redirectWithError(returnTo, error.message);
    }
    throw error;
  }

  revalidatePath("/positions");
  revalidatePath("/dashboard");
}

export async function rollCampaignPutAction(formData: FormData) {
  const user = await requireCurrentUser();
  const returnTo = actionReturnPath(formData, "/positions");

  try {
    await rollCampaignPutForUser(
      user.id,
      String(formData.get("campaignId") ?? ""),
      formData.get("occurredAt"),
      formData.get("closePremium"),
      formData.get("newExpiration"),
      formData.get("newStrike"),
      formData.get("newPremium"),
      formData.get("fees"),
      formData.get("notes"),
    );
  } catch (error) {
    if (error instanceof ValidationError) {
      redirectWithError(returnTo, error.message);
    }
    throw error;
  }

  revalidatePath("/positions");
  revalidatePath("/dashboard");
}

export async function assignCampaignPutAction(formData: FormData) {
  const user = await requireCurrentUser();
  const returnTo = actionReturnPath(formData, "/positions");

  try {
    await assignCampaignPutForUser(
      user.id,
      String(formData.get("campaignId") ?? ""),
      formData.get("occurredAt"),
      formData.get("shares"),
      formData.get("fees"),
      formData.get("notes"),
    );
  } catch (error) {
    if (error instanceof ValidationError) {
      redirectWithError(returnTo, error.message);
    }
    throw error;
  }

  revalidatePath("/positions");
  revalidatePath("/dashboard");
}

export async function changePasswordAction(formData: FormData) {
  const user = await requireCurrentUser();

  try {
    const currentSessionTokenHash = await getCurrentSessionTokenHash();
    await changePasswordForUser(
      user.id,
      String(formData.get("currentPassword") ?? ""),
      String(formData.get("newPassword") ?? ""),
      String(formData.get("confirmPassword") ?? ""),
      currentSessionTokenHash,
    );
  } catch (error) {
    if (error instanceof ValidationError) {
      redirectWithError("/account", error.message);
    }
    throw error;
  }

  redirect("/account?saved=1");
}

export async function disconnectSchwabAction() {
  const user = await requireCurrentUser();
  await disconnectSchwabForUser(user.id);

  revalidatePath("/account");
  revalidatePath("/scanner");
  revalidatePath("/dashboard");
  redirect("/account?schwab=disconnected");
}

export async function saveSchwabDeveloperCredentialsAction(formData: FormData) {
  const user = await requireCurrentUser();

  try {
    await saveSchwabDeveloperCredentialsForUser(
      user.id,
      formData.get("clientId"),
      formData.get("clientSecret"),
      formData.get("redirectUri"),
    );
  } catch (error) {
    if (error instanceof ValidationError) {
      redirectWithError("/account", error.message);
    }
    throw error;
  }

  revalidatePath("/account");
  revalidatePath("/scanner");
  revalidatePath("/dashboard");
  redirect("/account?schwab=developer_configured");
}

export async function removeSchwabDeveloperCredentialsAction() {
  const user = await requireCurrentUser();
  await removeSchwabDeveloperCredentialsForUser(user.id);

  revalidatePath("/account");
  revalidatePath("/scanner");
  revalidatePath("/dashboard");
  redirect("/account?schwab=developer_removed");
}

export async function syncSchwabAccountAction() {
  const user = await requireCurrentUser();

  let result: Awaited<ReturnType<typeof syncSchwabAccountForUser>>;
  try {
    result = await syncSchwabAccountForUser(user.id);
  } catch (error) {
    if (error instanceof ValidationError) {
      redirectWithError("/account", error.message);
    }
    throw error;
  }

  const campaignTotals = { campaignsCreated: 0, campaignsClosed: 0, campaignsRolled: 0, campaignsAssigned: 0, campaignsExpired: 0 };
  let reconciliationStatus: "OK" | "ERROR" = "OK";
  let reconciliationErrorCode: string | null = null;
  for (const account of result.accounts) {
    try {
      const summary = await reconcileSchwabActivityForUser(user.id, account.id, account.freshPositions);
      campaignTotals.campaignsCreated += summary.campaignsOpened;
      campaignTotals.campaignsClosed += summary.campaignsClosed;
      campaignTotals.campaignsRolled += summary.campaignsRolled;
      campaignTotals.campaignsAssigned += summary.campaignsAssigned;
      campaignTotals.campaignsExpired += summary.campaignsExpired;
    } catch (error) {
      // Balance sync above already succeeded and is durable - a reconciliation hiccup for one
      // account just means it catches up on the next successful sync, not a failed sync.
      // Recorded (not silent) so a real reconciliation failure is distinguishable from an
      // honest "no campaign activity this sync."
      reconciliationStatus = "ERROR";
      reconciliationErrorCode = categorizeSchwabSyncError(error);
      logSchwabSyncFailure("schwab_sync_reconciliation", user.id, error);
    }
  }

  // Aggregate counts only (see SchwabSyncDiagnostics) - never raw account/position/transaction
  // data - persisted so the first real production sync can be inspected from /account.
  await recordSchwabSyncDiagnostics(user.id, {
    accountsSynced: result.syncedAccounts,
    ...result.diagnostics,
    ...campaignTotals,
    reconciliationStatus,
    reconciliationErrorCode,
  });

  const campaignsUpdated =
    campaignTotals.campaignsCreated +
    campaignTotals.campaignsClosed +
    campaignTotals.campaignsRolled +
    campaignTotals.campaignsAssigned +
    campaignTotals.campaignsExpired;

  revalidatePath("/account");
  revalidatePath("/dashboard");
  revalidatePath("/positions");
  redirect(`/account?schwab=synced&campaignsUpdated=${campaignsUpdated}`);
}

export async function previewSchwabImportAction(formData: FormData) {
  const user = await requireCurrentUser();

  const file = formData.get("file");
  if (!(file instanceof File)) {
    redirectWithError("/positions?view=accounts", "Choose a Schwab CSV export file to import.");
  }
  const accountId = String(formData.get("accountId") ?? "").trim() || null;

  let batchId: string;
  try {
    const preview = await previewBrokerImportForUser(user.id, file, accountId);
    batchId = preview.batchId;
  } catch (error) {
    if (error instanceof ValidationError) {
      redirectWithError("/positions?view=accounts", error.message);
    }
    throw error;
  }

  redirect(`/positions?view=accounts&previewBatch=${batchId}`);
}

export async function confirmSchwabImportAction(formData: FormData) {
  const user = await requireCurrentUser();
  const batchId = String(formData.get("batchId") ?? "");

  let summary: Awaited<ReturnType<typeof confirmBrokerImportForUser>>;
  try {
    summary = await confirmBrokerImportForUser(user.id, batchId);
  } catch (error) {
    if (error instanceof ValidationError) {
      redirectWithError("/positions?view=accounts", error.message);
    }
    throw error;
  }

  revalidatePath("/positions");
  revalidatePath("/dashboard");
  redirect(
    `/positions?view=accounts&imported=1&newCount=${summary.newCount}&duplicateCount=${summary.duplicateCount}&reviewCount=${summary.reviewCount}`,
  );
}

export async function discardSchwabImportAction(formData: FormData) {
  const user = await requireCurrentUser();
  const batchId = String(formData.get("batchId") ?? "");

  try {
    await discardBrokerImportForUser(user.id, batchId);
  } catch (error) {
    if (error instanceof ValidationError) {
      redirectWithError("/positions?view=accounts", error.message);
    }
    throw error;
  }

  revalidatePath("/positions");
  redirect("/positions?view=accounts&discarded=1");
}

export async function confirmBrokerReconciliationAction(formData: FormData) {
  const user = await requireCurrentUser();

  try {
    await confirmBrokerPositionAsCampaignForUser(
      user.id,
      String(formData.get("brokerRecordId") ?? ""),
      String(formData.get("accountId") ?? ""),
      formData.get("ticker"),
      formData.get("tradeDate"),
      formData.get("expiration"),
      formData.get("strike"),
      formData.get("contracts"),
      formData.get("premium"),
      formData.get("fees"),
      formData.get("notes"),
      formData.get("visibility"),
    );
  } catch (error) {
    if (error instanceof ValidationError) {
      redirectWithError("/positions?view=accounts", error.message);
    }
    throw error;
  }

  revalidatePath("/positions");
  revalidatePath("/dashboard");
  redirect("/positions?view=accounts&linked=1");
}

export async function skipBrokerReconciliationAction(formData: FormData) {
  const user = await requireCurrentUser();

  try {
    await skipBrokerReconciliationForUser(user.id, String(formData.get("brokerRecordId") ?? ""));
  } catch (error) {
    if (error instanceof ValidationError) {
      redirectWithError("/positions?view=accounts", error.message);
    }
    throw error;
  }

  revalidatePath("/positions");
  redirect("/positions?view=accounts&skipped=1");
}

export async function addAccountLedgerEntryAction(formData: FormData) {
  const user = await requireCurrentUser();
  const returnTo = actionReturnPath(formData, "/positions");

  try {
    await addAccountLedgerEntryForUser(
      user.id,
      String(formData.get("accountId") ?? ""),
      formData.get("type"),
      formData.get("occurredAt"),
      formData.get("amount"),
      formData.get("notes"),
    );
  } catch (error) {
    if (error instanceof ValidationError) {
      redirectWithError(returnTo, error.message);
    }
    throw error;
  }

  revalidatePath("/positions");
  revalidatePath("/dashboard");
}

export type RunAlphaVantageDiagnosticResult = { ok: true; result: AlphaVantageDiagnosticResult } | { ok: false; error: string };

/**
 * Manual, click-to-run only - never called from a page load or Link prefetch. Alpha Vantage's
 * free tier is 25 requests/day total, so this must never fire automatically (see
 * src/lib/alpha-vantage-diagnostic.ts and PROJECT_HANDOFF.md's Alpha Vantage section).
 */
export async function runAlphaVantageOverviewDiagnosticAction(): Promise<RunAlphaVantageDiagnosticResult> {
  await requireCurrentUser();

  try {
    const result = await runAlphaVantageOverviewDiagnostic();
    return { ok: true, result };
  } catch {
    return { ok: false, error: "Alpha Vantage diagnostic failed unexpectedly." };
  }
}

/**
 * Temporary follow-up for the 2026-09-03 production verification: APLD already has a real
 * SUCCESS result, so this only re-checks RIOT and CORZ (max 2 calls, never re-calls APLD).
 */
export async function runAlphaVantageRemainingTickersDiagnosticAction(): Promise<RunAlphaVantageDiagnosticResult> {
  await requireCurrentUser();

  try {
    const result = await runAlphaVantageRemainingTickersDiagnostic();
    return { ok: true, result };
  } catch {
    return { ok: false, error: "Alpha Vantage diagnostic failed unexpectedly." };
  }
}

export type ProcessAlphaVantageQueueResult = { ok: true; summary: ProcessQueueSummary } | { ok: false; error: string };

/**
 * Manual, click-to-run "Process fundamentals queue" - the only trigger for automatic (AUTO
 * budget) fundamentals fetching in this slice. Never called from Scanner or Research render
 * paths or from Run Live Scan - see PROJECT_HANDOFF.md Alpha Vantage API section for why
 * (no confirmed Hostinger persistent-worker/cron support yet).
 */
export async function processAlphaVantageFundamentalsQueueAction(): Promise<ProcessAlphaVantageQueueResult> {
  await requireCurrentUser();

  try {
    const summary = await processAlphaVantageFundamentalsQueue();
    revalidatePath("/account");
    return { ok: true, summary };
  } catch {
    return { ok: false, error: "Processing the fundamentals queue failed unexpectedly." };
  }
}

export type RefreshTickerFundamentalsResult = { ok: true; result: ManualRefreshResult } | { ok: false; error: string };

/** Manual single-ticker refresh, drawing from the 3-call manual reserve once the auto cap is hit. */
export async function refreshTickerFundamentalsAction(ticker: string, force: boolean): Promise<RefreshTickerFundamentalsResult> {
  await requireCurrentUser();

  try {
    const normalized = requireTicker(ticker);
    const result = await refreshSingleTickerFundamentals(normalized, { force });
    revalidatePath("/research");
    revalidatePath("/account");
    return { ok: true, result };
  } catch (error) {
    if (error instanceof ValidationError) {
      return { ok: false, error: error.message };
    }
    throw error;
  }
}
