import { cookies } from "next/headers";
import { requireCurrentUser } from "@/lib/auth";
import { getUnreadNotificationCount } from "@/lib/app-data";
import { AppSidebar } from "./app-sidebar";

export default async function AppLayout({ children }: { children: React.ReactNode }) {
  const user = await requireCurrentUser();
  const unread = await getUnreadNotificationCount(user.id);
  const sidebarCookie = (await cookies()).get("oso-sidebar-collapsed")?.value;

  return (
    <div className="min-h-screen bg-zinc-950">
      <div className="mx-auto flex min-h-screen w-full max-w-7xl flex-col md:flex-row 2xl:max-w-[1800px]">
        <AppSidebar
          userName={user.name}
          userEmail={user.email}
          appearance={user.settings?.appearance ?? "SYSTEM"}
          unread={unread}
          initialCollapsed={sidebarCookie === "1"}
        />
        <div className="flex min-w-0 flex-1 flex-col">
          <main className="min-w-0 flex-1 px-4 py-5 md:px-6 lg:px-8">{children}</main>
        </div>
      </div>
    </div>
  );
}
