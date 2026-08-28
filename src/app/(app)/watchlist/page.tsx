import { Eye, EyeOff, MessageCircle, Plus, Save, Send, ThumbsUp, Trash2 } from "lucide-react";
import { Badge, EmptyState, FieldLabel, Initials, Panel } from "@/components/ui";
import { requireCurrentUser } from "@/lib/auth";
import { getWatchlistPageData } from "@/lib/app-data";
import {
  addReactionAction,
  addStockNoteAction,
  addWatchlistCommentAction,
  addWatchlistItemAction,
  recommendStockAction,
  removeWatchlistItemAction,
  toggleWatchlistItemVisibilityAction,
} from "../actions";

export const dynamic = "force-dynamic";

export default async function WatchlistPage() {
  const user = await requireCurrentUser();
  const { users, ownWatchlist, visibleItems } = await getWatchlistPageData(user.id);

  return (
    <div className="space-y-6">
      <div className="flex flex-col gap-3 lg:flex-row lg:items-end lg:justify-between">
        <div>
          <p className="text-sm font-medium text-emerald-300">Shared by default, private when needed</p>
          <h1 className="text-3xl font-semibold text-zinc-50">Watchlist</h1>
        </div>
        <form action={addWatchlistItemAction} className="flex w-full gap-2 sm:w-auto">
          <input
            name="ticker"
            placeholder="Ticker"
            className="min-h-11 min-w-0 flex-1 rounded-md border border-zinc-700 bg-zinc-900 px-3 text-sm text-zinc-50 outline-none focus:border-emerald-400 sm:w-40"
            required
          />
          <button
            type="submit"
            className="inline-flex min-h-11 items-center justify-center gap-2 rounded-md bg-emerald-400 px-4 text-sm font-semibold text-zinc-950 hover:bg-emerald-300"
          >
            <Plus className="size-4" aria-hidden />
            Add
          </button>
        </form>
      </div>

      <Panel title={ownWatchlist?.name ?? "My Watchlist"}>
        <div className="grid gap-4 xl:grid-cols-2">
          {ownWatchlist?.items.map((item) => (
            <WatchlistCard key={item.id} item={item} buddies={users} currentUserId={user.id} canEdit />
          ))}
          {!ownWatchlist?.items.length ? <EmptyState>No symbols yet.</EmptyState> : null}
        </div>
      </Panel>

      <Panel title="Buddy Shared Watchlist">
        <div className="grid gap-4 xl:grid-cols-2">
          {visibleItems.map((item) => (
            <WatchlistCard key={item.id} item={item} buddies={users} currentUserId={user.id} />
          ))}
          {visibleItems.length === 0 ? <EmptyState>No shared buddy items yet.</EmptyState> : null}
        </div>
      </Panel>
    </div>
  );
}

type WatchlistCardProps = {
  item: NonNullable<Awaited<ReturnType<typeof getWatchlistPageData>>["ownWatchlist"]>["items"][number];
  buddies: Awaited<ReturnType<typeof getWatchlistPageData>>["users"];
  currentUserId: string;
  canEdit?: boolean;
};

