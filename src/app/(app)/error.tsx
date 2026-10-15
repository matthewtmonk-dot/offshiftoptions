"use client";

import Link from "next/link";
import { useEffect } from "react";

/**
 * Catches an unexpected error on any signed-in page and shows a plain message INSIDE the app (sidebar
 * and navigation stay), instead of Next's blank "This page couldn't load" screen. In production Next
 * hides the real error from the browser and supplies a short `digest` - shown here so it can be read back
 * and matched to the server log.
 */
export default function AppError({ error, reset }: { error: Error & { digest?: string }; reset: () => void }) {
  useEffect(() => {
    console.error("Page error", error.digest ?? "(no digest)");
  }, [error]);

  return (
    <div className="mx-auto max-w-xl space-y-4 rounded-lg border border-zinc-800 bg-zinc-900 p-6" role="alert" data-testid="app-error">
      <h1 className="text-xl font-semibold text-zinc-50">Something went wrong loading this page</h1>
      <p className="text-sm text-zinc-300">
        Your data is safe. Try reloading. If the page was open for a while, a quick Ctrl+F5 (or closing and reopening the app) usually fixes it after an update.
      </p>
      {error.digest ? (
        <p className="text-xs text-zinc-500">
          If it keeps happening, tell Claude this reference: <span className="font-mono text-zinc-300">{error.digest}</span>
        </p>
      ) : null}
      <div className="flex flex-wrap gap-2">
        <button type="button" onClick={reset} className="min-h-10 rounded-md bg-emerald-400 px-4 text-sm font-semibold text-black hover:bg-emerald-300">
          Try again
        </button>
        <Link href="/dashboard" className="inline-flex min-h-10 items-center rounded-md border border-zinc-700 px-4 text-sm font-medium text-zinc-200 hover:border-zinc-500">
          Go to Dashboard
        </Link>
        <Link href="/account/diagnostics" className="inline-flex min-h-10 items-center rounded-md border border-zinc-700 px-4 text-sm font-medium text-zinc-400 hover:border-zinc-500">
          Diagnostics
        </Link>
      </div>
    </div>
  );
}
