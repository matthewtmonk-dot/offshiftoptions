"use client";

import Link from "next/link";
import { useState } from "react";
import { ethicsResearchRequest } from "@/domain/ethics/ethicsQueue";

/**
 * One quiet line under the picks: which names worth a look have no ethics research yet, with a button that copies a
 * ready-made research request. Research is done once per company and saved, so this line shrinks over time and
 * disappears when there is nothing to do.
 */
export function EthicsQueueLine({ tickers }: { tickers: string[] }) {
  const [copied, setCopied] = useState<"idle" | "done" | "failed">("idle");
  if (tickers.length === 0) return null;

  async function copy() {
    try {
      await navigator.clipboard.writeText(ethicsResearchRequest(tickers));
      setCopied("done");
    } catch {
      setCopied("failed");
    }
  }

  const shown = tickers.slice(0, 8).join(", ");
  const more = tickers.length > 8 ? ` +${tickers.length - 8} more` : "";
  return (
    <p data-testid="ethics-queue" className="flex flex-wrap items-center gap-x-2 gap-y-1 rounded-md border border-zinc-800 bg-zinc-900/30 px-3 py-2 text-xs text-zinc-400">
      <span>
        <span className="font-medium text-zinc-200">{tickers.length} not researched for ethics yet:</span> {shown}{more}
      </span>
      <button type="button" onClick={() => void copy()} className="underline underline-offset-2 hover:text-zinc-100">
        {copied === "done" ? "Copied - paste it to Claude" : "Copy research request"}
      </button>
      <Link href="/research/ethics" className="underline underline-offset-2 hover:text-zinc-100">Import results</Link>
      {copied === "failed" ? <span className="text-amber-300">Could not copy - the tickers are listed here.</span> : null}
    </p>
  );
}
