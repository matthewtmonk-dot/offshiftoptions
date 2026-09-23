import { ChevronDown, Send } from "lucide-react";
import { IntentPrefetchLink } from "@/components/intent-prefetch-link";
import { RECOMMENDATION_REASON_TAGS } from "@/domain/social/recommendations";
import { recommendStockAction } from "../actions";

/**
 * Navigation/Communication Cleanup ticket: Recs was removed as a primary nav destination - this
 * is the compact "send a recommendation" workflow Chat now hosts in its place, reusing the exact
 * same `recommendStockAction` server workflow (and its already-approved createRecommendationForUser
 * -> postRecommendationChatEcho behavior) that the old /recommendations page, Research, and Scanner
 * all already call. Collapsed by default (a plain <details>, no client JS needed) so it stays
 * clearly secondary to the message composer above it. The fuller incoming/outgoing history with
 * status transitions/comments/reactions deliberately stays on /recommendations rather than being
 * rebuilt here - linked below - since duplicating that workflow into Chat would be exactly the
 * "large new communication system" this ticket was told not to build.
 */
export function ChatRecommendPanel({ buddies }: { buddies: { id: string; name: string }[] }) {
  if (buddies.length === 0) {
    return null;
  }

  return (
    <details className="group rounded-lg border border-zinc-800 bg-zinc-950/70 p-3">
      <summary className="flex cursor-pointer list-none items-center justify-between gap-2 text-sm font-medium text-zinc-200 [&::-webkit-details-marker]:hidden">
        <span className="inline-flex items-center gap-2">
          <Send className="size-4 text-emerald-300" aria-hidden />
          Recommend a ticker
        </span>
        <ChevronDown className="size-4 text-zinc-500 transition group-open:rotate-180" aria-hidden />
      </summary>
      <form action={recommendStockAction} className="mt-3 grid gap-2 border-t border-zinc-800 pt-3 lg:grid-cols-[120px_160px_1fr_auto]">
        <input type="hidden" name="returnTo" value="/chat" />
        <input
          name="ticker"
          placeholder="Ticker"
          pattern="[A-Za-z][A-Za-z0-9.-]{0,9}"
          title="Use 1-10 ticker characters: letters, numbers, dot, or dash."
          required
          className="min-h-11 rounded-md border border-zinc-700 bg-zinc-900 px-3 text-sm text-zinc-50"
        />
        <select name="recipientId" className="min-h-11 rounded-md border border-zinc-700 bg-zinc-900 px-3 text-sm text-zinc-50">
          {buddies.map((buddy) => (
            <option key={buddy.id} value={buddy.id}>
              {buddy.name}
            </option>
          ))}
        </select>
        <input
          name="message"
          placeholder="Message"
          className="min-h-11 rounded-md border border-zinc-700 bg-zinc-900 px-3 text-sm text-zinc-50"
        />
        <button
          type="submit"
          className="inline-flex min-h-11 items-center justify-center gap-2 rounded-md bg-emerald-400 px-4 text-sm font-semibold text-black hover:bg-emerald-300"
        >
          <Send className="size-4" aria-hidden />
          Send
        </button>
        <div className="grid gap-2 sm:grid-cols-2 lg:col-span-4 xl:grid-cols-4">
          {RECOMMENDATION_REASON_TAGS.map((tag) => (
            <label key={tag} className="flex min-h-10 items-center gap-2 rounded-md border border-zinc-800 bg-zinc-950 px-3 text-xs text-zinc-300">
              <input
                type="checkbox"
                name="reasonTags"
                value={tag}
                defaultChecked={tag === "Worth researching"}
                className="size-3.5 accent-emerald-400"
              />
              {tag}
            </label>
          ))}
        </div>
      </form>
      <p className="mt-2 text-xs text-zinc-500">
        Sends a recommendation and posts a note here in Chat. Full recommendation history, status,
        and comments live on the{" "}
        <IntentPrefetchLink href="/recommendations" className="text-emerald-300 hover:text-emerald-200">
          Recommendations page
        </IntentPrefetchLink>
        .
      </p>
    </details>
  );
}
