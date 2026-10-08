"use client";

import { createContext, useContext, useEffect, useMemo, useState, type ReactNode } from "react";
import { Info } from "lucide-react";
import { useActiveGuidanceExpired } from "@/components/use-active-guidance-expired";
import { PositionToReviewRowView } from "@/components/position-to-review-row";
import type { PositionAssessmentDisplay } from "@/domain/finance/positionReviewAssessment";
import {
  classifyFreshnessStripStateFromObservations,
  currentRevisionKey,
  effectivePresentation,
  resolveEffectivePresentation,
  type EffectivePresentation,
  type FreshnessStripState,
} from "@/domain/finance/presentationFreshness";
import { formatEtCompactDateTime, formatEtTime } from "@/lib/format";
import type { PositionToReviewDisplayRow } from "@/lib/dashboard-view";

/**
 * Codex blocker repair (B1, two rounds) - the shared client presentation-state layer. The server
 * resolves `PositionAssessmentDisplay[]` exactly once (unchanged); this module re-derives,
 * CLIENT-SIDE, which of those are still genuinely live as `now` advances past a CURRENT row's own
 * trusted guidance deadline - reusing useActiveGuidanceExpired (the SAME hook
 * LivePositionAssessmentBadge/EvidenceLine already use for the identical deadline), never a second
 * independent freshness clock. FreshnessStrip and AttentionNowList (Dashboard) both read the SAME
 * per-row live state through ClientPresentationProvider's context.
 *
 * Both this shared layer and each row's own individual badge trust the SAME deadline semantics,
 * but each calibrates its OWN round trip to `/api/time` independently - they can therefore briefly
 * disagree for a moment while one has calibrated and the other hasn't yet (never for longer than
 * one calibration round trip, and this never extends or weakens any financial eligibility - only
 * which cosmetic label briefly shows). This is NOT "they can never disagree"; it is "they resolve
 * to the same answer once both have calibrated, from the same deadline."
 *
 * Round 2 fix: a client report is now keyed by a REVISION identity (`currentRevisionKey`,
 * presentationFreshness.ts - campaignId + the live evaluation's own evaluatedAt/deadline), never by
 * campaign id alone. A campaign can move through several distinct CURRENT evaluations, then to
 * LAST_VALID/UNAVAILABLE, then back to a new CURRENT evaluation, all under the same campaign id -
 * see resolveEffectivePresentation's own doc comment for the exact lookup rule this enforces: a
 * non-CURRENT server display is ALWAYS used directly and never consults a cached report at all, and
 * a CURRENT display only ever reuses a report whose revision key matches EXACTLY.
 *
 * Zero provider calls: useActiveGuidanceExpired's only network request is this app's own
 * same-origin, read-only `/api/time` calibration endpoint (see its own doc comment) - never
 * Schwab/market-data. One observer component mounts per CURRENT entry only (LAST_VALID/UNAVAILABLE
 * never change client-side, so they need no live tracking at all) - each observer is its OWN
 * component instance with exactly one unconditional hook call, never a hook called inside a loop
 * or conditionally (both FreshnessStrip and AttentionNowList below read the already-resolved
 * shared Map via a single top-level `useContext` call each, then do plain, hook-free lookups).
 *
 * Testing note: this repo has no React/DOM component-render harness (vitest.config.mts runs
 * `environment: "node"`, only picks up `*.test.ts`, and has no @testing-library/react or jsdom
 * dependency) - adding one solely for this fix would be a disproportionate new testing framework
 * for a narrow bug repair. Per the ticket's own explicit fallback, the revision-safe cache/lookup
 * logic is instead extracted into pure, hook-free functions (currentRevisionKey,
 * resolveEffectivePresentation - presentationFreshness.ts) and exhaustively unit-tested there; this
 * file itself was verified with real local browser verification against controlled server props.
 */

type LiveState = EffectivePresentation;

const LiveObservationsContext = createContext<ReadonlyMap<string, LiveState>>(new Map());

export type DisplayEntry = { key: string; display: PositionAssessmentDisplay };

