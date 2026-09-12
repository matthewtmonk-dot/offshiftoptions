import "server-only";

import { randomUUID } from "node:crypto";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import {
  CHAT_ATTACHMENT_ALLOWED_MIME_TYPES,
  CHAT_ATTACHMENT_MAX_BYTES,
  CHAT_ATTACHMENT_MAX_FILES,
  type ChatAttachmentMimeType,
} from "@/domain/chat/attachments";
import { prisma } from "./prisma";
import { ValidationError } from "./tickers";

export const CHAT_ATTACHMENT_BUCKET = process.env.BUDDY_CHAT_STORAGE_BUCKET ?? "buddy-chat-attachments";

const ALLOWED_IMAGE_TYPES = new Set<string>(CHAT_ATTACHMENT_ALLOWED_MIME_TYPES);

type DetectedImage = {
  mimeType: ChatAttachmentMimeType;
  extension: "jpg" | "png" | "webp";
  width: number | null;
  height: number | null;
};

export type PreparedChatAttachment = {
  storageBucket: string;
  storageKey: string;
  mimeType: string;
  originalFileName: string;
  byteSize: number;
  width: number | null;
  height: number | null;
  bytes: Uint8Array;
};

export type ReadableChatAttachment = {
  id: string;
  mimeType: string;
  originalFileName: string;
  byteSize: number;
  bytes: Uint8Array;
};

type StoredObject = {
  bytes: Uint8Array;
  contentType: string;
};

export type ChatAttachmentStorage = {
  upload(object: StoredObject & { bucket: string; key: string }): Promise<void>;
  download(bucket: string, key: string): Promise<StoredObject>;
  remove(bucket: string, keys: string[]): Promise<void>;
};

let storageOverride: ChatAttachmentStorage | null = null;
let supabaseClient: SupabaseClient | null = null;

export function allowedChatImageMimeTypes() {
  return [...ALLOWED_IMAGE_TYPES];
}

export function setChatAttachmentStorageForTests(storage: ChatAttachmentStorage | null) {
  if (process.env.NODE_ENV !== "test") {
    throw new Error("Chat attachment storage overrides are test-only.");
  }
  storageOverride = storage;
}

export async function prepareChatImageAttachments(conversationId: string, entries: FormDataEntryValue[]) {
  const files = entries.filter((entry): entry is File => entry instanceof File && entry.size > 0);
  if (files.length > CHAT_ATTACHMENT_MAX_FILES) {
    throw new ValidationError(`Send up to ${CHAT_ATTACHMENT_MAX_FILES} images at a time.`);
  }

  const prepared: PreparedChatAttachment[] = [];
  for (const file of files) {
    if (!ALLOWED_IMAGE_TYPES.has(file.type)) {
      throw new ValidationError("Buddy Chat supports JPG, PNG, and WEBP images only.");
    }
    if (file.size > CHAT_ATTACHMENT_MAX_BYTES) {
      throw new ValidationError("Each image must be 10 MB or smaller.");
    }

    const bytes = new Uint8Array(await file.arrayBuffer());
    const detected = detectImage(bytes);
    if (!detected || detected.mimeType !== file.type) {
      throw new ValidationError("That file is not a valid JPG, PNG, or WEBP image.");
    }

    prepared.push({
      storageBucket: CHAT_ATTACHMENT_BUCKET,
      storageKey: buildStorageKey(conversationId, detected.extension),
      mimeType: detected.mimeType,
      originalFileName: safeDisplayFilename(file.name || `image.${detected.extension}`, detected.extension),
      byteSize: bytes.byteLength,
      width: detected.width,
      height: detected.height,
      bytes,
    });
  }

  return prepared;
}

export async function uploadChatAttachments(attachments: PreparedChatAttachment[]) {
  if (!attachments.length) return [];

  const uploaded: PreparedChatAttachment[] = [];

  try {
    const storage = getChatAttachmentStorage();
    for (const attachment of attachments) {
      await storage.upload({
        bucket: attachment.storageBucket,
        key: attachment.storageKey,
        bytes: attachment.bytes,
        contentType: attachment.mimeType,
      });
      uploaded.push(attachment);
    }
  } catch {
    await removeUploadedChatAttachments(uploaded);
    throw new ValidationError("Image storage is unavailable. Please try again later.");
  }

  return uploaded;
}

