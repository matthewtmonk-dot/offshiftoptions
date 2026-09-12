import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { hash } from "bcryptjs";

const runDatabaseTests = process.env.RUN_DB_TESTS === "1" && Boolean(process.env.DATABASE_URL);
const maybeDescribe = runDatabaseTests ? describe : describe.skip;

maybeDescribe("Buddy Chat image attachments", () => {
  let prisma: typeof import("./prisma").prisma;
  let workflows: typeof import("./workflows");
  let chatAttachments: typeof import("./chat-attachments");
  let matt: { id: string };
  let eric: { id: string };
  let fakeStorage: ReturnType<typeof createFakeStorage>;
  const createdMessageIds: string[] = [];
  const createdConversationIds: string[] = [];
  const createdUserIds: string[] = [];

  beforeAll(async () => {
    prisma = (await import("./prisma")).prisma;
    workflows = await import("./workflows");
    chatAttachments = await import("./chat-attachments");
    matt = await prisma.user.findUniqueOrThrow({ where: { email: "matt@lst.local" }, select: { id: true } });
    eric = await prisma.user.findUniqueOrThrow({ where: { email: "eric@lst.local" }, select: { id: true } });
  });

  beforeEach(() => {
    fakeStorage = createFakeStorage();
    chatAttachments.setChatAttachmentStorageForTests(fakeStorage.storage);
  });

  afterEach(() => {
    vi.restoreAllMocks();
    chatAttachments.setChatAttachmentStorageForTests(null);
  });

  afterAll(async () => {
    await prisma.chatMessage.deleteMany({ where: { id: { in: createdMessageIds } } });
    await prisma.conversation.deleteMany({ where: { id: { in: createdConversationIds } } });
    await prisma.user.deleteMany({ where: { id: { in: createdUserIds } } });
    await prisma.$disconnect();
  });

  it("persists image metadata and lets only conversation participants read the private bytes", async () => {
    const conversation = await mattEricConversation();

    const sent = await workflows.sendChatMessageForUser(matt.id, conversation.id, "Chart check", null, [
      imageFile("chart.png"),
    ]);
    expect(sent).toMatchObject({ senderId: matt.id, body: "Chart check" });
    if (!sent) throw new Error("expected a message");
    createdMessageIds.push(sent.id);

    const stored = await prisma.chatMessage.findUniqueOrThrow({
      where: { id: sent.id },
      include: { attachments: true },
    });
    expect(stored.attachments).toHaveLength(1);
    const attachment = stored.attachments[0];
    expect(attachment.storageKey).toMatch(/^buddy-chat\//);
    expect(attachment.storageKey).not.toContain("chart");

    await expect(chatAttachments.readChatAttachmentForUser(matt.id, attachment.id)).resolves.toMatchObject({
      id: attachment.id,
      mimeType: "image/png",
      originalFileName: "chart.png",
    });
    await expect(chatAttachments.readChatAttachmentForUser(eric.id, attachment.id)).resolves.toMatchObject({
      id: attachment.id,
    });

    const ericChat = await (await import("./app-data")).getChatPageData(eric.id);
    const ericMessage = ericChat?.messages.find((message) => message.id === sent.id);
    expect(ericMessage?.attachments).toHaveLength(1);
  });

  it("blocks unrelated users and treats guessed storage keys as non-addressable", async () => {
    const rogue = await createUser("attachment-rogue");
    const privateConversation = await prisma.conversation.create({
      data: {
        title: "Attachment isolation",
        members: {
          create: [{ userId: matt.id }, { userId: rogue.id }],
        },
      },
    });
    createdConversationIds.push(privateConversation.id);

    const sent = await workflows.sendChatMessageForUser(matt.id, privateConversation.id, "", null, [
      imageFile("private.png"),
    ]);
    if (!sent) throw new Error("expected a message");
    createdMessageIds.push(sent.id);

    const attachment = await prisma.chatAttachment.findFirstOrThrow({ where: { messageId: sent.id } });
    await expect(chatAttachments.readChatAttachmentForUser(matt.id, attachment.id)).resolves.toMatchObject({ id: attachment.id });
    await expect(chatAttachments.readChatAttachmentForUser(rogue.id, attachment.id)).resolves.toMatchObject({ id: attachment.id });
    await expect(chatAttachments.readChatAttachmentForUser(eric.id, attachment.id)).resolves.toBeNull();
    await expect(chatAttachments.readChatAttachmentForUser(eric.id, attachment.storageKey)).resolves.toBeNull();
  });

  it("ignores browser sender spoofing because the caller userId is the sender", async () => {
    const conversation = await mattEricConversation();
    const sent = await workflows.sendChatMessageForUser(matt.id, conversation.id, "spoof attempt", null, [
      imageFile("spoof.png"),
    ]);
    if (!sent) throw new Error("expected a message");
    createdMessageIds.push(sent.id);

    expect(sent.senderId).toBe(matt.id);
    expect(sent.senderId).not.toBe(eric.id);
  });

  it("returns a clear validation error when private storage upload fails", async () => {
    fakeStorage.failUpload = true;
    const conversation = await mattEricConversation();
    const before = await prisma.chatMessage.count({ where: { conversationId: conversation.id } });

    await expect(
      workflows.sendChatMessageForUser(matt.id, conversation.id, "upload failure", null, [imageFile("fail.png")]),
    ).rejects.toThrow("Image storage is unavailable");

    const after = await prisma.chatMessage.count({ where: { conversationId: conversation.id } });
    expect(after).toBe(before);
  });

  it("removes uploaded objects when message persistence fails after upload", async () => {
    const conversation = await mattEricConversation();
    vi.spyOn(prisma.chatMessage, "create").mockRejectedValueOnce(new Error("DB write failed") as never);

    await expect(
      workflows.sendChatMessageForUser(matt.id, conversation.id, "db failure", null, [imageFile("cleanup.png")]),
    ).rejects.toThrow("DB write failed");

    expect(fakeStorage.uploadedKeys).toHaveLength(1);
    expect(fakeStorage.removedKeys).toEqual(fakeStorage.uploadedKeys);
  });

  it("keeps text-only chat unchanged", async () => {
    const conversation = await mattEricConversation();
    const sent = await workflows.sendChatMessageForUser(matt.id, conversation.id, "plain message");
    if (!sent) throw new Error("expected a message");
    createdMessageIds.push(sent.id);

    const stored = await prisma.chatMessage.findUniqueOrThrow({
      where: { id: sent.id },
      include: { attachments: true },
    });
    expect(stored.body).toBe("plain message");
    expect(stored.attachments).toHaveLength(0);
  });

  async function mattEricConversation() {
    return prisma.conversation.findFirstOrThrow({
      where: {
        AND: [
          { members: { some: { userId: matt.id } } },
          { members: { some: { userId: eric.id } } },
        ],
      },
      select: { id: true },
    });
  }

  async function createUser(prefix: string) {
    const user = await prisma.user.create({
      data: {
        name: prefix,
        email: `${prefix}-${Date.now()}-${Math.random().toString(16).slice(2)}@lst.local`,
        passwordHash: await hash("not-used", 4),
      },
      select: { id: true },
    });
    createdUserIds.push(user.id);
    return user;
  }
});

function createFakeStorage() {
  const objects = new Map<string, { bytes: Uint8Array; contentType: string }>();
  const fake = {
    failUpload: false,
    uploadedKeys: [] as string[],
    removedKeys: [] as string[],
    storage: {
      async upload({ bucket, key, bytes, contentType }: { bucket: string; key: string; bytes: Uint8Array; contentType: string }) {
        if (fake.failUpload) throw new Error("upload failed");
        const fullKey = `${bucket}/${key}`;
        objects.set(fullKey, { bytes, contentType });
        fake.uploadedKeys.push(key);
      },
      async download(bucket: string, key: string) {
        const object = objects.get(`${bucket}/${key}`);
        if (!object) throw new Error("missing object");
        return object;
      },
      async remove(bucket: string, keys: string[]) {
        for (const key of keys) {
          objects.delete(`${bucket}/${key}`);
          fake.removedKeys.push(key);
        }
      },
    },
  };
  return fake;
}

function imageFile(name: string) {
  return new File([pngBytes()], name, { type: "image/png" });
}

function pngBytes() {
  return Uint8Array.from(Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/p9sAAAAASUVORK5CYII=", "base64"));
}