function RowObserver({ revisionKey, display, now, onReport }: { revisionKey: string; display: PositionAssessmentDisplay; now: Date; onReport: (revisionKey: string, state: LiveState) => void }) {
  const expired = useActiveGuidanceExpired(
    display.state === "CURRENT" ? display.current.explanation.activeGuidanceDeadline : null,
    display.state === "CURRENT" ? display.current.explanation.evaluatedAt : null,
  );
  const state = effectivePresentation(display, expired, now);

  useEffect(() => {
    onReport(revisionKey, state);
    // state is a freshly-built object every render; the three primitives below are what actually
    // identify a meaningful change, so the effect only re-reports when one of them does.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [revisionKey, state.tier, state.stillLiveCurrent, state.evaluatedAt ? state.evaluatedAt.getTime() : null]);

  return null;
}

/** Wraps a subtree with the shared live-presentation state for `entries`. Mount this once per page
 * (Dashboard) around both FreshnessStrip and AttentionNowList so they share one set of observers.
 * `entries` CAN change across a render (e.g. a manual "Refresh status" click re-resolves the
 * server's own displays and calls `router.refresh()`) - when a campaign's revision key changes
 * (new CURRENT evaluation) or it leaves CURRENT state entirely, its OLD observer unmounts (its
 * React `key` is the revision key itself) and any report it already made for the OLD revision is
 * pruned from the Map on the very next report cycle, so it can never be looked up again. */
export function ClientPresentationProvider({ entries, now, children }: { entries: readonly DisplayEntry[]; now: Date; children: ReactNode }) {
  const [liveByRevision, setLiveByRevision] = useState<ReadonlyMap<string, LiveState>>(new Map());
  const currentObservers = useMemo(
    () =>
      entries.flatMap((entry) => {
        const revisionKey = currentRevisionKey(entry.key, entry.display);
        return revisionKey ? [{ revisionKey, display: entry.display }] : [];
      }),
    [entries],
  );
  const activeRevisionKeys = useMemo(() => new Set(currentObservers.map((observer) => observer.revisionKey)), [currentObservers]);

  const handleReport = (revisionKey: string, state: LiveState) => {
    setLiveByRevision((prev) => {
      const existing = prev.get(revisionKey);
      const unchanged = existing && existing.tier === state.tier && existing.stillLiveCurrent === state.stillLiveCurrent && existing.evaluatedAt?.getTime() === state.evaluatedAt?.getTime();
      // Prune every revision no longer represented by the CURRENT entries this provider was just
      // given, not only insert the new one - a stale revision can never be looked up again either
      // way (resolveEffectivePresentation only matches by exact key), but pruning keeps this Map
      // from growing unboundedly across a long-lived session/navigation.
      const next = new Map<string, LiveState>();
      for (const [key, value] of prev) {
        if (activeRevisionKeys.has(key)) next.set(key, value);
      }
      if (unchanged && next.size === prev.size) {
        return prev;
      }
      next.set(revisionKey, state);
      return next;
    });
  };

  return (
    <LiveObservationsContext.Provider value={liveByRevision}>
      {currentObservers.map(({ revisionKey, display }) => (
        <RowObserver key={revisionKey} revisionKey={revisionKey} display={display} now={now} onReport={handleReport} />
      ))}
      {children}
    </LiveObservationsContext.Provider>
  );
}

function freshnessStripHeadline(state: FreshnessStripState, now: Date): string {
  if (state.kind === "EMPTY") {
    return "No open positions to assess";
  }
  if (state.kind === "ALL_UNAVAILABLE") {
    return "Current position status unavailable";
  }
  if (state.kind === "UNIFORM_CURRENT") {
    return `Current position data · ${formatEtTime(state.evaluatedAt)}`;
  }
  if (state.kind === "MIXED_CURRENT") {
    return "Current position data";
  }
  if (state.kind === "MIXED_SNAPSHOTS") {
    return "Showing latest available position data";
  }
  // UNIFORM_SNAPSHOT
  if (state.tier === "SNAPSHOT") {
    return `Position snapshot · ${formatEtTime(state.evaluatedAt)}`;
  }
  if (state.tier === "LAST_SESSION") {
    return `Last session data · ${formatEtCompactDateTime(state.evaluatedAt, now)}`;
  }
  return `Historical position data · ${formatEtCompactDateTime(state.evaluatedAt, now)}`;
}

/**
 * The compact, top-of-page freshness strip for Dashboard/Tracker. Codex blocker repair, round 2
 * (B2) - this strip describes DATA FRESHNESS only, never a market-open/closed STATE claim: Phase 1
 * has no continuous, authoritative session-state source (that belongs to a future scheduled-
 * capture phase - see PROJECT_HANDOFF.md) and a session claim derived once at render time can
 * silently go stale while the tab stays open across an actual session close/early-close. Must be
 * rendered inside ClientPresentationProvider (one `useContext` call here, then plain lookups - no
 * hook calls in the `.map()` below).
 */
export function FreshnessStrip({ entries, now }: { entries: readonly DisplayEntry[]; now: Date }) {
  const liveByRevision = useContext(LiveObservationsContext);
  const observations = entries.map((entry) => {
    const state = resolveEffectivePresentation(liveByRevision, entry.key, entry.display, now);
    return { tier: state.tier, evaluatedAt: state.evaluatedAt };
  });
  const state = classifyFreshnessStripStateFromObservations(observations);
  const headline = freshnessStripHeadline(state, now);

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
 * CURRENT-sourced row the instant its own trusted guidance deadline passes, AND immediately defers
 * to a fresher server replacement (LAST_VALID/UNAVAILABLE/a new CURRENT revision) rather than ever
 * reusing a report computed for an older revision - see resolveEffectivePresentation's own lookup
 * rule. An UNAVAILABLE-sourced contradiction row is unaffected either way (it never had a deadline
 * to expire in the first place, so it passes straight through). Must be rendered inside
 * ClientPresentationProvider, keyed by the SAME campaignId used to build its `entries`. One
 * `useContext` call here, then a plain (hook-free) filter - never a hook called per row.
 */
export function AttentionNowList({ rows, now }: { rows: readonly PositionToReviewDisplayRow[]; now: Date }) {
  const liveByRevision = useContext(LiveObservationsContext);
  const visible = rows.filter((row) => {
    const display = row.display;
    if (!display) return false;
    if (display.state !== "CURRENT") return true; // UNAVAILABLE contradiction - deadline-independent
    return resolveEffectivePresentation(liveByRevision, row.campaignId, display, now).stillLiveCurrent;
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
