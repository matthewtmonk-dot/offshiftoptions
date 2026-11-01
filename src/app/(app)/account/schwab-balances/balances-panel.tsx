"use client";

import { useState } from "react";
import { RefreshCw } from "lucide-react";
import { Panel } from "@/components/ui";
import { shortDateTime } from "@/lib/format";
import { runSchwabBalancesDiagnosticAction } from "../../actions";
import type { SchwabBalancesDiagnosticResult } from "@/lib/schwab-balances-diagnostic";
import type { BalanceField } from "@/providers/schwab/balances-diagnostic";

type PanelState =
  | { status: "idle" }
  | { status: "pending" }
  | { status: "done"; result: SchwabBalancesDiagnosticResult }
  | { status: "unexpected-error" };

const dollars = new Intl.NumberFormat("en-US", { style: "currency", currency: "USD" });

export function BalancesPanel() {
  const [state, setState] = useState<PanelState>({ status: "idle" });
  const pending = state.status === "pending";

  async function run() {
    if (pending) return;
    setState({ status: "pending" });
    try {
      setState({ status: "done", result: await runSchwabBalancesDiagnosticAction() });
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
          data-testid="run-schwab-balances-button"
          className="inline-flex min-h-9 w-fit items-center justify-center gap-2 rounded-md border border-sky-400/40 bg-sky-400/10 px-3 text-sm font-medium text-sky-100 transition hover:border-sky-300 hover:bg-sky-400/15 disabled:cursor-wait disabled:opacity-75"
        >
          <RefreshCw className={`size-3.5 ${pending ? "motion-safe:animate-spin" : ""}`} aria-hidden />
          {pending ? "Reading…" : "Show my Schwab balances"}
        </button>
        <div aria-live="polite" className="text-xs empty:hidden">
          {state.status === "unexpected-error" ? <span className="text-red-300">The check failed unexpectedly. Try again.</span> : null}
        </div>
      </div>

      {state.status === "done" ? <Result result={state.result} /> : null}
    </div>
  );
}

function Result({ result }: { result: SchwabBalancesDiagnosticResult }) {
  if (result.status !== "OK") {
    return (
      <Panel title={result.label}>
        <p className="text-sm text-zinc-300">{result.message}</p>
      </Panel>
    );
  }
  const { balances } = result;
  if (balances.malformedResponse) {
    return (
      <Panel title="Unexpected answer from Schwab">
        <p className="text-sm text-zinc-300">Schwab answered, but not with the account details this check expects. Nothing was saved.</p>
      </Panel>
    );
  }
  return (
    <div className="space-y-4">
      <p className="text-xs text-zinc-500">
        Read from Schwab {shortDateTime(new Date(result.timestamp))}. Account type: <span className="text-zinc-300">{balances.accountType ?? "not reported"}</span>. Nothing was saved.
      </p>
      <Fields title="Current balances" fields={balances.current} />
      <Fields title="Start-of-day balances" fields={balances.initial} />
      <Fields title="Projected balances" fields={balances.projected} />
    </div>
  );
}

function Fields({ title, fields }: { title: string; fields: BalanceField[] }) {
  if (!fields.length) return null;
  return (
    <Panel title={title}>
      <dl className="grid gap-x-6 gap-y-1 text-sm sm:grid-cols-2">
        {fields.map((field) => (
          <div key={field.name} className="flex items-baseline justify-between gap-3 border-b border-zinc-800/60 py-1">
            <dt className="font-mono text-xs text-zinc-400">{field.name}</dt>
            <dd className="text-zinc-100">{dollars.format(field.value)}</dd>
          </div>
        ))}
      </dl>
    </Panel>
  );
}