export async function removeUploadedChatAttachments(attachments: Array<Pick<PreparedChatAttachment, "storageBucket" | "storageKey">>) {
  if (!attachments.length) return;

  const storage = getChatAttachmentStorage();
  const byBucket = new Map<string, string[]>();
  for (const attachment of attachments) {
    const keys = byBucket.get(attachment.storageBucket) ?? [];
    keys.push(attachment.storageKey);
    byBucket.set(attachment.storageBucket, keys);
  }

  await Promise.all([...byBucket].map(([bucket, keys]) => storage.remove(bucket, keys).catch(() => undefined)));
}

export async function readChatAttachmentForUser(userId: string, attachmentId: string): Promise<ReadableChatAttachment | null> {
  const attachment = await prisma.chatAttachment.findFirst({
    where: {
      id: attachmentId,
      message: {
        conversation: {
          members: { some: { userId } },
        },
      },
    },
    select: {
      id: true,
      storageBucket: true,
      storageKey: true,
      mimeType: true,
      originalFileName: true,
      byteSize: true,
    },
  });

  if (!attachment) {
    return null;
  }

  const stored = await getChatAttachmentStorage().download(attachment.storageBucket, attachment.storageKey);
  return {
    id: attachment.id,
    mimeType: attachment.mimeType,
    originalFileName: attachment.originalFileName,
    byteSize: attachment.byteSize,
    bytes: stored.bytes,
  };
}

function buildStorageKey(conversationId: string, extension: string) {
  return `buddy-chat/${safeStorageSegment(conversationId)}/${randomUUID()}/${randomUUID()}.${extension}`;
}

function safeStorageSegment(value: string) {
  return value.replace(/[^a-zA-Z0-9_-]/g, "");
}

function safeDisplayFilename(rawName: string, extension: string) {
  const base = rawName.split(/[\\/]/).pop() ?? `image.${extension}`;
  const clean = base.replace(/[\u0000-\u001f\u007f]+/g, "").replace(/\s+/g, " ").trim();
  const fallback = `image.${extension}`;
  return (clean || fallback).slice(0, 120);
}

function getChatAttachmentStorage(): ChatAttachmentStorage {
  if (storageOverride) return storageOverride;
  if (process.env.SUPABASE_URL && getSupabaseServerKey()) {
    return supabaseStorage();
  }
  if (process.env.BUDDY_CHAT_LOCAL_STORAGE_ROOT) {
    return localStorage();
  }
  if (process.env.NODE_ENV === "production") {
    throw new Error("Buddy Chat attachment storage is not configured.");
  }
  return localStorage();
}

function supabaseStorage(): ChatAttachmentStorage {
  const client = getSupabaseClient();
  return {
    async upload({ bucket, key, bytes, contentType }) {
      const { error } = await client.storage.from(bucket).upload(key, bytes, {
        cacheControl: "300",
        contentType,
        upsert: false,
      });
      if (error) throw error;
    },
    async download(bucket, key) {
      const { data, error } = await client.storage.from(bucket).download(key);
      if (error || !data) throw error ?? new Error("Attachment not found.");
      return { bytes: new Uint8Array(await data.arrayBuffer()), contentType: data.type || "application/octet-stream" };
    },
    async remove(bucket, keys) {
      const { error } = await client.storage.from(bucket).remove(keys);
      if (error) throw error;
    },
  };
}

function getSupabaseClient() {
  if (!supabaseClient) {
    supabaseClient = createClient(process.env.SUPABASE_URL ?? "", getSupabaseServerKey(), {
      auth: {
        autoRefreshToken: false,
        persistSession: false,
      },
    });
  }
  return supabaseClient;
}

function getSupabaseServerKey() {
  return process.env.SUPABASE_SECRET_KEY || process.env.SUPABASE_SERVICE_ROLE_KEY || "";
}

function localStorage(): ChatAttachmentStorage {
  const root = process.env.BUDDY_CHAT_LOCAL_STORAGE_ROOT ?? path.join(process.cwd(), ".data", "buddy-chat-attachments");
  return {
    async upload({ bucket, key, bytes }) {
      const filePath = localObjectPath(root, bucket, key);
      await mkdir(path.dirname(filePath), { recursive: true });
      await writeFile(filePath, bytes, { flag: "wx" });
    },
    async download(bucket, key) {
      const filePath = localObjectPath(root, bucket, key);
      return { bytes: await readFile(filePath), contentType: "application/octet-stream" };
    },
    async remove(bucket, keys) {
      await Promise.all(keys.map((key) => rm(localObjectPath(root, bucket, key), { force: true }).catch(() => undefined)));
    },
  };
}

