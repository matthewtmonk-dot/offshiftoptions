"use client";

import { useState } from "react";
import { RefreshCw } from "lucide-react";
import { Badge, Panel } from "@/components/ui";
import { runBrokerRecordClassificationDiagnosticAction } from "../../actions";
import type { BrokerRecordClassificationReport, BrokerRecordCategory } from "@/lib/broker-record-classification-diagnostic";

type PanelState =
  | { status: "idle" }
  | { status: "pending" }
  | { status: "done"; report: BrokerRecordClassificationReport }
  | { status: "unexpected-error" };

const CATEGORY_LABEL: Record<BrokerRecordCategory, string> = {
  ALREADY_LINKED: "Already linked",
  CAMPAIGN_READY: "Campaign-ready",
  EXPIRATION_EVIDENCE: "Expiration/assignment evidence",
  NON_CAMPAIGN_ACTIVITY: "Non-campaign account activity",
  NEEDS_REVIEW: "Needs manual review",
};

const CATEGORY_TONE: Record<BrokerRecordCategory, "good" | "info" | "neutral" | "bad" | "warn"> = {
  ALREADY_LINKED: "info",
  CAMPAIGN_READY: "good",
  EXPIRATION_EVIDENCE: "warn",
  NON_CAMPAIGN_ACTIVITY: "neutral",
  NEEDS_REVIEW: "bad",
};

export function BrokerRecordClassificationPanel() {
  const [state, setState] = useState<PanelState>({ status: "idle" });
  const pending = state.status === "pending";

  async function run() {
    if (pending) {
      return;
    }
    setState({ status: "pending" });
    try {
      const report = await runBrokerRecordClassificationDiagnosticAction();
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
          aria-describedby="broker-record-classification-status"
          data-testid="run-broker-record-classification-button"
          className="inline-flex min-h-9 w-fit items-center justify-center gap-2 rounded-md border border-sky-400/40 bg-sky-400/10 px-3 text-sm font-medium text-sky-100 transition hover:border-sky-300 hover:bg-sky-400/15 disabled:cursor-wait disabled:opacity-75"
        >
          <RefreshCw className={`size-3.5 ${pending ? "motion-safe:animate-spin" : ""}`} aria-hidden />
          {pending ? "Loading…" : "Show My Broker Record Classifications"}
        </button>
        <div id="broker-record-classification-status" aria-live="polite" className="text-xs empty:hidden">
          {pending ? <span className="text-zinc-500">Reading your already-persisted Schwab records from the database…</span> : null}
          {state.status === "unexpected-error" ? (
            <span className="text-red-300">
              Failed unexpectedly.{" "}
              <button type="button" onClick={run} className="underline underline-offset-2 hover:text-red-100">
                Retry
              </button>
            </span>
          ) : null}
        </div>
      </div>

      {state.status === "done" ? <ClassificationReport report={state.report} /> : null}
    </div>
  );
}

function ClassificationReport({ report }: { report: BrokerRecordClassificationReport }) {
  return (
    <>
      <Panel title="Run Summary">
        <div className="flex flex-wrap gap-2">
          <Badge tone="info">No Schwab connection needed</Badge>
          <Badge tone="good">Read only</Badge>
          <Badge tone="neutral">Nothing saved</Badge>
        </div>
        <dl className="mt-3 grid gap-3 text-sm sm:grid-cols-3 lg:grid-cols-6">
          <SummaryDatum label="Total transactions" value={String(report.totalRecords)} />
          <SummaryDatum label="Already linked" value={String(report.countsByCategory.ALREADY_LINKED)} />
          <SummaryDatum label="Campaign-ready" value={String(report.countsByCategory.CAMPAIGN_READY)} />
          <SummaryDatum label="Expiration/assignment evidence" value={String(report.countsByCategory.EXPIRATION_EVIDENCE)} />
          <SummaryDatum label="Non-campaign activity" value={String(report.countsByCategory.NON_CAMPAIGN_ACTIVITY)} />
          <SummaryDatum label="Needs manual review" value={String(report.countsByCategory.NEEDS_REVIEW)} />
        </dl>
      </Panel>

      <Panel title="Transaction Classifications">
        <div className="overflow-x-auto">
          <table className="min-w-[1000px] w-full border-separate border-spacing-0 text-left text-sm">
            <thead>
              <tr className="text-xs uppercase tracking-normal text-zinc-500">
                <th className="border-b border-zinc-800 px-3 py-2 font-medium">Ticker</th>
                <th className="border-b border-zinc-800 px-3 py-2 font-medium">Put/Call</th>
                <th className="border-b border-zinc-800 px-3 py-2 font-medium">Strike</th>
                <th className="border-b border-zinc-800 px-3 py-2 font-medium">Expiration</th>
                <th className="border-b border-zinc-800 px-3 py-2 font-medium">Qty</th>
                <th className="border-b border-zinc-800 px-3 py-2 font-medium">Normalized action</th>
                <th className="border-b border-zinc-800 px-3 py-2 font-medium">Description</th>
                <th className="border-b border-zinc-800 px-3 py-2 font-medium">Price</th>
                <th className="border-b border-zinc-800 px-3 py-2 font-medium">Fee known?</th>
                <th className="border-b border-zinc-800 px-3 py-2 font-medium">Classification</th>
                <th className="border-b border-zinc-800 px-3 py-2 font-medium">Category</th>
              </tr>
            </thead>
            <tbody>
              {report.records.map((record, index) => (
                <tr key={index} className="align-top">
                  <td className="border-b border-zinc-900 px-3 py-2">{record.ticker ?? "—"}</td>
                  <td className="border-b border-zinc-900 px-3 py-2">{record.putCall ?? "—"}</td>
                  <td className="border-b border-zinc-900 px-3 py-2">{record.strike ?? "—"}</td>
                  <td className="border-b border-zinc-900 px-3 py-2">{record.expiration ?? "—"}</td>
                  <td className="border-b border-zinc-900 px-3 py-2">{record.quantity ?? "—"}</td>
                  <td className="border-b border-zinc-900 px-3 py-2">{record.normalizedAction ?? "—"}</td>
                  <td className="border-b border-zinc-900 px-3 py-2">{record.description ?? "—"}</td>
                  <td className="border-b border-zinc-900 px-3 py-2">{record.price ?? "—"}</td>
                  <td className="border-b border-zinc-900 px-3 py-2">{record.feeKnown ? "Yes" : "No"}</td>
                  <td className="border-b border-zinc-900 px-3 py-2">{record.classification}</td>
                  <td className="border-b border-zinc-900 px-3 py-2">
                    <div className="flex flex-col gap-1">
                      <Badge tone={CATEGORY_TONE[record.category]}>{CATEGORY_LABEL[record.category]}</Badge>
                      {record.reason ? <span className="text-xs text-zinc-500">{record.reason}</span> : null}
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        {report.records.length === 0 ? <p className="text-sm text-zinc-400">No Schwab transactions found for your account yet.</p> : null}
      </Panel>
    </>
  );
}

function SummaryDatum({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <dt className="text-xs uppercase tracking-normal text-zinc-500">{label}</dt>
      <dd className="mt-1 break-words font-medium text-zinc-100">{value}</dd>
    </div>
  );
}
