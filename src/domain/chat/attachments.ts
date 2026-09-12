export const CHAT_ATTACHMENT_MAX_BYTES = 10 * 1024 * 1024;
export const CHAT_ATTACHMENT_MAX_FILES = 4;
export const CHAT_ATTACHMENT_ALLOWED_MIME_TYPES = ["image/jpeg", "image/png", "image/webp"] as const;

export type ChatAttachmentMimeType = (typeof CHAT_ATTACHMENT_ALLOWED_MIME_TYPES)[number];
