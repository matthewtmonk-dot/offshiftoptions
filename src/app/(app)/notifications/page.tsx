import Link from "next/link";
import { Check, ExternalLink } from "lucide-react";
import { Badge, EmptyState, Initials, Panel } from "@/components/ui";
import { requireCurrentUser } from "@/lib/auth";
import { getNotificationsPageData } from "@/lib/app-data";
import { shortDate } from "@/lib/format";
import { markAllNotificationsReadAction, markNotificationReadAction } from "../actions";

export const dynamic = "force-dynamic";

export default async function NotificationsPage() {
  const user = await requireCurrentUser();
  const notifications = await getNotificationsPageData(user.id);
  const unread = notifications.filter((notification) => !notification.readAt).length;

  return (
    <div className="space-y-6">
      <div className="flex flex-col gap-3 md:flex-row md:items-end md:justify-between">
        <div>
          <p className="text-sm font-medium text-emerald-300">In-app notifications</p>
          <h1 className="text-3xl font-semibold text-zinc-50">Notifications</h1>
        </div>
        <form action={markAllNotificationsReadAction}>
          <button className="inline-flex min-h-10 items-center justify-center gap-2 rounded-md border border-zinc-700 px-3 text-sm text-zinc-300 hover:border-emerald-400/60">
            <Check className="size-4" aria-hidden />
            Mark all read
          </button>
        </form>
      </div>

      <Panel title={`${unread} unread`}>
        <div className="space-y-3">
          {notifications.map((notification) => (
            <article key={notification.id} className="rounded-lg border border-zinc-800 bg-zinc-900 p-4">
              <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
                <div className="flex gap-3">
                  {notification.actor ? <Initials name={notification.actor.name} /> : <Initials name="LST" />}
                  <div>
                    <div className="flex flex-wrap items-center gap-2">
                      <h2 className="font-semibold text-zinc-50">{notification.title}</h2>
                      <Badge tone={notification.readAt ? "neutral" : "info"}>{notification.readAt ? "READ" : "UNREAD"}</Badge>
                    </div>
                    <p className="mt-1 text-sm text-zinc-400">{notification.body}</p>
                    <p className="mt-2 text-xs text-zinc-500">{shortDate(notification.createdAt)}</p>
                  </div>
                </div>
                <div className="flex gap-2">
                  {notification.href ? (
                    <Link href={notification.href} className="inline-flex min-h-10 items-center justify-center rounded-md border border-zinc-700 px-3 text-zinc-300 hover:border-zinc-500" aria-label="Open notification">
                      <ExternalLink className="size-4" aria-hidden />
                    </Link>
                  ) : null}
                  {!notification.readAt ? (
                    <form action={markNotificationReadAction}>
                      <input type="hidden" name="notificationId" value={notification.id} />
                      <button className="inline-flex min-h-10 items-center justify-center rounded-md border border-zinc-700 px-3 text-zinc-300 hover:border-emerald-400/60" aria-label="Mark read">
                        <Check className="size-4" aria-hidden />
                      </button>
                    </form>
                  ) : null}
                </div>
              </div>
            </article>
          ))}
          {notifications.length === 0 ? <EmptyState>No notifications yet.</EmptyState> : null}
        </div>
      </Panel>
    </div>
  );
}
