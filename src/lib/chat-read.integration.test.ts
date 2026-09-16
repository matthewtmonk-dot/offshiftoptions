import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";

const databaseTests = process.env.RUN_DB_TESTS === "1" && Boolean(process.env.DATABASE_URL);

(databaseTests ? describe : describe.skip)("chat read and notification consistency", () => {
  let prisma: typeof import("./prisma").prisma;
  let workflows: typeof import("./workflows");
  let getUnreadChatCount: typeof import("./app-data").getUnreadChatCount;
  const userIds: string[] = [];
  const conversationIds: string[] = [];
  let conversationId: string;
  let messageId: string;

  beforeAll(async () => {
    prisma = (await import("./prisma")).prisma;
    workflows = await import("./workflows");
    ({ getUnreadChatCount } = await import("./app-data"));
    for (let i = 0; i < 3; i++) {
      const user = await prisma.user.create({ data: { name: "Chat read fixture", email: `chat-read-${Date.now()}-${i}@test.invalid`, passwordHash: "unused-test-hash" } });
      userIds.push(user.id);
    }
  });

  beforeEach(async () => {
    const conversation = await prisma.conversation.create({ data: {
      type: "PRIVATE", title: "Read fixture", members: { create: userIds.slice(0, 2).map((userId) => ({ userId })) },
    } });
    conversationId = conversation.id;
    conversationIds.push(conversation.id);
    const message = await prisma.chatMessage.create({ data: { conversationId, senderId: userIds[0], body: "Read fixture message" } });
    messageId = message.id;
  });

  afterEach(async () => {
    await prisma.notification.deleteMany({ where: { recipientId: { in: userIds } } });
    await prisma.conversation.deleteMany({ where: { id: { in: conversationIds } } });
  });
  afterAll(async () => {
    await prisma.user.deleteMany({ where: { id: { in: userIds } } });
    await prisma.$disconnect();
  });

  async function notification(type: "MESSAGE" | "COMMENT" = "MESSAGE", recipientId = userIds[1], href = `/chat#message-${messageId}`, createdAt = new Date()) {
    return prisma.notification.create({ data: { recipientId, actorId: userIds[0], type, href, title: "Fixture", body: "Fixture", createdAt } });
  }

  it("clears the matching message notice and badge count, preserves other users and comments, and is idempotent", async () => {
    const notice = await notification();
    const comment = await notification("COMMENT");
    const otherUser = await notification("MESSAGE", userIds[2]);
    expect(await getUnreadChatCount(userIds[1])).toBe(1);
    expect(await getUnreadChatCount(userIds[2])).toBe(0);
    await workflows.markConversationReadForUser(userIds[1], conversationId);
    await workflows.markConversationReadForUser(userIds[1], conversationId);
    expect(await getUnreadChatCount(userIds[1])).toBe(0);
    expect(await prisma.chatMessageRead.count({ where: { messageId, userId: userIds[1] } })).toBe(1);
    expect((await prisma.notification.findUniqueOrThrow({ where: { id: notice.id } })).readAt).not.toBeNull();
    expect(await prisma.notification.count({ where: { id: { in: [comment.id, otherUser.id] }, readAt: null } })).toBe(2);
  });

  it("rejects a nonmember before mutating message reads or notifications", async () => {
    const notice = await notification("MESSAGE", userIds[2]);
    await expect(workflows.markConversationReadForUser(userIds[2], conversationId)).rejects.toThrow("not a member");
    expect(await prisma.chatMessageRead.count({ where: { userId: userIds[2] } })).toBe(0);
    expect((await prisma.notification.findUniqueOrThrow({ where: { id: notice.id } })).readAt).toBeNull();
  });

  it("clears legacy chat notifications for the existing single-conversation user", async () => {
    const notice = await notification("MESSAGE", userIds[1], "/chat");
    await workflows.markConversationReadForUser(userIds[1], conversationId);
    expect((await prisma.notification.findUniqueOrThrow({ where: { id: notice.id } })).readAt).not.toBeNull();
  });

  it("leaves ambiguous legacy notices and another conversation's messages unread", async () => {
    const other = await prisma.conversation.create({ data: { type: "PRIVATE", title: "Other read fixture", members: { create: userIds.slice(0, 2).map((userId) => ({ userId })) } } });
    conversationIds.push(other.id);
    const otherMessage = await prisma.chatMessage.create({ data: { conversationId: other.id, senderId: userIds[0], body: "Other conversation" } });
    const legacy = await notification("MESSAGE", userIds[1], "/chat");
    const otherNotice = await notification("MESSAGE", userIds[1], `/chat#message-${otherMessage.id}`);
    await workflows.markConversationReadForUser(userIds[1], conversationId);
    expect(await getUnreadChatCount(userIds[1])).toBe(1);
    expect(await prisma.notification.count({ where: { id: { in: [legacy.id, otherNotice.id] }, readAt: null } })).toBe(2);
  });

  it("does not consume messages or notices newer than the read operation", async () => {
    const later = new Date(Date.now() + 60_000);
    const future = await prisma.chatMessage.create({ data: { conversationId, senderId: userIds[0], body: "Later", createdAt: later } });
    const notice = await notification("MESSAGE", userIds[1], `/chat#message-${future.id}`, later);
    await workflows.markConversationReadForUser(userIds[1], conversationId);
    expect(await prisma.chatMessageRead.count({ where: { messageId: future.id, userId: userIds[1] } })).toBe(0);
    expect((await prisma.notification.findUniqueOrThrow({ where: { id: notice.id } })).readAt).toBeNull();
  });

  it("newly sent messages create exact message notification links", async () => {
    const message = await workflows.sendChatMessageForUser(userIds[0], conversationId, "New fixture message", "");
    if (!message) throw new Error("Expected a created message");
    expect(await prisma.notification.count({ where: { recipientId: userIds[1], href: `/chat#message-${message.id}`, type: "MESSAGE" } })).toBe(1);
  });
});
