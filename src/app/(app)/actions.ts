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
  updateScannerSettingsForUser,
} from "@/lib/workflows";
import type { AppearanceMode } from "@/generated/prisma/enums";
import { updateAppearanceForUser } from "@/lib/appearance";
import { disconnectSchwabForUser } from "@/lib/broker-connections";
import { confirmBrokerImportForUser, discardBrokerImportForUser, previewBrokerImportForUser } from "@/lib/broker-import";
import {
  confirmBrokerPositionAsCampaignForUser,
  skipBrokerReconciliationForUser,
} from "@/lib/broker-reconciliation";
import { ValidationError } from "@/lib/tickers";

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

export async function sendChatMessageAction(formData: FormData) {
  const user = await requireCurrentUser();
  const returnTo = actionReturnPath(formData, "/chat");

  try {
    await sendChatMessageForUser(
      user.id,
      String(formData.get("conversationId") ?? ""),
      formData.get("body"),
      formData.get("ticker"),
    );
  } catch (error) {
    if (error instanceof ValidationError) {
      redirectWithError(returnTo, error.message);
    }
    throw error;
  }

  revalidatePath("/chat");
  revalidatePath("/dashboard");
  revalidatePath("/notifications");
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
  | { ok: true; scanned: number; nearMatches: number; elapsedMs: number }
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

  try {
    await syncSchwabAccountForUser(user.id);
  } catch (error) {
    if (error instanceof ValidationError) {
      redirectWithError("/account", error.message);
    }
    throw error;
  }

  revalidatePath("/account");
  revalidatePath("/dashboard");
  revalidatePath("/positions");
  redirect("/account?schwab=synced");
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

  try {
    await confirmBrokerImportForUser(user.id, batchId);
  } catch (error) {
    if (error instanceof ValidationError) {
      redirectWithError("/positions?view=accounts", error.message);
    }
    throw error;
  }

  revalidatePath("/positions");
  revalidatePath("/dashboard");
  redirect("/positions?view=accounts&imported=1");
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
