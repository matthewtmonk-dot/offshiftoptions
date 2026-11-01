"use client";

import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";
import { importEthicsResearchAction, setEthicsDecisionAction, type EthicsActionResult } from "../../actions";

function Result({ result }: { result: EthicsActionResult | null }) {
  if (!result) return null;
  return (
    <p aria-live="polite" className={`text-xs ${result.ok ? "text-emerald-300" : "text-red-300"}`}>
      {result.ok ? result.message : result.error}
    </p>
  );
}

/** Approve / Exclude / Under review (or clear) with an optional short note. The user's call is final. */
export function EthicsDecisionForm({ ticker, current }: { ticker: string; current: string | null }) {
  const router = useRouter();
  const [note, setNote] = useState("");
  const [result, setResult] = useState<EthicsActionResult | null>(null);
  const [pending, startTransition] = useTransition();

  function decide(decision: "APPROVED" | "EXCLUDED" | "UNDER_REVIEW" | "CLEAR") {
    startTransition(async () => {
      try {
        setResult(await setEthicsDecisionAction(ticker, decision, note));
        router.refresh();
      } catch {
        setResult({ ok: false, error: "Couldn't save that - reload the page and try again." });
      }
    });
  }

  const button = (decision: "APPROVED" | "EXCLUDED" | "UNDER_REVIEW", label: string, tone: string) => (
    <button
      type="button"
      disabled={pending}
      onClick={() => decide(decision)}
      aria-pressed={current === decision}
      className={`min-h-8 rounded-md border px-3 text-xs font-medium disabled:opacity-60 ${tone} ${current === decision ? "ring-1 ring-current" : ""}`}
    >
      {label}
    </button>
  );

  return (
    <div className="space-y-2" data-testid="ethics-decision-form">
      <div className="flex flex-wrap items-center gap-2">
        {button("APPROVED", "Approve", "border-emerald-400/40 bg-emerald-400/10 text-emerald-100 hover:bg-emerald-400/20")}
        {button("UNDER_REVIEW", "Under review", "border-amber-400/40 bg-amber-400/10 text-amber-100 hover:bg-amber-400/20")}
        {button("EXCLUDED", "Exclude", "border-red-400/40 bg-red-400/10 text-red-100 hover:bg-red-400/20")}
        {current ? (
          <button type="button" disabled={pending} onClick={() => decide("CLEAR")} className="text-xs text-zinc-400 underline underline-offset-2 hover:text-zinc-200">
            Clear my decision
          </button>
        ) : null}
      </div>
      <input
        value={note}
        onChange={(event) => setNote(event.target.value)}
        maxLength={500}
        placeholder="Optional note - why (kept with the decision)"
        aria-label={`Note for ${ticker} decision`}
        className="w-full rounded-md border border-zinc-800 bg-zinc-950 px-2 py-1.5 text-xs text-zinc-100 placeholder:text-zinc-600"
      />
      <Result result={result} />
    </div>
  );
}

/** Paste the research file Claude produced. Validated on the server; nothing is saved if any part is rejected. */
export function EthicsImportForm() {
  const router = useRouter();
  const [text, setText] = useState("");
  const [result, setResult] = useState<EthicsActionResult | null>(null);
  const [pending, startTransition] = useTransition();

  function submit() {
    startTransition(async () => {
      try {
        const outcome = await importEthicsResearchAction(text);
        setResult(outcome);
        if (outcome.ok) {
          setText("");
          router.refresh();
        }
      } catch {
        setResult({ ok: false, error: "Couldn't import that - reload the page and try again." });
      }
    });
  }

  return (
    <div className="space-y-2" data-testid="ethics-import-form">
      <textarea
        value={text}
        onChange={(event) => setText(event.target.value)}
        rows={8}
        spellCheck={false}
        placeholder='Paste the research file here ({"companies":[...]})'
        aria-label="Ethics research file"
        className="w-full rounded-md border border-zinc-800 bg-zinc-950 p-2 font-mono text-xs text-zinc-100 placeholder:text-zinc-600"
      />
      <div className="flex items-center gap-3">
        <button
          type="button"
          onClick={submit}
          disabled={pending || text.trim().length === 0}
          className="min-h-8 rounded-md border border-sky-400/40 bg-sky-400/10 px-3 text-xs font-medium text-sky-100 hover:bg-sky-400/20 disabled:opacity-50"
        >
          {pending ? "Importing…" : "Import research"}
        </button>
        <Result result={result} />
      </div>
    </div>
  );
}
