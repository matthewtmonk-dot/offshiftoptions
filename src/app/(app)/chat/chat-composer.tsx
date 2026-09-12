"use client";

/* eslint-disable @next/next/no-img-element -- Pending attachment previews use local blob URLs, not optimizable app assets. */

import { type FormEvent, useEffect, useRef, useState, useTransition } from "react";
import { ImagePlus, Send, X } from "lucide-react";
import { useRouter } from "next/navigation";
import {
  CHAT_ATTACHMENT_ALLOWED_MIME_TYPES,
  CHAT_ATTACHMENT_MAX_BYTES,
  CHAT_ATTACHMENT_MAX_FILES,
} from "@/domain/chat/attachments";
import { sendChatMessageAction } from "../actions";

type PendingAttachment = {
  id: string;
  file: File;
  previewUrl: string;
};

export function ChatComposer({ conversationId }: { conversationId: string }) {
  const router = useRouter();
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const attachmentsRef = useRef<PendingAttachment[]>([]);
  const [attachments, setAttachments] = useState<PendingAttachment[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [dragActive, setDragActive] = useState(false);
  const [isPending, startTransition] = useTransition();

  const hasAttachments = attachments.length > 0;

  useEffect(() => {
    attachmentsRef.current = attachments;
  }, [attachments]);

  useEffect(() => () => {
    attachmentsRef.current.forEach((attachment) => URL.revokeObjectURL(attachment.previewUrl));
  }, []);

  function addFiles(files: File[]) {
    const imageFiles = files.filter((file) => file.size > 0);
    if (!imageFiles.length) return;

    const nextError = validateClientFiles(attachments.length, imageFiles);
    if (nextError) {
      setError(nextError);
      return;
    }

    setError(null);
    setAttachments((current) => [
      ...current,
      ...imageFiles.map((file) => ({
        id: crypto.randomUUID(),
        file,
        previewUrl: URL.createObjectURL(file),
      })),
    ]);
  }

  function removeAttachment(id: string) {
    setAttachments((current) => {
      const removed = current.find((attachment) => attachment.id === id);
      if (removed) URL.revokeObjectURL(removed.previewUrl);
      return current.filter((attachment) => attachment.id !== id);
    });
  }

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (isPending) return;

    const form = event.currentTarget;
    const formData = new FormData(form);
    const body = String(formData.get("body") ?? "").trim();
    if (!body && !attachments.length) {
      setError("Write a message or attach an image first.");
      return;
    }

    formData.delete("attachments");
    attachments.forEach((attachment) => formData.append("attachments", attachment.file, attachment.file.name || "image"));
    setError(null);

    startTransition(async () => {
      const result = await sendChatMessageAction(formData);
      if (!result.ok) {
        setError(result.error);
        return;
      }

      form.reset();
      setAttachments((current) => {
        current.forEach((attachment) => URL.revokeObjectURL(attachment.previewUrl));
        return [];
      });
      if (fileInputRef.current) fileInputRef.current.value = "";
      router.refresh();
    });
  }

  return (
    <form
      data-testid="chat-composer"
      onSubmit={handleSubmit}
      onDragEnter={(event) => {
        if (hasDraggedFiles(event.dataTransfer)) {
          event.preventDefault();
          setDragActive(true);
        }
      }}
      onDragOver={(event) => {
        if (hasDraggedFiles(event.dataTransfer)) {
          event.preventDefault();
          setDragActive(true);
        }
      }}
      onDragLeave={(event) => {
        if (event.currentTarget.contains(event.relatedTarget as Node | null)) return;
        setDragActive(false);
      }}
      onDrop={(event) => {
        if (!hasDraggedFiles(event.dataTransfer)) return;
        event.preventDefault();
        setDragActive(false);
        addFiles(Array.from(event.dataTransfer.files));
      }}
      onPaste={(event) => {
        const pastedFiles = Array.from(event.clipboardData.items)
          .filter((item) => item.kind === "file" && item.type.startsWith("image/"))
          .map((item) => item.getAsFile())
          .filter((file): file is File => Boolean(file));
        if (pastedFiles.length) {
          event.preventDefault();
          addFiles(pastedFiles);
        }
      }}
      className={`rounded-lg border p-3 ${dragActive ? "border-emerald-400 bg-emerald-400/10" : "border-zinc-800 bg-zinc-950/70"}`}
    >
      <input type="hidden" name="conversationId" value={conversationId} />
      <div className="grid gap-2 md:grid-cols-[120px_1fr_auto]">
        <input
          name="ticker"
          placeholder="Ticker"
          className="min-h-11 rounded-md border border-zinc-700 bg-zinc-950 px-3 text-sm text-zinc-100"
        />
        <textarea
          name="body"
          placeholder={hasAttachments ? "Add a note" : "Message"}
          rows={1}
          className="min-h-11 resize-y rounded-md border border-zinc-700 bg-zinc-950 px-3 py-2 text-sm text-zinc-100"
        />
        <div className="flex gap-2">
          <input
            ref={fileInputRef}
            type="file"
            name="attachments"
            accept={CHAT_ATTACHMENT_ALLOWED_MIME_TYPES.join(",")}
            multiple
            className="sr-only"
            onChange={(event) => {
              addFiles(Array.from(event.currentTarget.files ?? []));
              event.currentTarget.value = "";
            }}
          />
          <button
            type="button"
            onClick={() => fileInputRef.current?.click()}
            className="inline-flex size-11 items-center justify-center rounded-md border border-zinc-700 text-zinc-200 hover:border-emerald-400/60"
            aria-label="Attach image"
            title="Attach image"
          >
            <ImagePlus className="size-5" aria-hidden />
          </button>
          <button
            type="submit"
            disabled={isPending}
            className="inline-flex min-h-11 items-center justify-center gap-2 rounded-md bg-emerald-400 px-4 text-sm font-semibold text-black hover:bg-emerald-300 disabled:cursor-not-allowed disabled:opacity-60"
          >
            <Send className="size-4" aria-hidden />
            {isPending ? "Sending" : "Send"}
          </button>
        </div>
      </div>

      {attachments.length ? (
        <div className="mt-3 grid grid-cols-2 gap-2 sm:grid-cols-4">
          {attachments.map((attachment) => (
            <div key={attachment.id} className="relative overflow-hidden rounded-md border border-zinc-700 bg-zinc-900">
              <img src={attachment.previewUrl} alt="" className="aspect-[4/3] w-full object-cover" />
              <button
                type="button"
                onClick={() => removeAttachment(attachment.id)}
                className="absolute right-2 top-2 inline-flex size-8 items-center justify-center rounded-md bg-black/75 text-zinc-50 hover:bg-black"
                aria-label={`Remove ${attachment.file.name || "image"}`}
              >
                <X className="size-4" aria-hidden />
              </button>
              <div className="space-y-0.5 px-2 py-1">
                <div className="truncate text-xs text-zinc-200">{attachment.file.name || "Screenshot"}</div>
                <div className="text-xs text-zinc-500">{formatBytes(attachment.file.size)}</div>
              </div>
            </div>
          ))}
        </div>
      ) : null}

      <div className="mt-2 flex flex-wrap items-center justify-between gap-2 text-xs text-zinc-500">
        <span>{dragActive ? "Drop images to attach." : "Attach JPG, PNG, or WEBP. Paste screenshots directly."}</span>
        <span>{attachments.length} / {CHAT_ATTACHMENT_MAX_FILES}</span>
      </div>
      {error ? <p className="mt-2 text-sm text-amber-200">{error}</p> : null}
    </form>
  );
}

function validateClientFiles(currentCount: number, files: File[]) {
  if (currentCount + files.length > CHAT_ATTACHMENT_MAX_FILES) {
    return `Send up to ${CHAT_ATTACHMENT_MAX_FILES} images at a time.`;
  }
  const supportedTypes: readonly string[] = CHAT_ATTACHMENT_ALLOWED_MIME_TYPES;
  const unsupported = files.find((file) => !supportedTypes.includes(file.type));
  if (unsupported) {
    return "Buddy Chat supports JPG, PNG, and WEBP images only.";
  }
  const oversized = files.find((file) => file.size > CHAT_ATTACHMENT_MAX_BYTES);
  if (oversized) {
    return "Each image must be 10 MB or smaller.";
  }
  return null;
}

function hasDraggedFiles(dataTransfer: DataTransfer) {
  return Array.from(dataTransfer.types).includes("Files");
}

function formatBytes(bytes: number) {
  if (bytes >= 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  if (bytes >= 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${bytes} B`;
}
