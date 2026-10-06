import { Info } from "lucide-react";

/**
 * Phase 2B (Last Valid Position Assessment) - compact, non-scary informational notice shown on
 * Dashboard/Tracker whenever at least one visible position is rendering LAST_VALID (and never when
 * every visible position is genuinely CURRENT). Reuses the existing `info` Badge tone's exact
 * colors (border-sky-400/40 / bg-sky-400/10 / text-sky-200) rather than inventing a new one.
 *
 * Deliberately NOT "Market closed - showing last valid..." (a wording some specs for this feature
 * suggest): LAST_VALID can also surface from a transient broker/quote hiccup DURING market hours
 * (allowed fallback reasons include POSITION_BROKER_UNAVAILABLE/QUOTE_EVIDENCE_UNAVAILABLE/
 * QUOTE_STALE_TIMESTAMP, not only MARKET_CLOSED) - claiming "market closed" when that isn't
 * actually why would misattribute the cause, which this app's data-honesty rules exist to prevent.
 *
 * Known limitation (accepted): this is decided once per server render. If a row's CURRENT guidance
 * expires client-side into a verified historical fallback after the page already loaded (see
 * live-position-assessment-badge.tsx), that row switches to muted/historical styling without this
 * banner reappearing until the next refresh/navigation. Acceptable because the muted badge styling
 * itself already signals non-live-ness, and the window is the same few-minutes guidance budget
 * useActiveGuidanceExpired already governs.
 */
export function LastValidNotice() {
  return (
    <div className="flex items-start gap-2 rounded-lg border border-sky-400/40 bg-sky-400/10 px-3 py-2 text-xs text-sky-200">
      <Info aria-hidden size={14} className="mt-0.5 shrink-0" />
      <span>Showing last valid assessments where current data isn&apos;t available.</span>
    </div>
  );
}
