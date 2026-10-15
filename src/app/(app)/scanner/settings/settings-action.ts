import { describeActionFailure, shortErrorDetail, STALE_PAGE_MESSAGE } from "@/lib/action-failure-message";
import type { SettingsActionResult } from "@/lib/safe-action-error";

/**
 * What the Scanner Rules page shows after pressing Save / Reset. Pure and server-import-free so the
 * outcome mapping is unit-tested: whatever the server action does - succeed, refuse with a message, or
 * even THROW (a page opened before an update, a dropped connection) - the user gets a sentence on the
 * page, never a crash screen.
 */
export type SettingsStatus =
  | { kind: "idle" }
  | { kind: "pending" }
  | { kind: "success"; message: string }
  | { kind: "error"; message: string };

export async function submitSettingsAction(
  action: (formData: FormData) => Promise<SettingsActionResult>,
  formData: FormData,
): Promise<Exclude<SettingsStatus, { kind: "idle" | "pending" }>> {
  try {
    const result = await action(formData);
    return result.ok ? { kind: "success", message: result.message } : { kind: "error", message: result.error };
  } catch (error) {
    const message = describeActionFailure(error, "Couldn't reach the server to save. Check your connection, reload the page, and try again.");
    // Add what the browser actually saw (never for the stale-page case, which already says exactly what to do).
    return { kind: "error", message: message === STALE_PAGE_MESSAGE ? message : `${message} (browser detail: ${shortErrorDetail(error)})` };
  }
}
