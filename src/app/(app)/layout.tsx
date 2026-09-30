import { cookies } from "next/headers";
import { requireCurrentUser } from "@/lib/auth";
import { getUnreadChatCount, getUnreadNotificationCount } from "@/lib/app-data";
import { RefreshStatusControl } from "@/components/refresh-status-control";
import { AppSidebar } from "./app-sidebar";

export default async function AppLayout({ children }: { children: React.ReactNode }) {
  const user = await requireCurrentUser();
  const [unread, unreadChat] = await Promise.all([getUnreadNotificationCount(user.id), getUnreadChatCount(user.id)]);
  const sidebarCookie = (await cookies()).get("oso-sidebar-collapsed")?.value;

  return (
    <div className="min-h-screen bg-zinc-950">
      <div className="mx-auto flex min-h-screen w-full max-w-7xl flex-col md:flex-row 2xl:max-w-[1800px]">
        <AppSidebar
          userName={user.name}
          userEmail={user.email}
          appearance={user.settings?.appearance ?? "SYSTEM"}
          unread={unread}
          unreadChat={unreadChat}
          initialCollapsed={sidebarCookie === "1"}
        />
        <div className="flex min-w-0 flex-1 flex-col">
          {/* Post-Phase-2 UX follow-up - the ONE universal "Refresh status" control, top-right,
              available on every authenticated page (never in the left nav rail - that's navigation,
              this is a global status/action). Reuses the exact same action/component Tracker's own
              refresh button now uses (see positions/page.tsx) - never a second implementation. */}
          <div className="flex justify-end border-b border-zinc-800 bg-zinc-950/60 px-4 py-1.5 md:px-6 lg:px-8">
            <RefreshStatusControl />
          </div>
          <main className="min-w-0 flex-1 px-4 py-4 md:px-6 lg:px-8">{children}</main>
        </div>
      </div>
    </div>
  );
}
