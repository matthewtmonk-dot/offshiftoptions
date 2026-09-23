import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { navItems } from "./app-sidebar";

// Navigation/Communication Cleanup ticket: Recs and Notifications are trimmed from primary
// navigation, but their underlying functionality (sending a recommendation, reading/marking
// notifications) must remain fully reachable and unchanged - Recommendations moves into a compact
// panel inside Chat (reusing the existing recommendStockAction workflow unchanged), and
// Notifications moves into a bell control reachable from the global shell instead of a nav slot.
// Neither /recommendations nor /notifications is deleted. There is no component-render harness in
// this repo, so most of this asserts against page/component source directly - the same precedent
// already established throughout this engagement (retired-one-percent-displays.test.ts,
// reporting-display.test.ts, tracker-reporting-cleanup.test.ts, account-evidence-display.test.ts,
// scanner-score-presentation.test.ts).

function source(path: string) {
  return readFileSync(new URL(path, import.meta.url), "utf8");
}

describe("Primary navigation: Recs and Notifications trimmed", () => {
  it("1 & 2. primary nav no longer contains Recs or Notifications", () => {
    const hrefs = navItems.map((item) => item.href);
    const labels = navItems.map((item) => item.label);
    expect(hrefs).not.toContain("/recommendations");
    expect(hrefs).not.toContain("/notifications");
    expect(labels).not.toContain("Recs");
    expect(labels).not.toContain("Notifications");
  });

  it("3. primary nav contains exactly Dashboard/Tracker/Scanner/Research/Chat/Account", () => {
    expect(navItems.map((item) => item.href)).toEqual(["/dashboard", "/positions", "/scanner", "/research", "/chat", "/account"]);
    expect(navItems.map((item) => item.label)).toEqual(["Dashboard", "Tracker", "Scanner", "Research", "Chat", "Account"]);
  });

  it("4. desktop and mobile navs are driven by this same six-item list, not a second maintained list", () => {
    const text = source("./app-sidebar.tsx");
    // Exactly two render sites map over `navItems` (desktop <nav> and mobile <nav>) - proving
    // there is one source of truth, not a duplicated/independent mobile item list.
    expect((text.match(/navItems\.map\(/g) ?? []).length).toBe(2);
  });

  it("4. mobile nav grid was simplified for six items instead of the old eight-item 4x2 grid", () => {
    const text = source("./app-sidebar.tsx");
    expect(text).toContain("grid grid-cols-3 gap-2");
    expect(text).not.toContain("grid-cols-4 gap-2");
  });

  it("10 & 11. a notification bell remains reachable outside primary nav, still showing the unread count", () => {
    const text = source("./app-sidebar.tsx");
    expect(text).toContain("function NotificationBellLink");
    expect(text).toContain('href="/notifications"');
    expect(text).toMatch(/unread > 0/);
    // Used in both the desktop user-area footer and the mobile header.
    expect((text.match(/<NotificationBellLink /g) ?? []).length).toBe(2);
  });
});

describe("Recommendations moved into Chat", () => {
  it("5. the recommend workflow is reachable from the Chat page", () => {
    const chatText = source("./chat/page.tsx");
    expect(chatText).toContain("ChatRecommendPanel");
    expect(chatText).toContain("getChatBuddies");
  });

  it("6. recommendation submission still uses the existing recommendStockAction/form fields, not a new workflow", () => {
    const panelText = source("./chat/chat-recommend-panel.tsx");
    expect(panelText).toContain('action={recommendStockAction}');
    expect(panelText).toContain('name="ticker"');
    expect(panelText).toContain('name="recipientId"');
    expect(panelText).toContain('name="message"');
    expect(panelText).toContain('name="reasonTags"');
    expect(panelText).toContain("RECOMMENDATION_REASON_TAGS");
  });

  it("does not duplicate the fuller incoming/outgoing/status/comment workflow inside Chat - links to it instead", () => {
    const panelText = source("./chat/chat-recommend-panel.tsx");
    expect(panelText).not.toContain("updateRecommendationStatusAction");
    expect(panelText).not.toContain("addRecommendationCommentAction");
    expect(panelText).toContain('href="/recommendations"');
  });

  it("7. the recommendation Chat-echo domain workflow itself is untouched by this navigation ticket", () => {
    const workflowsText = source("../../lib/workflows.ts");
    expect(workflowsText).toContain("function createRecommendationForUser");
    expect(workflowsText).toContain("postRecommendationChatEcho");
    expect(workflowsText).toContain("function postRecommendationChatEcho");
  });

  it("8. the existing /recommendations route is preserved, not deleted - full history remains available there", () => {
    const recsText = source("./recommendations/page.tsx");
    expect(recsText).toContain("export default async function RecommendationsPage");
    expect(recsText).toContain("getRecommendationsPageData");
    expect(recsText).toContain("recommendStockAction");
  });

  it("9. Dashboard's recommendation card links to Chat instead of the trimmed primary destination", () => {
    const dashboardText = source("./dashboard/page.tsx");
    const panelStart = dashboardText.indexOf('title="Recommendations"');
    const panelSlice = dashboardText.slice(panelStart, panelStart + 300);
    expect(panelSlice).toContain('href="/chat"');
    expect(panelSlice).not.toContain('href="/recommendations"');
  });

  it("16. the new Chat buddy list is scoped per-viewer, matching the existing Recommendations buddy-selector pattern", () => {
    const appDataText = source("../../lib/app-data.ts");
    expect(appDataText).toContain("export async function getChatBuddies(userId: string)");
    expect(appDataText).toMatch(/getChatBuddies[\s\S]{0,120}id: \{ not: userId \}/);
  });
});

describe("Notifications remain fully functional outside primary nav", () => {
  it("12 & 13. the /notifications route, its mark-read/mark-all-read actions, and its data source are all preserved", () => {
    const notificationsText = source("./notifications/page.tsx");
    expect(notificationsText).toContain("export default async function NotificationsPage");
    expect(notificationsText).toContain("markAllNotificationsReadAction");
    expect(notificationsText).toContain("markNotificationReadAction");
    expect(notificationsText).toContain("getNotificationsPageData");
  });

  it("14. historical Notification.href targets and the return-path allowlist both still include the trimmed routes", () => {
    const workflowsText = source("../../lib/workflows.ts");
    expect(workflowsText).toContain('"/recommendations"');
    expect(workflowsText).toContain('"/notifications"');
    expect(workflowsText).toMatch(/RETURNABLE_PATHS[\s\S]{0,300}"\/recommendations"/);
    expect(workflowsText).toMatch(/RETURNABLE_PATHS[\s\S]{0,300}"\/notifications"/);
  });

  it("this ticket did not touch notification-domain semantics (visible-types allowlist, unread-count query)", () => {
    const notificationsLib = source("../../lib/notifications.ts");
    expect(notificationsLib).toContain("NOTIFICATIONS_PAGE_VISIBLE_TYPES");
  });
});
