"use client";

import { createContext, useContext, useEffect, useMemo, useState, type ReactNode } from "react";
import { Info } from "lucide-react";
import { useActiveGuidanceExpired } from "@/components/use-active-guidance-expired";
import { PositionToReviewRowView } from "@/components/position-to-review-row";
import { EmptyState } from "@/components/ui";
import { LastValidNotice } from "@/components/last-valid-notice";
import { IntentPrefetchLink } from "@/components/intent-prefetch-link";
import type { PositionAssessmentDisplay } from "@/domain/finance/positionReviewAssessment";
import {
  classifyFreshnessStripStateFromObservations,
  currentRevisionKey,
  effectivePresentation,
  resolveEffectivePresentation,
  type EffectivePresentation,
  type FreshnessStripState,
} from "@/domain/finance/presentationFreshness";
import { partitionPositionReviewRows, type PositionToReviewDisplayRow } from "@/domain/finance/positionReviewRows";
import { isAwaitingSettlement } from "@/domain/finance/positionActivity";
import { formatEtCompactDateTime, formatEtTime } from "@/lib/format";

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
 * or conditionally (FreshnessStrip and DashboardPositionSections below each read the already-
 * resolved shared Map via a single top-level `useContext` call, then do plain, hook-free lookups).
 *
 * Compact position UX, final blocker repair - DashboardPositionSections replaces the old
 * AttentionNowList: Attention Now and Open Positions previously derived from two independent
 * sources (a client-side-filtered Attention Now list vs. a server-computed-once Open Positions
 * remainder), which could drift apart - a row leaving Attention Now the instant its guidance
 * deadline passed in the browser never got added back to Open Positions until the next server
 * render, so it temporarily vanished from BOTH sections. DashboardPositionSections renders both
 * sections together from ONE live partition (partitionPositionReviewRows,
 * domain/finance/positionReviewRows.ts) - every row ends up in exactly one bucket, by construction,
 * so the two sections can never disagree about where a row belongs.
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
 * (Dashboard) around both FreshnessStrip and DashboardPositionSections so they share one set of
 * observers.
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
 * Dashboard's "Attention Now" + "Open Positions" sections, rendered together from ONE live
 * partition (partitionPositionReviewRows, domain/finance/positionReviewRows.ts) - see this file's
 * own top-of-file comment for why these two sections must never be derived independently. `rows`
 * is the FULL priority-sorted set of open rows (not pre-split by the server) - this component does
 * the split itself, every render, from the current live client state, so a row leaving Attention
 * Now the instant its guidance deadline passes is, in the SAME render, already present in Open
 * Positions - never missing from both, never shown in both. `limit` caps how many Open Positions
 * rows are actually rendered (the rest surface via the "+N more in Tracker" link), matching the
 * Dashboard's existing POSITIONS_TO_REVIEW_LIMIT. Must be rendered inside
 * ClientPresentationProvider, keyed by the SAME campaignId used to build its `entries`. One
 * `useContext` call here, then a plain (hook-free) partition - never a hook called per row.
 *
 * Weekend / Settlement Clarity - the "Open Positions" list itself is further split into "Active
 * Now" and "Awaiting Settlement" (an expired-but-unresolved put/covered call, routine CANNOT_ASSESS
 * waiting for Schwab's own settlement confirmation - see currentActivityLabel's own doc comment).
 * This is purely a display regrouping of the SAME visible rows, by the SAME activity label each
 * row's own badge already shows - never a third, independently-derived classification. Routine
 * settlement waiting alone is never attention-worthy on its own (see isAttentionRow); a settlement
 * row only ever appears above, in Attention Now, if it ALSO carries a genuine contradiction.
 * An empty bucket is simply omitted (never an empty-state box per bucket) - only the single
 * combined "every open position is already shown above" message covers the case where there are no
 * open rows at all.
 */
export function DashboardPositionSections({ rows, now, limit }: { rows: readonly PositionToReviewDisplayRow[]; now: Date; limit: number }) {
  const liveByRevision = useContext(LiveObservationsContext);
  const { attention, open } = partitionPositionReviewRows(rows, liveByRevision, now);
  const visibleOpen = open.slice(0, limit);
  const hiddenCount = open.length - visibleOpen.length;
  const activeNow = visibleOpen.filter((row) => !isAwaitingSettlement(row.stage, row.expiration, now, row.display));
  const awaitingSettlement = visibleOpen.filter((row) => isAwaitingSettlement(row.stage, row.expiration, now, row.display));
  // A Buddy-scoped campaign can only ever resolve to CURRENT or UNAVAILABLE (never LAST_VALID) -
  // see positionAssessmentOrchestration.ts's own owner-isolation check - so this notice only ever
  // reflects the viewer's own historical data, never a buddy's.
  const hasLastValid = visibleOpen.some((row) => row.display?.state === "LAST_VALID");

  return (
    <>
      <div>
        <h3 className="mb-1.5 text-xs font-semibold uppercase tracking-wide text-zinc-500">Attention Now</h3>
        {attention.length === 0 ? (
          <p className="text-xs text-zinc-500">No new attention items.</p>
        ) : (
          <div className="space-y-1.5">
            {attention.map((row) => (
              <PositionToReviewRowView key={row.campaignId} row={row} now={now} />
            ))}
          </div>
        )}
      </div>

      {hasLastValid ? <LastValidNotice /> : null}

      {rows.length === 0 ? (
        <div>
          <h3 className="mb-1.5 text-xs font-semibold uppercase tracking-wide text-zinc-500">Open Positions</h3>
          <EmptyState>No open positions yet.</EmptyState>
        </div>
      ) : open.length === 0 ? (
        <div>
          <h3 className="mb-1.5 text-xs font-semibold uppercase tracking-wide text-zinc-500">Open Positions</h3>
          <EmptyState>Every open position is already listed above in Attention Now.</EmptyState>
        </div>
      ) : (
        <>
          {activeNow.length > 0 ? (
            <div>
              <h3 className="mb-1.5 text-xs font-semibold uppercase tracking-wide text-zinc-500">Active Now</h3>
              <div className="space-y-1.5">
                {activeNow.map((row) => (
                  <PositionToReviewRowView key={row.campaignId} row={row} now={now} />
                ))}
              </div>
            </div>
          ) : null}
          {awaitingSettlement.length > 0 ? (
            <div>
              <h3 className="mb-1.5 text-xs font-semibold uppercase tracking-wide text-zinc-500">Awaiting Settlement ({awaitingSettlement.length})</h3>
              <div className="space-y-1.5">
                {awaitingSettlement.map((row) => (
                  <PositionToReviewRowView key={row.campaignId} row={row} now={now} />
                ))}
              </div>
            </div>
          ) : null}
        </>
      )}
      {hiddenCount > 0 ? (
        <IntentPrefetchLink href="/positions" className="block text-center text-xs text-zinc-500 hover:text-sky-300">
          +{hiddenCount} more in Tracker
        </IntentPrefetchLink>
      ) : null}
    </>
  );
}
