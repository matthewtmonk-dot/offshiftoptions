import { getCurrentUser } from "@/lib/auth";
import { readChatAttachmentForUser } from "@/lib/chat-attachments";

export const dynamic = "force-dynamic";

type AttachmentRouteContext = {
  params: Promise<{ attachmentId: string }>;
};

export async function GET(_request: Request, context: AttachmentRouteContext) {
  const user = await getCurrentUser();
  if (!user) {
    return new Response("Unauthorized", { status: 401 });
  }

  const { attachmentId } = await context.params;

  try {
    const attachment = await readChatAttachmentForUser(user.id, attachmentId);
    if (!attachment) {
      return new Response("Not found", { status: 404 });
    }

    return new Response(new Blob([toArrayBuffer(attachment.bytes)], { type: attachment.mimeType }), {
      headers: {
        "Cache-Control": "private, max-age=300",
        "Content-Disposition": `inline; filename="${headerSafeFilename(attachment.originalFileName)}"`,
        "Content-Length": String(attachment.byteSize),
        "Content-Type": attachment.mimeType,
        "X-Content-Type-Options": "nosniff",
      },
    });
  } catch {
    return new Response("Not found", { status: 404 });
  }
}

function headerSafeFilename(value: string) {
  return value.replace(/["\\\r\n]/g, "_").slice(0, 120) || "image";
}

function toArrayBuffer(bytes: Uint8Array) {
  const copy = new ArrayBuffer(bytes.byteLength);
  new Uint8Array(copy).set(bytes);
  return copy;
}
