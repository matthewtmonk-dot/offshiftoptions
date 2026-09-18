import { hash } from "bcryptjs";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const runDatabaseTests = process.env.RUN_DB_TESTS === "1" && Boolean(process.env.DATABASE_URL);
const maybeDescribe = runDatabaseTests ? describe : describe.skip;

/**
 * Coverage for the Notifications/Chat consolidation (see PROJECT_HANDOFF.md): Chat is now the
 * primary human-to-human surface, so MESSAGE and RECOMMENDATION notifications are hidden from the
 * bell (Chat's own unread badge/read-state, and a new structured Chat echo, already cover them),
 * while COMMENT/REACTION keep their existing bell visibility since nothing else surfaces them.
 * Uses fresh throwaway users with their own conversation - never the shared Matt/Eric dev
 * conversation other integration tests already use - so this file's assertions can be exact
 * (e.g. "exactly 1 unread") without any pre-existing residue from other test runs.
 */
maybeDescribe("Notifications/Chat consolidation", () => {
  let prisma: typeof import("./prisma").prisma;
  let notifyInApp: typeof import("./notifications").notifyInApp;
  let getUnreadNotificationCount: typeof import("./app-data").getUnreadNotificationCount;
  let getNotificationsPageData: typeof import("./app-data").getNotificationsPageData;
  let getUnreadChatCount: typeof import("./app-data").getUnreadChatCount;
  let getDashboardData: typeof import("./app-data").getDashboardData;
  let markAllNotificationsReadForUser: typeof import("./workflows").markAllNotificationsReadForUser;
  let markConversationReadForUser: typeof import("./workflows").markConversationReadForUser;
  let createRecommendationForUser: typeof import("./workflows").createRecommendationForUser;

  let sender: { id: string };
  let recipient: { id: string };
  let outsider: { id: string };
  let conversation: { id: string };
  const userIds: string[] = [];

  beforeAll(async () => {
    prisma = (await import("./prisma")).prisma;
    ({ notifyInApp } = await import("./notifications"));
    ({ getUnreadNotificationCount, getNotificationsPageData, getUnreadChatCount, getDashboardData } = await import("./app-data"));
    ({ markAllNotificationsReadForUser, markConversationReadForUser, createRecommendationForUser } = await import("./workflows"));

    const passwordHash = await hash("not-used", 4);
    const timestamp = Date.now();
    sender = await prisma.user.create({ data: { name: "Cleanup Sender", email: `cleanup-sender-${timestamp}@lst.local`, passwordHash } });
    recipient = await prisma.user.create({ data: { name: "Cleanup Recipient", email: `cleanup-recipient-${timestamp}@lst.local`, passwordHash } });
    outsider = await prisma.user.create({ data: { name: "Cleanup Outsider", email: `cleanup-outsider-${timestamp}@lst.local`, passwordHash } });
    userIds.push(sender.id, recipient.id, outsider.id);

    conversation = await prisma.conversation.create({
      data: {
        title: "Cleanup Test Conversation",
        members: { create: [{ userId: sender.id }, { userId: recipient.id }] },
      },
    });
  });

  afterAll(async () => {
    await prisma.chatMessageRead.deleteMany({ where: { message: { conversationId: conversation.id } } });
    await prisma.chatMessage.deleteMany({ where: { conversationId: conversation.id } });
    await prisma.conversationMember.deleteMany({ where: { conversationId: conversation.id } });
    await prisma.conversation.delete({ where: { id: conversation.id } });
    await prisma.notification.deleteMany({ where: { recipientId: { in: userIds } } });
    await prisma.recommendation.deleteMany({ where: { recipientId: { in: userIds } } });
    await prisma.activity.deleteMany({ where: { actorId: { in: userIds } } });
    await prisma.user.deleteMany({ where: { id: { in: userIds } } });
    await prisma.$disconnect();
  });

  it("test 4: a MESSAGE notification is never surfaced or counted on the Notifications page", async () => {
    await notifyInApp({ recipientId: recipient.id, actorId: sender.id, type: "MESSAGE", title: "Sender sent you a message", body: "hi", href: "/chat" });

    expect(await getUnreadNotificationCount(recipient.id)).toBe(0);
    const page = await getNotificationsPageData(recipient.id);
    expect(page.some((notification) => notification.type === "MESSAGE")).toBe(false);
  });

  it("a COMMENT notification (no other surface exists for it) stays fully visible", async () => {
    await notifyInApp({ recipientId: recipient.id, actorId: sender.id, type: "COMMENT", title: "Sender commented", body: "nice setup", href: "/research" });

    expect(await getUnreadNotificationCount(recipient.id)).toBeGreaterThanOrEqual(1);
    const page = await getNotificationsPageData(recipient.id);
    expect(page.some((notification) => notification.type === "COMMENT")).toBe(true);
  });

  it("test 4 (bulk action): Mark all read only clears visible types, never the hidden MESSAGE notification", async () => {
    const messageNotification = await prisma.notification.findFirst({
      where: { recipientId: recipient.id, type: "MESSAGE" },
      orderBy: { createdAt: "desc" },
    });
    expect(messageNotification?.readAt).toBeNull(); // still unread going in

    await markAllNotificationsReadForUser(recipient.id);

    const stillUnreadMessage = await prisma.notification.findUnique({ where: { id: messageNotification!.id } });
    expect(stillUnreadMessage?.readAt).toBeNull(); // untouched by the bulk "visible types only" action

    const commentNotification = await prisma.notification.findFirst({ where: { recipientId: recipient.id, type: "COMMENT" } });
    expect(commentNotification?.readAt).not.toBeNull(); // the visible type WAS cleared
  });

  it("test 1/2/3: sending a chat message produces an unread count for the recipient only, cleared by marking the conversation read, isolated from an outsider", async () => {
    const message = await prisma.chatMessage.create({
      data: { conversationId: conversation.id, senderId: sender.id, body: "Unread badge test", reads: { create: { userId: sender.id } } },
    });

    expect(await getUnreadChatCount(recipient.id)).toBe(1); // test 1
    expect(await getUnreadChatCount(sender.id)).toBe(0); // sender's own message is never unread to them
    expect(await getUnreadChatCount(outsider.id)).toBe(0); // test 3: a non-member never sees another pair's unread count

    await markConversationReadForUser(recipient.id, conversation.id);

    expect(await getUnreadChatCount(recipient.id)).toBe(0); // test 2

    await prisma.chatMessageRead.deleteMany({ where: { messageId: message.id } });
    await prisma.chatMessage.delete({ where: { id: message.id } });
  });

  it("cross-user isolation: an outsider cannot mark another pair's conversation read", async () => {
    await expect(markConversationReadForUser(outsider.id, conversation.id)).rejects.toThrow();
  });

  it("recommendation flow: a recommendation from sender to recipient posts a structured Chat message with the ticker preserved", async () => {
    const recommendation = await createRecommendationForUser(sender.id, "KGC", recipient.id, "Worth a look at these levels.", ["Worth researching"]);

    const chatPage = await import("./app-data").then((mod) => mod.getChatPageData(recipient.id));
    const echo = chatPage?.messages.find((candidate) => candidate.ticker === "KGC");
    expect(echo).toBeDefined();
    expect(echo?.senderId).toBe(sender.id);
    expect(echo?.body).toContain("KGC");
    expect(echo?.body).toContain("Worth a look at these levels.");
    expect(echo?.body).toContain("Worth researching");

    // The structured Recommendation record itself is untouched/preserved - this is an echo, not a replacement.
    expect(recommendation.ticker).toBe("KGC");
    expect(recommendation.recipientId).toBe(recipient.id);

    // And the RECOMMENDATION notification, like MESSAGE, is hidden from the bell now that Chat carries it.
    expect(await getNotificationsPageData(recipient.id).then((page) => page.some((n) => n.type === "RECOMMENDATION"))).toBe(false);
  });

  it("recommendation echo never reaches an unrelated user outside the sender/recipient conversation", async () => {
    const outsiderChat = await import("./app-data").then((mod) => mod.getChatPageData(outsider.id));
    expect(outsiderChat).toBeNull(); // the outsider has no conversation at all in this fixture
  });

  it("Dashboard Buddy Chat preview is newest-first and bounded to the 5 most recent messages", async () => {
    const bodies = ["one", "two", "three", "four", "five", "six", "seven"];
    for (const body of bodies) {
      await prisma.chatMessage.create({ data: { conversationId: conversation.id, senderId: sender.id, body, reads: { create: { userId: sender.id } } } });
      await new Promise((resolve) => setTimeout(resolve, 5)); // distinct createdAt ordering
    }

    const data = await getDashboardData(recipient.id);
    expect(data.recentMessages).toHaveLength(5);
    expect(data.recentMessages[0].body).toBe("seven"); // newest first
    expect(data.recentMessages[4].body).toBe("three");

    await prisma.chatMessage.deleteMany({ where: { conversationId: conversation.id, body: { in: bodies } } });
  });
});
