"use client";

import { useState } from "react";
import { IntentPrefetchLink } from "@/components/intent-prefetch-link";
import { segmentedGroupClass, segmentedItemClass } from "@/components/ui";

export type ScannerMode = "csp" | "covered-calls";

const tabs: { mode: ScannerMode; label: string }[] = [
  { mode: "csp", label: "Cash-Secured Puts" },
  { mode: "covered-calls", label: "Covered Calls" },
];

/** Mirrors positions/tracker-tabs.tsx's own link-based, searchParams-driven tab pattern. */
export function ScannerModeTabs({ mode }: { mode: ScannerMode }) {
  const [selection, setSelection] = useState({ serverMode: mode, clientMode: mode });
  const activeMode = selection.serverMode === mode ? selection.clientMode : mode;

  return (
    <div className={segmentedGroupClass} data-testid="scanner-mode-tabs">
      {tabs.map(({ mode: tabMode, label }) => {
        const active = activeMode === tabMode;
        const pending = active && mode !== tabMode;
        return (
          <IntentPrefetchLink
            key={tabMode}
            href={tabMode === "csp" ? "/scanner" : "/scanner?mode=covered-calls"}
            aria-current={active ? "page" : undefined}
            aria-busy={pending ? true : undefined}
            onClick={() => setSelection({ serverMode: mode, clientMode: tabMode })}
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

function tabClass(active: boolean) {
  return segmentedItemClass(active);
}
