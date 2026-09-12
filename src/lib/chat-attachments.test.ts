import { afterEach, describe, expect, it } from "vitest";
import {
  CHAT_ATTACHMENT_MAX_BYTES,
  CHAT_ATTACHMENT_MAX_FILES,
} from "@/domain/chat/attachments";
import { detectImage, prepareChatImageAttachments, setChatAttachmentStorageForTests, uploadChatAttachments } from "./chat-attachments";

describe("chat attachment validation", () => {
  afterEach(() => {
    setChatAttachmentStorageForTests(null);
  });

  it("accepts JPG, PNG, and WEBP images after checking their bytes", async () => {
    await expect(prepareChatImageAttachments("conversation", [file("one.jpg", "image/jpeg", jpegBytes())])).resolves.toMatchObject([
      { mimeType: "image/jpeg", originalFileName: "one.jpg", byteSize: jpegBytes().byteLength, width: 1, height: 1 },
    ]);

    await expect(prepareChatImageAttachments("conversation", [file("one.png", "image/png", pngBytes())])).resolves.toMatchObject([
      { mimeType: "image/png", originalFileName: "one.png", width: 1, height: 1 },
    ]);

    await expect(prepareChatImageAttachments("conversation", [file("one.webp", "image/webp", webpBytes())])).resolves.toMatchObject([
      { mimeType: "image/webp", originalFileName: "one.webp", width: 1, height: 1 },
    ]);
  });

  it("rejects oversized, unsupported, and renamed malicious files", async () => {
    const tooLarge = new File([new Uint8Array(CHAT_ATTACHMENT_MAX_BYTES + 1)], "large.png", { type: "image/png" });
    await expect(prepareChatImageAttachments("conversation", [tooLarge])).rejects.toThrow("10 MB");

    await expect(
      prepareChatImageAttachments("conversation", [file("vector.svg", "image/svg+xml", new TextEncoder().encode("<svg />"))]),
    ).rejects.toThrow("JPG, PNG, and WEBP");

    await expect(
      prepareChatImageAttachments("conversation", [file("evil.jpg", "image/jpeg", new TextEncoder().encode("<html></html>"))]),
    ).rejects.toThrow("not a valid");
  });

  it("limits one message to a small set of images", async () => {
    const files = Array.from({ length: CHAT_ATTACHMENT_MAX_FILES + 1 }, (_, index) =>
      file(`image-${index}.png`, "image/png", pngBytes()),
    );
    await expect(prepareChatImageAttachments("conversation", files)).rejects.toThrow(`up to ${CHAT_ATTACHMENT_MAX_FILES}`);
  });

  it("does not expose raw filenames in storage keys", async () => {
    const [attachment] = await prepareChatImageAttachments("conversation", [
      file("../Quarterly Screenshot.png", "image/png", pngBytes()),
    ]);
    expect(attachment.originalFileName).toBe("Quarterly Screenshot.png");
    expect(attachment.storageKey).toMatch(/^buddy-chat\/conversation\//);
    expect(attachment.storageKey).not.toContain("Quarterly");
    expect(attachment.storageKey).not.toContain("..");
  });

  it("returns null for non-image bytes", () => {
    expect(detectImage(new TextEncoder().encode("not an image"))).toBeNull();
  });

  it("does not require storage when no images are attached", async () => {
    setChatAttachmentStorageForTests({
      async upload() {
        throw new Error("storage should not be touched");
      },
      async download() {
        throw new Error("storage should not be touched");
      },
      async remove() {
        throw new Error("storage should not be touched");
      },
    });

    await expect(uploadChatAttachments([])).resolves.toEqual([]);
  });
});

function file(name: string, type: string, bytes: Uint8Array) {
  return new File([toArrayBuffer(bytes)], name, { type });
}

function pngBytes() {
  return Uint8Array.from([
    0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
    0x00, 0x00, 0x00, 0x0d,
    0x49, 0x48, 0x44, 0x52,
    0x00, 0x00, 0x00, 0x01,
    0x00, 0x00, 0x00, 0x01,
  ]);
}

function jpegBytes() {
  return Uint8Array.from([
    0xff, 0xd8,
    0xff, 0xe0, 0x00, 0x10,
    0x4a, 0x46, 0x49, 0x46, 0x00, 0x01, 0x01, 0x00,
    0x00, 0x01, 0x00, 0x01, 0x00, 0x00,
    0xff, 0xc0, 0x00, 0x11, 0x08,
    0x00, 0x01, 0x00, 0x01,
    0x03, 0x01, 0x11, 0x00,
    0x02, 0x11, 0x00, 0x03, 0x11, 0x00,
    0xff, 0xd9,
  ]);
}

function webpBytes() {
  const bytes = new Uint8Array(30);
  bytes.set(new TextEncoder().encode("RIFF"), 0);
  bytes.set(new TextEncoder().encode("WEBP"), 8);
  bytes.set(new TextEncoder().encode("VP8X"), 12);
  bytes[24] = 0;
  bytes[25] = 0;
  bytes[26] = 0;
  bytes[27] = 0;
  bytes[28] = 0;
  bytes[29] = 0;
  return bytes;
}

function toArrayBuffer(bytes: Uint8Array) {
  const copy = new ArrayBuffer(bytes.byteLength);
  new Uint8Array(copy).set(bytes);
  return copy;
}
