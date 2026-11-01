import Link from "next/link";
import { ArrowLeft } from "lucide-react";
import { requireCurrentUser } from "@/lib/auth";
import { BalancesPanel } from "./balances-panel";

export const dynamic = "force-dynamic";

export default async function SchwabBalancesPage() {
  await requireCurrentUser();

  return (
    <div className="space-y-6" data-testid="schwab-balances-diagnostic">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
        <div>
          <p className="text-sm font-medium text-sky-300">Temporary engineering diagnostic</p>
          <h1 className="text-3xl font-semibold text-zinc-50">Schwab Balances</h1>
          <p className="mt-2 max-w-3xl text-sm text-zinc-400">
            Read-only. Shows every balance figure Schwab reports for your account so we can find the one that matches
            thinkorswim&apos;s &quot;Available for Trading&quot; before any trade recommendation relies on it. Nothing runs until you click, and
            nothing is saved. No account number or positions are shown.
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

      <BalancesPanel />
    </div>
  );
}
