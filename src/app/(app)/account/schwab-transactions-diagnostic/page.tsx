import Link from "next/link";
import { ArrowLeft } from "lucide-react";
import { requireCurrentUser } from "@/lib/auth";
import { DiagnosticPanel } from "./diagnostic-panel";
import { BrokerRecordClassificationPanel } from "./broker-record-classification-panel";
import { RepairPanel } from "./repair-panel";
import { CampaignEventSequencePanel } from "./campaign-event-sequence-panel";

export const dynamic = "force-dynamic";

export default async function SchwabTransactionsDiagnosticPage() {
  await requireCurrentUser();

  return (
    <div className="space-y-6" data-testid="schwab-transactions-diagnostic">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
        <div>
          <p className="text-sm font-medium text-sky-300">Temporary engineering diagnostic</p>
          <h1 className="text-3xl font-semibold text-zinc-50">Schwab Transactions &amp; Orders</h1>
          <p className="mt-2 max-w-3xl text-sm text-zinc-400">
            Read-only, on-demand checks against your own Schwab connection: transaction history across a few date
            windows and type filters, and a sanitized summary of filled option orders. Nothing runs until you click
            below, and nothing is saved to Positions, Tracker, or Campaigns.
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

      <DiagnosticPanel />

      <div className="space-y-3 border-t border-zinc-800 pt-6">
        <div>
          <h2 className="text-xl font-semibold text-zinc-50">Broker Record Classifications</h2>
          <p className="mt-1 max-w-3xl text-sm text-zinc-400">
            Shows how your already-synced Schwab transactions are classified right now, straight from the database -
            no live Schwab call needed. Use this to see exactly why a real trade isn&apos;t becoming a campaign.
          </p>
        </div>
        <BrokerRecordClassificationPanel />
      </div>

      <div className="space-y-3 border-t border-zinc-800 pt-6">
        <div>
          <h2 className="text-xl font-semibold text-zinc-50">Campaign Event Sequences</h2>
          <p className="mt-1 max-w-3xl text-sm text-zinc-400">
            Shows the exact stored event sequence for each of your campaigns, straight from the database - use this
            to see exactly which event (and which source record) changed a campaign&apos;s status.
          </p>
        </div>
        <CampaignEventSequencePanel />
      </div>

      <div className="space-y-3 border-t border-zinc-800 pt-6">
        <RepairPanel />
      </div>
    </div>
  );
}