function WatchlistCard({ item, buddies, currentUserId, canEdit = false }: WatchlistCardProps) {
  const proNotes = item.notes.filter((note) => note.category === "PRO");
  const conNotes = item.notes.filter((note) => note.category === "CON");

  return (
    <article className="rounded-lg border border-zinc-800 bg-zinc-900 p-4">
      <div className="mb-4 flex items-start justify-between gap-3">
        <div className="flex items-center gap-3">
          <Initials name={item.owner.name} />
          <div>
            <div className="text-2xl font-semibold text-zinc-50">{item.ticker}</div>
            <div className="text-sm text-zinc-400">{item.owner.name}</div>
          </div>
        </div>
        <div className="flex flex-wrap justify-end gap-2">
          <Badge tone={item.visibility === "PRIVATE" ? "warn" : "info"}>{item.visibility}</Badge>
          <Badge>{item.status}</Badge>
        </div>
      </div>

      <div className="grid gap-3 md:grid-cols-2">
        <div className="rounded-md border border-emerald-400/20 bg-emerald-400/10 p-3">
          <FieldLabel>Pro</FieldLabel>
          <ul className="mt-2 space-y-2 text-sm text-emerald-100">
            {proNotes.map((note) => (
              <li key={note.id}>{note.body}</li>
            ))}
            {proNotes.length === 0 ? <li className="text-zinc-500">None yet</li> : null}
          </ul>
        </div>
        <div className="rounded-md border border-red-400/20 bg-red-400/10 p-3">
          <FieldLabel>Con</FieldLabel>
          <ul className="mt-2 space-y-2 text-sm text-red-100">
            {conNotes.map((note) => (
              <li key={note.id}>{note.body}</li>
            ))}
            {conNotes.length === 0 ? <li className="text-zinc-500">None yet</li> : null}
          </ul>
        </div>
      </div>

      <div className="mt-4 flex flex-wrap gap-2">
        {canEdit ? (
          <>
            <form action={toggleWatchlistItemVisibilityAction}>
              <input type="hidden" name="itemId" value={item.id} />
              <button type="submit" className="inline-flex min-h-10 items-center gap-2 rounded-md border border-zinc-700 px-3 text-sm text-zinc-300 hover:border-zinc-500">
                {item.visibility === "PRIVATE" ? <Eye className="size-4" aria-hidden /> : <EyeOff className="size-4" aria-hidden />}
                {item.visibility === "PRIVATE" ? "Share" : "Private"}
              </button>
            </form>
            <form action={removeWatchlistItemAction}>
              <input type="hidden" name="itemId" value={item.id} />
              <button type="submit" className="inline-flex min-h-10 items-center gap-2 rounded-md border border-zinc-700 px-3 text-sm text-zinc-300 hover:border-red-400/60 hover:text-red-200">
                <Trash2 className="size-4" aria-hidden />
                Remove
              </button>
            </form>
          </>
        ) : null}
        <form action={addReactionAction}>
          <input type="hidden" name="targetType" value="WATCHLIST_ITEM" />
          <input type="hidden" name="targetId" value={item.id} />
          <button type="submit" className="inline-flex min-h-10 items-center gap-2 rounded-md border border-zinc-700 px-3 text-sm text-zinc-300 hover:border-emerald-400/60 hover:text-emerald-200">
            <ThumbsUp className="size-4" aria-hidden />
            Atta Boy
          </button>
        </form>
      </div>

      <div className="mt-4 grid gap-3 lg:grid-cols-2">
        <form action={addStockNoteAction} className="space-y-2">
          <input type="hidden" name="itemId" value={item.id} />
          <select name="category" className="min-h-10 w-full rounded-md border border-zinc-700 bg-zinc-950 px-2 text-sm">
            <option value="PRO">Pro</option>
            <option value="CON">Con</option>
            <option value="GENERAL">General</option>
          </select>
          <div className="flex gap-2">
            <input name="body" placeholder="Add note" className="min-h-10 min-w-0 flex-1 rounded-md border border-zinc-700 bg-zinc-950 px-2 text-sm" />
            <button type="submit" className="inline-flex min-h-10 items-center justify-center rounded-md border border-zinc-700 px-3 text-zinc-300 hover:border-zinc-500" aria-label={`Save note for ${item.ticker}`}>
              <Save className="size-4" aria-hidden />
            </button>
          </div>
        </form>
        <form action={recommendStockAction} className="space-y-2">
          <input type="hidden" name="ticker" value={item.ticker} />
          <input type="hidden" name="reasonTags" value="Watchlist,Worth researching" />
          <select name="recipientId" className="min-h-10 w-full rounded-md border border-zinc-700 bg-zinc-950 px-2 text-sm">
            {buddies
              .filter((buddy) => buddy.id !== currentUserId)
              .map((buddy) => (
                <option key={buddy.id} value={buddy.id}>
                  {buddy.name}
                </option>
              ))}
          </select>
          <button type="submit" className="inline-flex min-h-10 w-full items-center justify-center gap-2 rounded-md bg-emerald-400 px-3 text-sm font-semibold text-zinc-950 hover:bg-emerald-300">
            <Send className="size-4" aria-hidden />
            Recommend
          </button>
        </form>
      </div>

      <form action={addWatchlistCommentAction} className="mt-3 flex gap-2">
        <input type="hidden" name="itemId" value={item.id} />
        <input name="body" placeholder="Comment" className="min-h-10 min-w-0 flex-1 rounded-md border border-zinc-700 bg-zinc-950 px-2 text-sm" />
        <button type="submit" className="inline-flex min-h-10 items-center justify-center rounded-md border border-zinc-700 px-3 text-zinc-300 hover:border-zinc-500" aria-label={`Comment on ${item.ticker}`}>
          <MessageCircle className="size-4" aria-hidden />
        </button>
      </form>
    </article>
  );
}
