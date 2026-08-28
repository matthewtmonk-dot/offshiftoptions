import { Check, Send } from "lucide-react";
import { Badge, EmptyState, Initials, Panel } from "@/components/ui";
import { requireCurrentUser } from "@/lib/auth";
import { getChatPageData } from "@/lib/app-data";
import { shortDateTime } from "@/lib/format";
import { markConversationReadAction, sendChatMessageAction } from "../actions";

export const dynamic = "force-dynamic";

export default async function ChatPage() {
  const user = await requireCurrentUser();
  const conversation = await getChatPageData(user.id);
  const unreadCount =
    conversation?.messages.filter(
      (message) => message.senderId !== user.id && !message.reads.some((read) => read.userId === user.id),
    ).length ?? 0;

  return (
    <div className="space-y-6">
      <div>
        <p className="text-sm font-medium text-emerald-300">Private buddy chat</p>
        <h1 className="text-3xl font-semibold text-zinc-50">{conversation?.title ?? "Buddy Chat"}</h1>
      </div>

      <Panel
        title="Messages"
        action={
          <div className="flex -space-x-2">
            {conversation?.members.map((member) => (
              <Initials key={member.id} name={member.user.name} />
            ))}
          </div>
        }
      >
        {conversation ? (
          <div className="space-y-4">
            <div className="max-h-[58vh] space-y-3 overflow-y-auto pr-1">
              {conversation.messages.map((message) => {
                const own = message.senderId === user.id;
                const readByOthers = conversation.members
                  .filter((member) => member.userId !== user.id)
                  .filter((member) => message.reads.some((read) => read.userId === member.userId))
                  .map((member) => member.user.name);
                return (
                  <div key={message.id} className={`flex gap-3 ${own ? "justify-end" : "justify-start"}`}>
                    {!own ? <Initials name={message.sender.name} /> : null}
                    <div className={`max-w-[82%] rounded-lg border p-3 ${own ? "border-emerald-400/30 bg-emerald-400/15" : "border-zinc-800 bg-zinc-900"}`}>
                      <div className="mb-1 flex items-center gap-2 text-xs text-zinc-400">
                        <span>{message.sender.name}</span>
                        {message.ticker ? <span className="text-emerald-300">${message.ticker}</span> : null}
                        <span>{shortDateTime(message.createdAt)}</span>
                      </div>
                      <p className="text-sm text-zinc-100">{message.body}</p>
                      {own && readByOthers.length ? (
                        <p className="mt-2 text-xs text-emerald-200">Read by {readByOthers.join(", ")}</p>
                      ) : null}
                      {!own && !message.reads.some((read) => read.userId === user.id) ? (
                        <p className="mt-2 text-xs text-amber-200">Unread</p>
                      ) : null}
                    </div>
                    {own ? <Initials name={message.sender.name} /> : null}
                  </div>
                );
              })}
            </div>

            <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
              <Badge tone={unreadCount ? "warn" : "neutral"}>{unreadCount} unread</Badge>
              <form action={markConversationReadAction}>
                <input type="hidden" name="conversationId" value={conversation.id} />
                <button
                  type="submit"
                  className="inline-flex min-h-10 items-center justify-center gap-2 rounded-md border border-zinc-700 px-3 text-sm text-zinc-300 hover:border-emerald-400/60"
                >
                  <Check className="size-4" aria-hidden />
                  Mark read
                </button>
              </form>
            </div>

            <form action={sendChatMessageAction} className="grid gap-2 md:grid-cols-[120px_1fr_120px]">
              <input type="hidden" name="conversationId" value={conversation.id} />
              <input type="hidden" name="returnTo" value="/chat" />
              <input name="ticker" placeholder="Ticker" className="min-h-11 rounded-md border border-zinc-700 bg-zinc-950 px-3 text-sm text-zinc-100" />
              <input name="body" placeholder="Message" className="min-h-11 rounded-md border border-zinc-700 bg-zinc-950 px-3 text-sm text-zinc-100" required />
              <button type="submit" className="inline-flex min-h-11 items-center justify-center gap-2 rounded-md bg-emerald-400 px-4 text-sm font-semibold text-zinc-950 hover:bg-emerald-300">
                <Send className="size-4" aria-hidden />
                Send
              </button>
            </form>
          </div>
        ) : (
          <EmptyState>No conversation is seeded for this user.</EmptyState>
        )}
      </Panel>
    </div>
  );
}
