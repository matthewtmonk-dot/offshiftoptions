import Link from "next/link";
import { ArrowLeft } from "lucide-react";
import { Badge, Panel } from "@/components/ui";
import { requireCurrentUser } from "@/lib/auth";
import { getAlphaVantageConfigStatus } from "@/providers/alpha-vantage/config";
import { AlphaVantageDiagnosticPanel } from "./alpha-vantage-diagnostic-panel";

export const dynamic = "force-dynamic";

export default async function AlphaVantageFundamentalsDiagnosticPage() {
  await requireCurrentUser();
  const configStatus = getAlphaVantageConfigStatus();

  return (
    <div className="space-y-6" data-testid="alpha-vantage-fundamentals-diagnostic">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
        <div>
          <p className="text-sm font-medium text-sky-300">Temporary engineering diagnostic</p>
          <h1 className="text-3xl font-semibold text-zinc-50">Alpha Vantage Fundamental Fields</h1>
          <p className="mt-2 max-w-3xl text-sm text-zinc-400">
            Checks APLD, RIOT, and CORZ against Alpha Vantage&apos;s OVERVIEW endpoint using OSO&apos;s shared server-side API key. The
            table is a strict allowlist and does not save anything to Research, Scanner, Tracker, or accounts. This is a shared, low
            free-tier quota (25 requests/day) - the run only happens when you click a button below.
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

      {configStatus.configured ? (
        <AlphaVantageDiagnosticPanel />
      ) : (
        <Panel title="Diagnostic Unavailable">
          <div className="flex items-start gap-3 text-sm text-zinc-300">
            <Badge tone="warn">Not configured</Badge>
            <p>ALPHA_VANTAGE_API_KEY is not set on the server. Add it to the production environment before running this diagnostic.</p>
          </div>
        </Panel>
      )}
    </div>
  );
}
