"use client";

/* eslint-disable @next/next/no-img-element -- Private authenticated image routes should not be fetched through the public optimizer. */

import { useEffect, useMemo, useState } from "react";
import { Maximize2, X } from "lucide-react";

export type ChatAttachmentView = {
  id: string;
  mimeType: string;
  originalFileName: string;
  byteSize: number;
  width: number | null;
  height: number | null;
};

export function ChatAttachmentGallery({ attachments }: { attachments: ChatAttachmentView[] }) {
  const [activeId, setActiveId] = useState<string | null>(null);
  const active = useMemo(() => attachments.find((attachment) => attachment.id === activeId) ?? null, [activeId, attachments]);

  useEffect(() => {
    if (!active) return;
    function handleKeyDown(event: KeyboardEvent) {
      if (event.key === "Escape") {
        setActiveId(null);
      }
    }
    document.addEventListener("keydown", handleKeyDown);
    return () => document.removeEventListener("keydown", handleKeyDown);
  }, [active]);

  if (!attachments.length) return null;

  return (
    <>
      <div className="mt-3 grid grid-cols-2 gap-2 sm:grid-cols-3">
        {attachments.map((attachment) => (
          <button
            key={attachment.id}
            type="button"
            onClick={() => setActiveId(attachment.id)}
            className="group relative overflow-hidden rounded-md border border-zinc-700 bg-zinc-950 text-left hover:border-emerald-400/60"
            aria-label={`Open ${attachment.originalFileName}`}
          >
            <img
              src={attachmentUrl(attachment.id)}
              alt={attachment.originalFileName}
              loading="lazy"
              className="aspect-[4/3] w-full bg-zinc-950 object-cover"
            />
            <span className="absolute right-2 top-2 rounded-md bg-black/70 p-1 text-zinc-100 opacity-0 transition-opacity group-hover:opacity-100">
              <Maximize2 className="size-3.5" aria-hidden />
            </span>
            <span className="block truncate px-2 py-1 text-xs text-zinc-300">{attachment.originalFileName}</span>
          </button>
        ))}
      </div>

      {active ? (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/85 p-4"
          role="dialog"
          aria-modal="true"
          aria-label={active.originalFileName}
          onMouseDown={(event) => {
            if (event.target === event.currentTarget) setActiveId(null);
          }}
        >
          <div className="flex max-h-full w-full max-w-5xl flex-col gap-3">
            <div className="flex items-center justify-between gap-3 text-sm text-zinc-200">
              <div className="min-w-0">
                <div className="truncate font-medium">{active.originalFileName}</div>
                <div className="text-xs text-zinc-400">
                  {active.width && active.height ? `${active.width} x ${active.height} - ` : null}
                  {formatBytes(active.byteSize)}
                </div>
              </div>
              <button
                type="button"
                onClick={() => setActiveId(null)}
                className="inline-flex size-10 shrink-0 items-center justify-center rounded-md border border-zinc-700 bg-zinc-950 text-zinc-100 hover:border-emerald-400/60"
                aria-label="Close image preview"
              >
                <X className="size-5" aria-hidden />
              </button>
            </div>
            <img
              src={attachmentUrl(active.id)}
              alt={active.originalFileName}
              className="max-h-[82vh] w-full object-contain"
            />
          </div>
        </div>
      ) : null}
    </>
  );
}

function attachmentUrl(id: string) {
  return `/api/chat/attachments/${encodeURIComponent(id)}`;
}

function formatBytes(bytes: number) {
  if (bytes >= 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  if (bytes >= 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${bytes} B`;
}
