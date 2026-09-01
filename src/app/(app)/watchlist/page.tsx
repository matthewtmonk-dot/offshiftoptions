import { Eye, EyeOff, MessageCircle, Plus, Save, Send, ThumbsUp, Trash2 } from "lucide-react";
import { Badge, EmptyState, FieldLabel, Initials, Panel } from "@/components/ui";
import { RECOMMENDATION_REASON_TAGS } from "@/domain/social/recommendations";
import { requireCurrentUser } from "@/lib/auth";
import { getWatchlistPageData } from "@/lib/app-data";
import {
  addReactionAction,
  addWatchlistCommentAction,
  addWatchlistItemAction,
  recommendStockAction,
  removeWatchlistItemAction,
  saveStockNoteAction,
  toggleWatchlistItemVisibilityAction,
} from "../actions";

export const dynamic = "force-dynamic";

export default async function WatchlistPage({
  searchParams,
}: {
  searchParams: Promise<{ error?: string }>;
}) {
  const user = await requireCurrentUser();
  const params = await searchParams;
  const { users, ownWatchlist, visibleItems } = await getWatchlistPageData(user.id);

  return (
    <div className="space-y-6">
      <div className="flex flex-col gap-3 lg:flex-row lg:items-end lg:justify-between">
        <div>
          <p className="text-sm font-medium text-emerald-300">Shared by default, private when needed</p>
          <h1 className="text-3xl font-semibold text-zinc-50">Watchlist</h1>
        </div>
        <form action={addWatchlistItemAction} className="flex w-full gap-2 sm:w-auto">
          <input type="hidden" name="returnTo" value="/watchlist" />
          <input
            name="ticker"
            placeholder="Ticker"
            pattern="[A-Za-z][A-Za-z0-9.-]{0,9}"
            title="Use 1-10 ticker characters: letters, numbers, dot, or dash."
            className="min-h-11 min-w-0 flex-1 rounded-md border border-zinc-700 bg-zinc-900 px-3 text-sm text-zinc-50 outline-none focus:border-emerald-400 sm:w-40"
            required
          />
          <button
            type="submit"
            className="inline-flex min-h-11 items-center justify-center gap-2 rounded-md bg-emerald-400 px-4 text-sm font-semibold text-black hover:bg-emerald-300"
          >
            <Plus className="size-4" aria-hidden />
            Add
          </button>
        </form>
      </div>

      {params.error ? (
        <div className="rounded-md border border-red-400/30 bg-red-400/10 px-3 py-2 text-sm text-red-100">
          {params.error}
        </div>
      ) : null}

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
        {canEdit ? (
          <>
            <NoteEditor itemId={item.id} ticker={item.ticker} category="PRO" label="Edit Pro notes" notes={proNotes.map((note) => note.body)} />
            <NoteEditor itemId={item.id} ticker={item.ticker} category="CON" label="Edit Con notes" notes={conNotes.map((note) => note.body)} />
          </>
        ) : null}
        <form action={recommendStockAction} className="space-y-2">
          <input type="hidden" name="ticker" value={item.ticker} />
          <input type="hidden" name="returnTo" value="/watchlist" />
          <select name="recipientId" className="min-h-10 w-full rounded-md border border-zinc-700 bg-zinc-950 px-2 text-sm">
            {buddies
              .filter((buddy) => buddy.id !== currentUserId)
              .map((buddy) => (
                <option key={buddy.id} value={buddy.id}>
                  {buddy.name}
                </option>
              ))}
          </select>
          <div className="grid grid-cols-2 gap-2">
            {RECOMMENDATION_REASON_TAGS.slice(3).map((tag) => (
              <label key={tag} className="flex min-h-9 items-center gap-2 rounded-md border border-zinc-800 px-2 text-xs text-zinc-300">
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
          <button type="submit" className="inline-flex min-h-10 w-full items-center justify-center gap-2 rounded-md bg-emerald-400 px-3 text-sm font-semibold text-black hover:bg-emerald-300">
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

      {item.comments.length ? (
        <div className="mt-3 space-y-2">
          {item.comments.map((comment) => (
            <div key={comment.id} className="rounded-md border border-zinc-800 bg-zinc-950 p-3 text-sm">
              <div className="font-medium text-zinc-200">{comment.author.name}</div>
              <div className="mt-1 text-zinc-400">{comment.body}</div>
            </div>
          ))}
        </div>
      ) : null}
    </article>
  );
}

function NoteEditor({
  itemId,
  ticker,
  category,
  label,
  notes,
}: {
  itemId: string;
  ticker: string;
  category: "PRO" | "CON";
  label: string;
  notes: string[];
}) {
  return (
    <form action={saveStockNoteAction} className="space-y-2">
      <input type="hidden" name="itemId" value={itemId} />
      <input type="hidden" name="category" value={category} />
      <FieldLabel>{label}</FieldLabel>
      <div className="flex gap-2">
        <textarea
          name="body"
          defaultValue={notes.join("\n")}
          className="min-h-20 min-w-0 flex-1 rounded-md border border-zinc-700 bg-zinc-950 px-2 py-2 text-sm text-zinc-100"
        />
        <button
          type="submit"
          className="inline-flex min-h-10 items-center justify-center self-start rounded-md border border-zinc-700 px-3 text-zinc-300 hover:border-zinc-500"
          aria-label={`Save ${category.toLowerCase()} note for ${ticker}`}
        >
          <Save className="size-4" aria-hidden />
        </button>
      </div>
    </form>
  );
}
