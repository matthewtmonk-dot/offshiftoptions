"use server";

import type { ReactionTargetType } from "@/generated/prisma/enums";
import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { getCurrentSessionTokenHash, requireCurrentUser, signOut } from "@/lib/auth";
import { changePasswordForUser } from "@/lib/account";
import {
  addReactionForUser,
  addRecommendationCommentForUser,
  addWatchlistCommentForUser,
  createRecommendationForUser,
  createWatchlistItemForUser,
  markAllNotificationsReadForUser,
  markConversationReadForUser,
  markNotificationReadForUser,
  removeWatchlistItemForUser,
  safeReturnPath,
  saveStockNoteForUser,
  sendChatMessageForUser,
  toggleWatchlistItemVisibilityForUser,
  updateRecommendationStatusForUser,
  updateScannerSettingsForUser,
} from "@/lib/workflows";
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

export async function addWatchlistItemAction(formData: FormData) {
  const user = await requireCurrentUser();
  const returnTo = actionReturnPath(formData, "/watchlist");

  try {
    await createWatchlistItemForUser(user.id, formData.get("ticker"));
  } catch (error) {
    if (error instanceof ValidationError) {
      redirectWithError(returnTo, error.message);
    }
    throw error;
  }

  revalidatePath("/watchlist");
  revalidatePath("/dashboard");
}

export async function removeWatchlistItemAction(formData: FormData) {
  const user = await requireCurrentUser();
  await removeWatchlistItemForUser(user.id, String(formData.get("itemId") ?? ""));

  revalidatePath("/watchlist");
  revalidatePath("/dashboard");
}

export async function toggleWatchlistItemVisibilityAction(formData: FormData) {
  const user = await requireCurrentUser();
  await toggleWatchlistItemVisibilityForUser(user.id, String(formData.get("itemId") ?? ""));

  revalidatePath("/watchlist");
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

  revalidatePath("/watchlist");
  revalidatePath("/dashboard");
}

export async function addWatchlistCommentAction(formData: FormData) {
  const user = await requireCurrentUser();
  await addWatchlistCommentForUser(user.id, String(formData.get("itemId") ?? ""), formData.get("body"));

  revalidatePath("/watchlist");
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
  revalidatePath("/watchlist");
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
  revalidatePath("/watchlist");
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
