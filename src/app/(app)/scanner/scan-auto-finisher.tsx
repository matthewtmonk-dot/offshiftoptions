"use client";

import { Loader2 } from "lucide-react";
import { useRouter } from "next/navigation";
import { useEffect, useRef, useState } from "react";
import { checkMoreScannerOptionsAction } from "../actions";
import { refreshCompanyQualityAction } from "./company-quality-actions";
import { MAX_ROWS_PER_CLICK, runOptionCheckLoop } from "./option-check-loop";
import { nextFinishStep, type FinishStep } from "./scan-finish-plan";

const ATTEMPTS_KEY = "oso.scan.autofinish.v1";
const MAX_QUALITY_ROUNDS = 12;
const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

type Status =
  | { kind: "idle" }
  | { kind: "pricing"; checked: number; target: number }
  | { kind: "quality"; done: number; total: number }
  | { kind: "note"; message: string };

function readAttempts(): string[] {
  try {
    const raw = window.sessionStorage.getItem(ATTEMPTS_KEY);
    const parsed = raw ? (JSON.parse(raw) as unknown) : [];
    return Array.isArray(parsed) ? parsed.filter((value): value is string => typeof value === "string").slice(-40) : [];
  } catch {
    return [];
  }
}

function rememberAttempt(signature: string) {
  try {
    window.sessionStorage.setItem(ATTEMPTS_KEY, JSON.stringify([...readAttempts(), signature].slice(-40)));
  } catch {
    // Storage unavailable (private window): the attempt still runs, it just may repeat once on reload.
  }
}

/**
 * Finishes the latest live scan without any button presses: prices the options of every stock that passed the screen
 * but was not priced yet, then reads company quality (SEC filings) for the names worth a look, then refreshes the page
 * so the picks are built from the complete scan. The same read-only, rate-paced server actions the manual buttons use.
 * Each step runs at most once per scan per browser tab, so a step that cannot finish (Schwab not answering, a company
 * with no SEC filings) never loops. Leaving the page stops it.
 */
export function ScanAutoFinisher({ runId, awaitingOptionCheck, qualityTickers, enabled }: { runId: string | null; awaitingOptionCheck: number; qualityTickers: string[]; enabled: boolean }) {
  const router = useRouter();
  const [status, setStatus] = useState<Status>({ kind: "idle" });
  const busy = useRef(false);
  const stopped = useRef(false);

  useEffect(() => {
    stopped.current = false;
    return () => {
      stopped.current = true;
    };
  }, []);

  const step: FinishStep | null = enabled && runId ? nextFinishStep({ runId, awaitingOptionCheck, qualityTickers }) : null;
  const signature = step?.signature ?? null;

  useEffect(() => {
    if (!step || busy.current) return;
    if (readAttempts().includes(step.signature)) return;
    busy.current = true;
    // Recorded only once the step has actually ended (finished, capped or failed) - an interrupted run (page left,
    // tab closed) is resumed on the next visit; a step that ended without progress is never repeated automatically.
    const finish = () => rememberAttempt(step.signature);
    void (async () => {
      // Yield first so no state is set synchronously inside the effect.
      await Promise.resolve();
      try {
        if (step.kind === "price-options") {
          setStatus({ kind: "pricing", checked: 0, target: Math.min(step.count, MAX_ROWS_PER_CLICK) });
          const outcome = await runOptionCheckLoop({
            awaiting: step.count,
            checkBatch: checkMoreScannerOptionsAction,
            sleep,
            shouldStop: () => stopped.current,
            onProgress: ({ checked, target }) => {
              if (!stopped.current) setStatus({ kind: "pricing", checked, target });
            },
          });
          if (stopped.current) return;
          finish();
          if (outcome.status === "error") {
            setStatus({ kind: "note", message: `Option pricing stopped: ${outcome.message} The Check options button under Scan details retries.` });
            return;
          }
          setStatus(outcome.note ? { kind: "note", message: outcome.note } : { kind: "idle" });
        } else {
          let done = 0;
          setStatus({ kind: "quality", done, total: step.tickers.length });
          for (let round = 0; round < MAX_QUALITY_ROUNDS && !stopped.current; round += 1) {
            const outcome = await refreshCompanyQualityAction(step.tickers);
            if (!outcome.ok) {
              finish();
              setStatus({ kind: "note", message: `Company-quality check stopped: ${outcome.error}` });
              return;
            }
            done += outcome.processed;
            if (!stopped.current) setStatus({ kind: "quality", done, total: step.tickers.length });
            if (outcome.remaining === 0 || outcome.processed === 0) break;
          }
          if (stopped.current) return;
          finish();
          setStatus({ kind: "idle" });
        }
        router.refresh();
      } catch {
        finish();
        if (!stopped.current) setStatus({ kind: "note", message: "Couldn't finish the scan automatically. Use the buttons under Scan details." });
      } finally {
        busy.current = false;
      }
    })();
    // The signature captures everything the step depends on; re-running only when it changes is intentional.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [signature]);

  if (status.kind === "idle") return null;
  if (status.kind === "note") {
    return <span data-testid="scan-autofinish" className="text-xs text-amber-300">{status.message}</span>;
  }
  return (
    <span data-testid="scan-autofinish" role="status" className="inline-flex items-center gap-1.5 text-xs text-sky-200">
      <Loader2 className="size-3.5 motion-safe:animate-spin" aria-hidden />
      {status.kind === "pricing"
        ? `Finishing the scan: pricing options ${status.checked} of ${status.target}…`
        : `Finishing the scan: checking company quality ${status.done} of ${status.total}…`}
    </span>
  );
}
