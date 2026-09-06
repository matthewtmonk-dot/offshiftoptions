"use client";

import { useState } from "react";
import { RefreshCw, TriangleAlert } from "lucide-react";
import { Badge, Panel } from "@/components/ui";
import { previewSchwabRecordRepairAction, repairSchwabRecordsAction } from "../../actions";
import type { SchwabRecordRepairPreview } from "@/lib/schwab-record-repair";

type PanelState =
  | { status: "idle" }
  | { status: "previewing" }
  | { status: "previewed"; preview: SchwabRecordRepairPreview }
  | { status: "repairing"; preview: SchwabRecordRepairPreview }
  | { status: "repaired"; deletedCount: number }
  | { status: "error"; message: string };

/**
 * Two-step, dry-run-first repair for the malformed, unlinked Schwab TRANSACTION records the old
 * normalizer produced (see previewMalformedSchwabTransactionRepairForUser /
 * repairMalformedSchwabTransactionRecordsForUser in src/lib/schwab-record-repair.ts). The delete
 * button only ever appears - and only ever deletes the exact count shown - after a preview has
 * loaded, so a click can never happen blind against an unseen count.
 */
export function RepairPanel() {
  const [state, setState] = useState<PanelState>({ status: "idle" });

  async function runPreview() {
    setState({ status: "previewing" });
    try {
      const preview = await previewSchwabRecordRepairAction();
      setState({ status: "previewed", preview });
    } catch {
      setState({ status: "error", message: "Preview failed unexpectedly." });
    }
  }

  async function runRepair(preview: SchwabRecordRepairPreview) {
    setState({ status: "repairing", preview });
    try {
      const result = await repairSchwabRecordsAction(preview.matchToken);
      setState({ status: "repaired", deletedCount: result.deletedCount });
    } catch (error) {
      setState({ status: "error", message: error instanceof Error ? error.message : "Repair failed unexpectedly." });
    }
  }

  const previewing = state.status === "previewing";
  const repairing = state.status === "repairing";

  return (
    <Panel title="Danger Zone - Repair Malformed Records">
      <p className="mb-3 text-xs text-zinc-500">
        Deletes only your own unlinked, unresolved Schwab transaction records that carry the exact malformed
        signature the old normalizer produced (a null action - never a confirmed, linked, or CSV-imported row). Do
        not run this until you have reviewed Diagnostic D above. Run a corrected Sync only after this repair
        completes.
      </p>

      <button
        type="button"
        onClick={runPreview}
        disabled={previewing || repairing}
        data-testid="preview-schwab-repair-button"
        className="inline-flex min-h-9 items-center justify-center gap-2 rounded-md border border-zinc-700 px-3 text-sm font-medium text-zinc-200 transition hover:border-zinc-500 disabled:cursor-wait disabled:opacity-75"
      >
        <RefreshCw className={`size-3.5 ${previewing ? "motion-safe:animate-spin" : ""}`} aria-hidden />
        {previewing ? "Previewing…" : "Preview repair (read-only)"}
      </button>

      {state.status === "error" ? (
        <p className="mt-3 text-sm text-red-300">{state.message}</p>
      ) : null}

      {state.status === "previewed" || state.status === "repairing" ? (
        <div className="mt-4 space-y-3 rounded-md border border-amber-400/30 bg-amber-400/10 p-3">
          <div className="flex items-center gap-2">
            <TriangleAlert className="size-4 text-amber-200" aria-hidden />
            <p className="text-sm font-medium text-amber-100">{state.preview.totalMatched} record(s) would be deleted</p>
          </div>
          <dl className="grid gap-3 text-sm sm:grid-cols-2">
            <div>
              <dt className="text-xs uppercase tracking-normal text-zinc-500">Cash-leg misidentified (symbol was CURRENCY_USD)</dt>
              <dd className="mt-1 font-medium text-zinc-100">{state.preview.countsByCategory.CASH_LEG_MISIDENTIFIED}</dd>
            </div>
            <div>
              <dt className="text-xs uppercase tracking-normal text-zinc-500">Unrecognized activity (e.g. expiration removal)</dt>
              <dd className="mt-1 font-medium text-zinc-100">{state.preview.countsByCategory.UNRECOGNIZED_ACTIVITY}</dd>
            </div>
          </dl>
          {state.preview.safetyCapExceeded ? (
            <Badge tone="bad">Exceeds safety cap - repair will refuse to run. Investigate before proceeding.</Badge>
          ) : state.preview.totalMatched === 0 ? (
            <p className="text-sm text-zinc-400">Nothing to repair.</p>
          ) : (
            <button
              type="button"
              onClick={() => runRepair(state.preview)}
              disabled={repairing}
              data-testid="confirm-schwab-repair-button"
              className="inline-flex min-h-9 items-center justify-center gap-2 rounded-md border border-red-400/50 bg-red-400/10 px-3 text-sm font-semibold text-red-100 transition hover:border-red-300 hover:bg-red-400/15 disabled:cursor-wait disabled:opacity-75"
            >
              {repairing ? "Deleting…" : `Confirm and delete ${state.preview.totalMatched} record(s)`}
            </button>
          )}
        </div>
      ) : null}

      {state.status === "repaired" ? (
        <p className="mt-3 text-sm text-emerald-300">
          Deleted {state.deletedCount} malformed record(s). Run a corrected Sync from the Account page now.
        </p>
      ) : null}
    </Panel>
  );
}
