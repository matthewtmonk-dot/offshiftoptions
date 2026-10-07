"use client";

import { createContext, useContext, useEffect, useMemo, useState, type ReactNode } from "react";
import { Info } from "lucide-react";
import { useActiveGuidanceExpired } from "@/components/use-active-guidance-expired";
import { PositionToReviewRowView } from "@/components/position-to-review-row";
import type { PositionAssessmentDisplay } from "@/domain/finance/positionReviewAssessment";
import {
  classifyFreshnessStripStateFromObservations,
  effectivePresentation,
  type EffectivePresentation,
  type FreshnessStripState,
  type MarketSessionClaim,
} from "@/domain/finance/presentationFreshness";
import { formatEtCompactDateTime, formatEtTime } from "@/lib/format";
import type { PositionToReviewDisplayRow } from "@/lib/dashboard-view";

/**
 * Codex blocker repair (B1) - the shared client presentation-state layer. The server resolves
 * `PositionAssessmentDisplay[]` exactly once (unchanged); this module re-derives, CLIENT-SIDE,
 * which of those are still genuinely live as `now` advances past a CURRENT row's own trusted
 * guidance deadline - reusing useActiveGuidanceExpired (the SAME hook LivePositionAssessmentBadge/
 * EvidenceLine already use for the identical deadline), never a second independent freshness
 * clock. FreshnessStrip and AttentionNowList (Dashboard) both read the SAME per-row live state
 * through ClientPresentationProvider's context, so they can never disagree about whether a row has
 * transitioned - the exact inconsistency Codex found (strip still saying CURRENT, Attention Now
 * still listing an action the visible badge had already moved on from).
 *
 * Zero provider calls: useActiveGuidanceExpired's only network request is this app's own
 * same-origin, read-only `/api/time` calibration endpoint (see its own doc comment) - never
 * Schwab/market-data. One observer component mounts per CURRENT entry only (LAST_VALID/UNAVAILABLE
 * never change client-side, so they need no live tracking at all) - each observer is its OWN
 * component instance with exactly one unconditional hook call, never a hook called inside a loop
 * or conditionally (both FreshnessStrip and AttentionNowList below read the already-resolved
 * shared Map via a single top-level `useContext` call each, then do plain, hook-free lookups).
 */

type LiveState = EffectivePresentation;

const LiveObservationsContext = createContext<ReadonlyMap<string, LiveState>>(new Map());

export type DisplayEntry = { key: string; display: PositionAssessmentDisplay };