function localObjectPath(root: string, bucket: string, key: string) {
  const segments = [bucket, ...key.split("/")];
  if (segments.some((segment) => !segment || segment === "." || segment === ".." || !/^[a-zA-Z0-9._-]+$/.test(segment))) {
    throw new Error("Invalid storage key.");
  }
  return path.join(root, ...segments);
}

export function detectImage(bytes: Uint8Array): DetectedImage | null {
  if (isJpeg(bytes)) {
    const dimensions = jpegDimensions(bytes);
    return { mimeType: "image/jpeg", extension: "jpg", ...dimensions };
  }
  if (isPng(bytes)) {
    return {
      mimeType: "image/png",
      extension: "png",
      width: readUint32(bytes, 16),
      height: readUint32(bytes, 20),
    };
  }
  if (isWebp(bytes)) {
    return { mimeType: "image/webp", extension: "webp", ...webpDimensions(bytes) };
  }
  return null;
}

function isJpeg(bytes: Uint8Array) {
  return bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff;
}

function isPng(bytes: Uint8Array) {
  const signature = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
  return bytes.length >= 24 && signature.every((value, index) => bytes[index] === value);
}

function isWebp(bytes: Uint8Array) {
  return (
    bytes.length >= 16 &&
    ascii(bytes, 0, 4) === "RIFF" &&
    ascii(bytes, 8, 12) === "WEBP"
  );
}

function jpegDimensions(bytes: Uint8Array) {
  let offset = 2;
  while (offset + 9 < bytes.length) {
    if (bytes[offset] !== 0xff) {
      offset += 1;
      continue;
    }

    const marker = bytes[offset + 1];
    const length = readUint16(bytes, offset + 2);
    if (!length || offset + 2 + length > bytes.length) return { width: null, height: null };
    if ((marker >= 0xc0 && marker <= 0xc3) || (marker >= 0xc5 && marker <= 0xc7) || (marker >= 0xc9 && marker <= 0xcb) || (marker >= 0xcd && marker <= 0xcf)) {
      return {
        height: readUint16(bytes, offset + 5),
        width: readUint16(bytes, offset + 7),
      };
    }
    offset += 2 + length;
  }
  return { width: null, height: null };
}

function webpDimensions(bytes: Uint8Array) {
  const chunk = ascii(bytes, 12, 16);
  if (chunk === "VP8X" && bytes.length >= 30) {
    return {
      width: 1 + readUint24Le(bytes, 24),
      height: 1 + readUint24Le(bytes, 27),
    };
  }
  if (chunk === "VP8 " && bytes.length >= 30) {
    return {
      width: readUint16Le(bytes, 26) & 0x3fff,
      height: readUint16Le(bytes, 28) & 0x3fff,
    };
  }
  if (chunk === "VP8L" && bytes.length >= 25) {
    const b0 = bytes[21];
    const b1 = bytes[22];
    const b2 = bytes[23];
    const b3 = bytes[24];
    return {
      width: 1 + (((b1 & 0x3f) << 8) | b0),
      height: 1 + (((b3 & 0x0f) << 10) | (b2 << 2) | ((b1 & 0xc0) >> 6)),
    };
  }
  return { width: null, height: null };
}

function readUint16(bytes: Uint8Array, offset: number) {
  if (offset + 1 >= bytes.length) return null;
  return (bytes[offset] << 8) | bytes[offset + 1];
}

function readUint32(bytes: Uint8Array, offset: number) {
  if (offset + 3 >= bytes.length) return null;
  return ((bytes[offset] << 24) | (bytes[offset + 1] << 16) | (bytes[offset + 2] << 8) | bytes[offset + 3]) >>> 0;
}

function readUint16Le(bytes: Uint8Array, offset: number) {
  return bytes[offset] | (bytes[offset + 1] << 8);
}

function readUint24Le(bytes: Uint8Array, offset: number) {
  return bytes[offset] | (bytes[offset + 1] << 8) | (bytes[offset + 2] << 16);
}

function ascii(bytes: Uint8Array, start: number, end: number) {
  return String.fromCharCode(...bytes.slice(start, end));
}
