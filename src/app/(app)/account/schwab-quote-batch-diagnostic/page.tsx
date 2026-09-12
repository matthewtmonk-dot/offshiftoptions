import Link from "next/link";
import { ArrowLeft } from "lucide-react";
import { requireCurrentUser } from "@/lib/auth";
import { LatestCandleFreshnessPanel } from "./latest-candle-freshness-panel";
import { QuoteBatchDiagnosticPanel } from "./quote-batch-diagnostic-panel";
import { ScannerTickerComparisonPanel } from "./scanner-ticker-comparison-panel";
import { ScannerUniverseDryRunPanel } from "./scanner-universe-dry-run-panel";
import { TechnicalCachePanel } from "./technical-cache-panel";

export const dynamic = "force-dynamic";

export default async function SchwabQuoteBatchDiagnosticPage() {
  await requireCurrentUser();

  return (
    <div className="space-y-6" data-testid="schwab-quote-batch-diagnostic">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
        <div>
          <p className="text-sm font-medium text-sky-300">Temporary engineering diagnostics</p>
          <h1 className="text-3xl font-semibold text-zinc-50">Scanner Engineering Diagnostics</h1>
          <p className="mt-2 max-w-3xl text-sm text-zinc-400">
            Read-only, on-demand checks using your own connected Schwab market-data connection. Nothing runs until
            you click a button below, and nothing is saved.
          </p>
        </div>
        <Link
          href="/account"
          prefetch={false}
          className="inline-flex min-h-10 items-center justify-center gap-2 rounded-md border border-zinc-700 px-3 text-sm font-medium text-zinc-300 transition hover:border-zinc-500 hover:text-zinc-100"
        >
          <ArrowLeft className="size-4" aria-hidden />
          Account
        </Link>
      </div>

      <div className="space-y-3">
        <div>
          <h2 className="text-xl font-semibold text-zinc-50">Quote Batch Size</h2>
          <p className="mt-1 max-w-3xl text-sm text-zinc-400">
            How many symbols Schwab&apos;s quote endpoint actually accepts in one request. Tests 5, then 25, then
            50, then 100 symbols - one real HTTP call per size, stopping at the first failure. Market data only:
            never reads positions, transactions, orders, or campaigns.
          </p>
        </div>
        <QuoteBatchDiagnosticPanel />
      </div>

      <div className="space-y-3 border-t border-zinc-800 pt-6">
        <div>
          <h2 className="text-xl font-semibold text-zinc-50">Scanner Universe Dry Run</h2>
          <p className="mt-1 max-w-3xl text-sm text-zinc-400">
            Measures the real broad-universe funnel (Tier 1 + the public OCC cache) against your own live quotes:
            how many symbols quote successfully, how many survive your price/volume rules, and how many history
            requests a real broad scan would need. Never fetches price history or option chains, never creates a
            scan, never touches Research or campaign data.
          </p>
        </div>
        <ScannerUniverseDryRunPanel />
      </div>

      <div className="space-y-3 border-t border-zinc-800 pt-6">
        <div>
          <h2 className="text-xl font-semibold text-zinc-50">Technical Indicator Cache</h2>
          <p className="mt-1 max-w-3xl text-sm text-zinc-400">
            Your own user-scoped RSI/Bollinger Band cache, sourced only through your own Schwab connection - never
            shared with another user. Unlike the two diagnostics above, &quot;Warm Cache&quot; is not purely
            read-only: it fetches real price history for up to 25 symbols per click and persists the derived
            technical values so a future broad scan doesn&apos;t need to fetch history interactively. Not scheduled
            or wired into Run Live Scan yet.
          </p>
        </div>
        <TechnicalCachePanel />
      </div>

      <div className="space-y-3 border-t border-zinc-800 pt-6">
        <div>
          <h2 className="text-xl font-semibold text-zinc-50">Latest Candle Freshness</h2>
          <p className="mt-1 max-w-3xl text-sm text-zinc-400">
            For 5 deterministic public OCC symbols, fetches the same price history technical preparation itself uses
            and reports only whether the latest available daily candle is fresh enough right now. No raw candles or
            prices shown, no account data touched, nothing saved - at most 5 history requests.
          </p>
        </div>
        <LatestCandleFreshnessPanel />
      </div>

      <div className="space-y-3 border-t border-zinc-800 pt-6">
        <div>
          <h2 className="text-xl font-semibold text-zinc-50">Scanner Ticker Comparison</h2>
          <p className="mt-1 max-w-3xl text-sm text-zinc-400">
            For a small list of tickers you supply, reports whether each is in the universe, survives your
            price/volume rules on a fresh quote, has a current technical snapshot, and what your last live scan
            showed for it - without hunting the full results table. One bounded real quote per ticker (max 25),
            no history, no option chains, nothing saved.
          </p>
        </div>
        <ScannerTickerComparisonPanel />
      </div>
    </div>
  );
}
