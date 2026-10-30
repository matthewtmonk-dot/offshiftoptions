import { AlertTriangle } from "lucide-react";
import type { SchwabConnectionNotice } from "@/lib/schwab-connection-notice";

/**
 * A thin banner across every signed-in page when Schwab needs to be (or is about to need to be) reconnected.
 * Plain links, no client code. `/api/schwab/connect` starts the usual read-only Schwab sign-in.
 */
export function SchwabConnectionBanner({ notice }: { notice: SchwabConnectionNotice }) {
  if (!notice) return null;
  const expired = notice.level === "expired";
  return (
    <div
      role="status"
      data-testid="schwab-connection-banner"
      className={`flex flex-wrap items-center gap-x-3 gap-y-1 border-b px-4 py-2 text-sm md:px-6 lg:px-8 ${
        expired ? "border-red-400/30 bg-red-400/10 text-red-100" : "border-amber-400/30 bg-amber-400/10 text-amber-100"
      }`}
    >
      <AlertTriangle className="size-4 shrink-0" aria-hidden />
      <span className="min-w-0 flex-1">
        <span className="font-semibold">{notice.title}.</span> {notice.detail}
      </span>
      <a
        href="/api/schwab/connect"
        className={`inline-flex min-h-8 shrink-0 items-center rounded-md border px-3 text-xs font-semibold ${
          expired ? "border-red-300/60 hover:bg-red-400/20" : "border-amber-300/60 hover:bg-amber-400/20"
        }`}
      >
        Reconnect Schwab
      </a>
    </div>
  );
}
