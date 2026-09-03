"use client";

import { useState } from "react";
import { IntentPrefetchLink } from "@/components/intent-prefetch-link";

type TrackerScope = "mine" | "buddy" | "both";
type ViewMode = "open" | "history" | "performance" | "accounts";

const tabs: { mode: ViewMode; label: string }[] = [
  { mode: "open", label: "Open" },
  { mode: "history", label: "History" },
  { mode: "performance", label: "Performance" },
  { mode: "accounts", label: "Accounts" },
];

export function TrackerTabs({ scope, view }: { scope: TrackerScope; view: ViewMode }) {
  const [selection, setSelection] = useState({ serverView: view, clientView: view });
  const activeView = selection.serverView === view ? selection.clientView : view;

  return (
    <div className="inline-flex rounded-md border border-zinc-800 bg-zinc-950 p-1" data-testid="tracker-tabs">
      {tabs.map(({ mode, label }) => {
        const active = activeView === mode;
        const pending = active && view !== mode;
        return (
          <IntentPrefetchLink
            key={mode}
            href={trackerHref(scope, mode)}
            aria-current={active ? "page" : undefined}
            aria-busy={pending ? true : undefined}
            onClick={() => setSelection({ serverView: view, clientView: mode })}
            className={tabClass(active)}
          >
            {label}
            {pending ? <span className="ml-1.5 size-1.5 animate-pulse rounded-full bg-current" aria-hidden /> : null}
          </IntentPrefetchLink>
        );
      })}
    </div>
  );
}

function trackerHref(scope: TrackerScope, view: ViewMode) {
  const params = new URLSearchParams();
  params.set("scope", scope);
  if (view !== "open") {
    params.set("view", view);
  }
  return `/positions?${params.toString()}`;
}

function tabClass(active: boolean) {
  return `inline-flex items-center rounded px-3 py-1.5 text-sm transition ${
    active ? "bg-emerald-400 text-black" : "text-zinc-400 hover:bg-zinc-900 hover:text-zinc-100"
  }`;
}
