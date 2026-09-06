"use client";

import { useState } from "react";
import { RefreshCw } from "lucide-react";
import { Badge, Panel } from "@/components/ui";
import { shortDateTime } from "@/lib/format";
import { runCampaignEventSequenceDiagnosticAction } from "../../actions";
import type { CampaignEventSequenceReport } from "@/lib/campaign-event-sequence-diagnostic";

type PanelState =
  | { status: "idle" }
  | { status: "pending" }
  | { status: "done"; report: CampaignEventSequenceReport }
  | { status: "unexpected-error" };

export function CampaignEventSequencePanel() {
  const [state, setState] = useState<PanelState>({ status: "idle" });
  const pending = state.status === "pending";

  async function run() {
    if (pending) {
      return;
    }
    setState({ status: "pending" });
    try {
      const report = await runCampaignEventSequenceDiagnosticAction();
      setState({ status: "done", report });
    } catch {
      setState({ status: "unexpected-error" });
    }
  }

  return (
    <div className="space-y-6">
      <div className="flex flex-col gap-1">
        <button
          type="button"
          onClick={run}
          disabled={pending}
          data-testid="run-campaign-event-sequence-button"
          className="inline-flex min-h-9 w-fit items-center justify-center gap-2 rounded-md border border-sky-400/40 bg-sky-400/10 px-3 text-sm font-medium text-sky-100 transition hover:border-sky-300 hover:bg-sky-400/15 disabled:cursor-wait disabled:opacity-75"
        >
          <RefreshCw className={`size-3.5 ${pending ? "motion-safe:animate-spin" : ""}`} aria-hidden />
          {pending ? "Loading…" : "Show My Campaign Event Sequences"}
        </button>
        {state.status === "unexpected-error" ? (
          <span className="text-xs text-red-300">
            Failed unexpectedly.{" "}
            <button type="button" onClick={run} className="underline underline-offset-2 hover:text-red-100">
              Retry
            </button>
          </span>
        ) : null}
      </div>

      {state.status === "done" ? <SequenceReport report={state.report} /> : null}
    </div>
  );
}

function SequenceReport({ report }: { report: CampaignEventSequenceReport }) {
  if (report.campaigns.length === 0) {
    return (
      <Panel title="Campaign Event Sequences">
        <p className="text-sm text-zinc-400">No campaigns found.</p>
      </Panel>
    );
  }

  return (
    <>
      {report.campaigns.map((campaign, index) => (
        <Panel key={index} title={`${campaign.ticker} - ${campaign.status} (${campaign.currentStage})`}>
          <div className="mb-3 flex flex-wrap gap-2">
            <Badge tone="info">Strategy: {campaign.strategy}</Badge>
            <Badge tone={campaign.hasUnknownFee ? "warn" : "good"}>{campaign.hasUnknownFee ? "Has unresolved fee" : "All fees known"}</Badge>
          </div>
          <dl className="mb-3 grid gap-3 text-sm sm:grid-cols-3">
            <div>
              <dt className="text-xs uppercase tracking-normal text-zinc-500">Total premium received</dt>
              <dd className="mt-1 font-medium text-zinc-100">${campaign.totalPremiumReceived}</dd>
            </div>
            <div>
              <dt className="text-xs uppercase tracking-normal text-zinc-500">Option debits paid</dt>
              <dd className="mt-1 font-medium text-zinc-100">${campaign.optionDebitsPaid}</dd>
            </div>
            <div>
              <dt className="text-xs uppercase tracking-normal text-zinc-500">Realized P/L</dt>
              <dd className="mt-1 font-medium text-zinc-100">{campaign.realizedPL === null ? "—" : `$${campaign.realizedPL}`}</dd>
            </div>
          </dl>

          <p className="mb-2 text-xs font-medium uppercase tracking-normal text-zinc-500">Event sequence (chronological)</p>
          <div className="overflow-x-auto">
            <table className="min-w-[700px] w-full border-separate border-spacing-0 text-left text-sm">
              <thead>
                <tr className="text-xs uppercase tracking-normal text-zinc-500">
                  <th className="border-b border-zinc-800 px-3 py-2 font-medium">Event</th>
                  <th className="border-b border-zinc-800 px-3 py-2 font-medium">Date</th>
                  <th className="border-b border-zinc-800 px-3 py-2 font-medium">Strike</th>
                  <th className="border-b border-zinc-800 px-3 py-2 font-medium">Expiration</th>
                  <th className="border-b border-zinc-800 px-3 py-2 font-medium">Premium</th>
                  <th className="border-b border-zinc-800 px-3 py-2 font-medium">Cash amount</th>
                  <th className="border-b border-zinc-800 px-3 py-2 font-medium">Fee</th>
                </tr>
              </thead>
              <tbody>
                {campaign.events.map((event, eventIndex) => (
                  <tr key={eventIndex}>
                    <td className="border-b border-zinc-900 px-3 py-2 font-medium text-zinc-100">{event.type}</td>
                    <td className="border-b border-zinc-900 px-3 py-2">{shortDateTime(event.occurredAt)}</td>
                    <td className="border-b border-zinc-900 px-3 py-2">{event.strike ?? "—"}</td>
                    <td className="border-b border-zinc-900 px-3 py-2">{event.expiration ? shortDateTime(event.expiration) : "—"}</td>
                    <td className="border-b border-zinc-900 px-3 py-2">{event.premium ?? "—"}</td>
                    <td className="border-b border-zinc-900 px-3 py-2">{event.cashAmount ?? "—"}</td>
                    <td className="border-b border-zinc-900 px-3 py-2">${event.fees}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          {campaign.linkedRecords.length > 0 ? (
            <>
              <p className="mb-2 mt-4 text-xs font-medium uppercase tracking-normal text-zinc-500">Linked source records (classification)</p>
              <div className="overflow-x-auto">
                <table className="min-w-[500px] w-full border-separate border-spacing-0 text-left text-sm">
                  <thead>
                    <tr className="text-xs uppercase tracking-normal text-zinc-500">
                      <th className="border-b border-zinc-800 px-3 py-2 font-medium">Date</th>
                      <th className="border-b border-zinc-800 px-3 py-2 font-medium">Normalized action</th>
                      <th className="border-b border-zinc-800 px-3 py-2 font-medium">Classification</th>
                      <th className="border-b border-zinc-800 px-3 py-2 font-medium">Fee known?</th>
                    </tr>
                  </thead>
                  <tbody>
                    {campaign.linkedRecords.map((record, recordIndex) => (
                      <tr key={recordIndex}>
                        <td className="border-b border-zinc-900 px-3 py-2">{record.occurredAt ? shortDateTime(record.occurredAt) : "—"}</td>
                        <td className="border-b border-zinc-900 px-3 py-2">{record.normalizedAction ?? "—"}</td>
                        <td className="border-b border-zinc-900 px-3 py-2">{record.classification}</td>
                        <td className="border-b border-zinc-900 px-3 py-2">{record.feeKnown ? "Yes" : "No"}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </>
          ) : null}
        </Panel>
      ))}
    </>
  );
}
