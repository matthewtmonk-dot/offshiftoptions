"use client";

import { useState } from "react";
import { RefreshCw, TriangleAlert } from "lucide-react";
import { Badge, Panel } from "@/components/ui";
import { previewCampaignHistoryRepairAction, repairCampaignHistoryAction } from "../../actions";
import type { CampaignHistoryRepairPreview } from "@/lib/campaign-history-repair";

type PanelState =
  | { status: "idle" }
  | { status: "previewing" }
  | { status: "previewed"; preview: CampaignHistoryRepairPreview }
  | { status: "repairing"; preview: CampaignHistoryRepairPreview }
  | { status: "repaired"; repairedCount: number }
  | { status: "error"; message: string };

/**
 * Two-step, dry-run-first, token-locked repair for campaigns the premature-expiration-close bug
 * incorrectly marked CLOSED via a $0 CLOSE_PUT event created from a misclassified Schwab
 * expiration-removal record (see previewCampaignHistoryRepairForUser /
 * repairCampaignHistoryForUser in src/lib/campaign-history-repair.ts). The confirm button only
 * ever appears - and only ever repairs the exact set shown - after a preview has loaded; the
 * repair itself re-verifies the live matching set at mutation time and refuses if it changed.
 */
export function CampaignHistoryRepairPanel() {
  const [state, setState] = useState<PanelState>({ status: "idle" });

  async function runPreview() {
    setState({ status: "previewing" });
    try {
      const preview = await previewCampaignHistoryRepairAction();
      setState({ status: "previewed", preview });
    } catch {
      setState({ status: "error", message: "Preview failed unexpectedly." });
    }
  }

  async function runRepair(preview: CampaignHistoryRepairPreview) {
    setState({ status: "repairing", preview });
    try {
      const result = await repairCampaignHistoryAction(preview.matchToken);
      setState({ status: "repaired", repairedCount: result.repairedCount });
    } catch (error) {
      setState({ status: "error", message: error instanceof Error ? error.message : "Repair failed unexpectedly." });
    }
  }

  const previewing = state.status === "previewing";
  const repairing = state.status === "repairing";

  return (
    <Panel title="Danger Zone - Repair Premature Expiration Closes">
      <p className="mb-3 text-xs text-zinc-500">
        Restores campaigns to OPEN/Expiration Processing only when ALL of the following hold: a CASH_SECURED_PUT
        campaign on your own Schwab account, closed by exactly one $0-premium CLOSE_PUT event with no other
        activity, and exactly one linked Schwab record whose own description proves it is real expiration-removal
        evidence the old normalizer mislabeled as Buy to Close - never a real trade. That record is corrected in
        place (relabeled and unlinked), never deleted. A valid roll, a real Buy to Close, or any ambiguous history
        never qualifies. Run a corrected Sync only after this repair completes.
      </p>

      <button
        type="button"
        onClick={runPreview}
        disabled={previewing || repairing}
        data-testid="preview-campaign-history-repair-button"
        className="inline-flex min-h-9 items-center justify-center gap-2 rounded-md border border-zinc-700 px-3 text-sm font-medium text-zinc-200 transition hover:border-zinc-500 disabled:cursor-wait disabled:opacity-75"
      >
        <RefreshCw className={`size-3.5 ${previewing ? "motion-safe:animate-spin" : ""}`} aria-hidden />
        {previewing ? "Previewing…" : "Preview repair (read-only)"}
      </button>

      {state.status === "error" ? <p className="mt-3 text-sm text-red-300">{state.message}</p> : null}

      {state.status === "previewed" || state.status === "repairing" ? (
        <div className="mt-4 space-y-3 rounded-md border border-amber-400/30 bg-amber-400/10 p-3">
          <div className="flex items-center gap-2">
            <TriangleAlert className="size-4 text-amber-200" aria-hidden />
            <p className="text-sm font-medium text-amber-100">{state.preview.totalMatched} campaign(s) would be repaired</p>
          </div>

          {state.preview.candidates.length > 0 ? (
            <div className="overflow-x-auto">
              <table className="min-w-[700px] w-full border-separate border-spacing-0 text-left text-sm">
                <thead>
                  <tr className="text-xs uppercase tracking-normal text-zinc-500">
                    <th className="border-b border-zinc-800 px-3 py-2 font-medium">Ticker</th>
                    <th className="border-b border-zinc-800 px-3 py-2 font-medium">Current status</th>
                    <th className="border-b border-zinc-800 px-3 py-2 font-medium">Event sequence</th>
                    <th className="border-b border-zinc-800 px-3 py-2 font-medium">Bad event</th>
                    <th className="border-b border-zinc-800 px-3 py-2 font-medium">Source classification</th>
                    <th className="border-b border-zinc-800 px-3 py-2 font-medium">Proposed action</th>
                  </tr>
                </thead>
                <tbody>
                  {state.preview.candidates.map((candidate, index) => (
                    <tr key={index}>
                      <td className="border-b border-zinc-900 px-3 py-2 font-medium text-zinc-100">{candidate.ticker}</td>
                      <td className="border-b border-zinc-900 px-3 py-2">{candidate.currentStatus}</td>
                      <td className="border-b border-zinc-900 px-3 py-2">{candidate.eventSequence.join(" → ")}</td>
                      <td className="border-b border-zinc-900 px-3 py-2">{candidate.badEventType}</td>
                      <td className="border-b border-zinc-900 px-3 py-2">{candidate.sourceClassification}</td>
                      <td className="border-b border-zinc-900 px-3 py-2 text-xs text-zinc-400">{candidate.proposedAction}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ) : null}

          {state.preview.safetyCapExceeded ? (
            <Badge tone="bad">Exceeds safety cap - repair will refuse to run. Investigate before proceeding.</Badge>
          ) : state.preview.totalMatched === 0 ? (
            <p className="text-sm text-zinc-400">Nothing to repair.</p>
          ) : (
            <button
              type="button"
              onClick={() => runRepair(state.preview)}
              disabled={repairing}
              data-testid="confirm-campaign-history-repair-button"
              className="inline-flex min-h-9 items-center justify-center gap-2 rounded-md border border-red-400/50 bg-red-400/10 px-3 text-sm font-semibold text-red-100 transition hover:border-red-300 hover:bg-red-400/15 disabled:cursor-wait disabled:opacity-75"
            >
              {repairing ? "Repairing…" : `Confirm and repair ${state.preview.totalMatched} campaign(s)`}
            </button>
          )}
        </div>
      ) : null}

      {state.status === "repaired" ? (
        <p className="mt-3 text-sm text-emerald-300">
          Repaired {state.repairedCount} campaign(s). Run a corrected Sync from the Account page now.
        </p>
      ) : null}
    </Panel>
  );
}