function RowObserver({ entryKey, display, now, onReport }: { entryKey: string; display: PositionAssessmentDisplay; now: Date; onReport: (key: string, state: LiveState) => void }) {
  const expired = useActiveGuidanceExpired(
    display.state === "CURRENT" ? display.current.explanation.activeGuidanceDeadline : null,
    display.state === "CURRENT" ? display.current.explanation.evaluatedAt : null,
  );
  const state = effectivePresentation(display, expired, now);

  useEffect(() => {
    onReport(entryKey, state);
    // state is a freshly-built object every render; the three primitives below are what actually
    // identify a meaningful change, so the effect only re-reports when one of them does.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [entryKey, state.tier, state.stillLiveCurrent, state.evaluatedAt ? state.evaluatedAt.getTime() : null]);

  return null;
}

/** Wraps a subtree with the shared live-presentation state for `entries`. Mount this once per page
 * (Dashboard) around both FreshnessStrip and AttentionNowList so they share one set of observers -
 * `entries` is resolved once per page load and never mutated in place, so each observer's identity
 * stays stable for this component's whole lifetime. */
export function ClientPresentationProvider({ entries, now, children }: { entries: readonly DisplayEntry[]; now: Date; children: ReactNode }) {
  const [liveByKey, setLiveByKey] = useState<ReadonlyMap<string, LiveState>>(new Map());
  const currentEntries = useMemo(() => entries.filter((entry) => entry.display.state === "CURRENT"), [entries]);

  const handleReport = (key: string, state: LiveState) => {
    setLiveByKey((prev) => {
      const existing = prev.get(key);
      if (existing && existing.tier === state.tier && existing.stillLiveCurrent === state.stillLiveCurrent && existing.evaluatedAt?.getTime() === state.evaluatedAt?.getTime()) {
        return prev;
      }
      const next = new Map(prev);
      next.set(key, state);
      return next;
    });
  };

  return (
    <LiveObservationsContext.Provider value={liveByKey}>
      {currentEntries.map((entry) => (
        <RowObserver key={entry.key} entryKey={entry.key} display={entry.display} now={now} onReport={handleReport} />
      ))}
      {children}
    </LiveObservationsContext.Provider>
  );
}

/** Pure (not a hook) lookup: the shared live report for one entry once its own observer has
 * reported at least once, otherwise the SAME pure function computed as if still-expired (matching
 * useActiveGuidanceExpired's own "always starts neutral/pending" initial value) - keeps server
 * render, first client paint, and this fallback all in agreement, so there is no hydration
 * mismatch and no flash of a not-yet-confirmed "live" status. */
function entryState(liveByKey: ReadonlyMap<string, LiveState>, key: string, display: PositionAssessmentDisplay, now: Date): LiveState {
  return liveByKey.get(key) ?? effectivePresentation(display, true, now);
}

function marketPrefix(marketClaim: MarketSessionClaim): string | null {
  if (marketClaim === "OPEN") return "Market open";
  if (marketClaim === "CLOSED") return "Market closed";
  return null;
}

function freshnessStripHeadline(state: FreshnessStripState, marketClaim: MarketSessionClaim, now: Date): string {
  const prefix = marketPrefix(marketClaim);
  const withPrefix = (detail: string) => (prefix ? `${prefix} · ${detail}` : detail);

  if (state.kind === "EMPTY" || state.kind === "ALL_UNAVAILABLE") {
    return prefix ?? "Latest available position data";
  }
  if (state.kind === "UNIFORM_CURRENT") {
    return withPrefix(`Current position assessment ${formatEtTime(state.evaluatedAt)}`);
  }
  if (state.kind === "MIXED_CURRENT" || state.kind === "MIXED_SNAPSHOTS") {
    return withPrefix("Showing latest available snapshots");
  }
  // UNIFORM_SNAPSHOT
  const time = state.tier === "SNAPSHOT" ? formatEtTime(state.evaluatedAt) : formatEtCompactDateTime(state.evaluatedAt, now);
  if (prefix === "Market open") {
    return `${prefix} · Latest snapshot ${time}`;
  }
  if (prefix === "Market closed") {
    return `${prefix} · Showing last observed market snapshots from ${time}`;
  }
  return `Latest available snapshot ${time}`;
}

/**
 * The compact, top-of-page freshness strip for Dashboard/Tracker. `marketClaim` comes from
 * `deriveMarketSessionClaim` (Codex blocker repair B2) over the page's own already-fetched
 * evidence - never a pure calendar guess, never a new provider call. Must be rendered inside
 * ClientPresentationProvider (one `useContext` call here, then plain lookups - no hook calls in
 * the `.map()` below).
 */
export function FreshnessStrip({ entries, now, marketClaim }: { entries: readonly DisplayEntry[]; now: Date; marketClaim: MarketSessionClaim }) {
  const liveByKey = useContext(LiveObservationsContext);
  const observations = entries.map((entry) => {
    const state = entryState(liveByKey, entry.key, entry.display, now);
    return { tier: state.tier, evaluatedAt: state.evaluatedAt };
  });
  const state = classifyFreshnessStripStateFromObservations(observations);
  const headline = freshnessStripHeadline(state, marketClaim, now);

  return (
    <div className="flex items-start gap-2 rounded-md border border-sky-400/30 bg-sky-400/5 px-3 py-1.5 text-xs text-sky-200">
      <Info aria-hidden size={13} className="mt-0.5 shrink-0" />
      <span>{headline}</span>
    </div>
  );
}

/**
 * Dashboard's "Attention Now" list - the server already narrowed `rows` down to genuine candidates
 * (attentionNowRows, dashboard-view.ts: live CURRENT Watch/Review-roll/Review-call, or live
 * UNAVAILABLE with a real contradiction reason). This client wrapper additionally removes a
 * CURRENT-sourced row the instant its own trusted guidance deadline passes (Codex blocker repair
 * B1C) - an UNAVAILABLE-sourced contradiction row is unaffected (it never had a deadline to expire
 * in the first place, so it passes straight through). Must be rendered inside
 * ClientPresentationProvider, keyed by the SAME campaignId used to build its `entries`. One
 * `useContext` call here, then a plain (hook-free) filter - never a hook called per row.
 */
export function AttentionNowList({ rows, now }: { rows: readonly PositionToReviewDisplayRow[]; now: Date }) {
  const liveByKey = useContext(LiveObservationsContext);
  const visible = rows.filter((row) => {
    const display = row.display;
    if (!display) return false;
    if (display.state !== "CURRENT") return true; // UNAVAILABLE contradiction - deadline-independent
    return entryState(liveByKey, row.campaignId, display, now).stillLiveCurrent;
  });

  if (visible.length === 0) {
    return <p className="text-xs text-zinc-500">No new attention items.</p>;
  }
  return (
    <div className="space-y-1.5">
      {visible.map((row) => (
        <PositionToReviewRowView key={row.campaignId} row={row} now={now} />
      ))}
    </div>
  );
}
