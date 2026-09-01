import { MessageCircle, Send, ThumbsUp } from "lucide-react";
import { Badge, EmptyState, Initials, Panel } from "@/components/ui";
import { RECOMMENDATION_REASON_TAGS, RECOMMENDATION_STATUSES } from "@/domain/social/recommendations";
import { requireCurrentUser } from "@/lib/auth";
import { getRecommendationsPageData } from "@/lib/app-data";
import {
  addReactionAction,
  addRecommendationCommentAction,
  recommendStockAction,
  updateRecommendationStatusAction,
} from "../actions";

export const dynamic = "force-dynamic";

export default async function RecommendationsPage({
  searchParams,
}: {
  searchParams: Promise<{ error?: string }>;
}) {
  const user = await requireCurrentUser();
  const params = await searchParams;
  const { users, incoming, outgoing } = await getRecommendationsPageData(user.id);

  return (
    <div className="space-y-6">
      <div>
        <p className="text-sm font-medium text-emerald-300">Recommend to Buddy</p>
        <h1 className="text-3xl font-semibold text-zinc-50">Recommendations</h1>
      </div>

      {params.error ? (
        <div className="rounded-md border border-red-400/30 bg-red-400/10 px-3 py-2 text-sm text-red-100">
          {params.error}
        </div>
      ) : null}

      <Panel title="Send Recommendation">
        <form action={recommendStockAction} className="grid gap-3 lg:grid-cols-[120px_180px_1fr_160px]">
          <input type="hidden" name="returnTo" value="/recommendations" />
          <input
            name="ticker"
            placeholder="Ticker"
            pattern="[A-Za-z][A-Za-z0-9.-]{0,9}"
            title="Use 1-10 ticker characters: letters, numbers, dot, or dash."
            className="min-h-11 rounded-md border border-zinc-700 bg-zinc-900 px-3 text-sm text-zinc-50"
            required
          />
          <select name="recipientId" className="min-h-11 rounded-md border border-zinc-700 bg-zinc-900 px-3 text-sm text-zinc-50">
            {users.map((buddy) => (
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
          <div className="grid gap-2 sm:grid-cols-2 lg:col-span-3 xl:grid-cols-4">
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
          <button
            type="submit"
            className="inline-flex min-h-11 items-center justify-center gap-2 rounded-md bg-emerald-400 px-4 text-sm font-semibold text-black hover:bg-emerald-300"
          >
            <Send className="size-4" aria-hidden />
            Send
          </button>
        </form>
      </Panel>

      <div className="grid gap-4 xl:grid-cols-2">
        <Panel title="Incoming">
          <div className="space-y-4">
            {incoming.map((recommendation) => (
              <article key={recommendation.id} className="rounded-lg border border-zinc-800 bg-zinc-900 p-4">
                <div className="mb-3 flex items-start justify-between gap-3">
                  <div className="flex items-center gap-3">
                    <Initials name={recommendation.sender.name} />
                    <div>
                      <h2 className="text-xl font-semibold text-zinc-50">{recommendation.ticker}</h2>
                      <p className="text-sm text-zinc-400">{recommendation.sender.name}</p>
                    </div>
                  </div>
                  <Badge tone={recommendation.status === "NEW" ? "info" : "good"}>{recommendation.status}</Badge>
                </div>
                <p className="text-sm text-zinc-300">&quot;{recommendation.message}&quot;</p>
                <div className="mt-3 flex flex-wrap gap-2">
                  {recommendation.reasonTags.map((tag) => (
                    <Badge key={tag}>{tag}</Badge>
                  ))}
                </div>
                <form action={updateRecommendationStatusAction} className="mt-4 flex flex-wrap gap-2">
                  <input type="hidden" name="recommendationId" value={recommendation.id} />
                  {RECOMMENDATION_STATUSES.map((status) => (
                    <button
                      key={status}
                      name="status"
                      value={status}
                      className="min-h-10 rounded-md border border-zinc-700 px-3 text-sm text-zinc-300 hover:border-emerald-400/60"
                    >
                      {status}
                    </button>
                  ))}
                </form>
                <RecommendationFooter recommendationId={recommendation.id} />
              </article>
            ))}
            {incoming.length === 0 ? <EmptyState>No incoming recommendations.</EmptyState> : null}
          </div>
        </Panel>

        <Panel title="Outgoing">
          <div className="space-y-4">
            {outgoing.map((recommendation) => (
              <article key={recommendation.id} className="rounded-lg border border-zinc-800 bg-zinc-900 p-4">
                <div className="mb-3 flex items-start justify-between gap-3">
                  <div className="flex items-center gap-3">
                    <Initials name={recommendation.recipient.name} />
                    <div>
                      <h2 className="text-xl font-semibold text-zinc-50">{recommendation.ticker}</h2>
                      <p className="text-sm text-zinc-400">To {recommendation.recipient.name}</p>
                    </div>
                  </div>
                  <Badge>{recommendation.status}</Badge>
                </div>
                <p className="text-sm text-zinc-300">&quot;{recommendation.message}&quot;</p>
                <RecommendationFooter recommendationId={recommendation.id} />
              </article>
            ))}
            {outgoing.length === 0 ? <EmptyState>No outgoing recommendations.</EmptyState> : null}
          </div>
        </Panel>
      </div>
    </div>
  );
}

function RecommendationFooter({ recommendationId }: { recommendationId: string }) {
  return (
    <div className="mt-4 space-y-3">
      <form action={addRecommendationCommentAction} className="flex gap-2">
        <input type="hidden" name="recommendationId" value={recommendationId} />
        <input name="body" placeholder="Comment" className="min-h-10 min-w-0 flex-1 rounded-md border border-zinc-700 bg-zinc-950 px-2 text-sm text-zinc-100" />
        <button type="submit" className="inline-flex min-h-10 items-center justify-center rounded-md border border-zinc-700 px-3 text-zinc-300 hover:border-zinc-500" aria-label="Comment">
          <MessageCircle className="size-4" aria-hidden />
        </button>
      </form>
      <form action={addReactionAction}>
        <input type="hidden" name="targetType" value="RECOMMENDATION" />
        <input type="hidden" name="targetId" value={recommendationId} />
        <button type="submit" className="inline-flex min-h-10 items-center gap-2 rounded-md border border-zinc-700 px-3 text-sm text-zinc-300 hover:border-emerald-400/60 hover:text-emerald-200">
          <ThumbsUp className="size-4" aria-hidden />
          Atta Boy
        </button>
      </form>
    </div>
  );
}
