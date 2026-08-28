import Link from "next/link";
import {
  Bell,
  ChartNoAxesCombined,
  Download,
  HeartHandshake,
  LayoutDashboard,
  ListChecks,
  LogOut,
  MessageSquareText,
  Send,
  SlidersHorizontal,
  WalletCards,
} from "lucide-react";
import { Initials } from "@/components/ui";
import { requireCurrentUser } from "@/lib/auth";
import { getUnreadNotificationCount } from "@/lib/app-data";
import { signOutAction } from "./actions";

const navItems = [
  { href: "/dashboard", label: "Dashboard", icon: LayoutDashboard },
  { href: "/positions", label: "Positions", icon: WalletCards },
  { href: "/scanner", label: "Scanner", icon: ChartNoAxesCombined },
  { href: "/scanner/settings", label: "Settings", icon: SlidersHorizontal },
  { href: "/watchlist", label: "Watchlist", icon: ListChecks },
  { href: "/recommendations", label: "Recs", icon: Send },
  { href: "/chat", label: "Chat", icon: MessageSquareText },
  { href: "/notifications", label: "Alerts", icon: Bell },
  { href: "/install", label: "Install", icon: Download },
];

export default async function AppLayout({ children }: { children: React.ReactNode }) {
  const user = await requireCurrentUser();
  const unread = await getUnreadNotificationCount(user.id);

  return (
    <div className="min-h-screen bg-zinc-950">
      <div className="mx-auto flex min-h-screen w-full max-w-7xl flex-col md:flex-row">
        <aside className="hidden w-64 shrink-0 border-r border-zinc-800 bg-zinc-950/95 px-4 py-5 md:block">
          <div className="mb-7 flex items-center gap-3">
            <Initials name="LST Buddy" />
            <div>
              <div className="text-lg font-semibold text-zinc-50">LST Buddy</div>
              <div className="text-xs text-zinc-500">Demo/manual Phase 1</div>
            </div>
          </div>
          <nav className="space-y-1">
            {navItems.map((item) => {
              const Icon = item.icon;
              return (
                <Link
                  key={item.href}
                  href={item.href}
                  className="flex min-h-11 items-center gap-3 rounded-md px-3 text-sm text-zinc-300 transition hover:bg-zinc-900 hover:text-zinc-50"
                >
                  <Icon className="size-4" aria-hidden />
                  <span>{item.label}</span>
                  {item.href === "/notifications" && unread > 0 ? (
                    <span className="ml-auto rounded-md bg-emerald-400 px-1.5 py-0.5 text-xs font-bold text-zinc-950">
                      {unread}
                    </span>
                  ) : null}
                </Link>
              );
            })}
          </nav>
          <div className="mt-8 rounded-lg border border-zinc-800 bg-zinc-900 p-3">
            <div className="flex items-center gap-2">
              <Initials name={user.name} />
              <div>
                <div className="text-sm font-semibold text-zinc-100">{user.name}</div>
                <div className="text-xs text-zinc-500">{user.email}</div>
              </div>
            </div>
            <form action={signOutAction} className="mt-3">
              <button
                type="submit"
                className="inline-flex min-h-10 w-full items-center justify-center gap-2 rounded-md border border-zinc-700 text-sm text-zinc-300 transition hover:border-zinc-500 hover:text-zinc-50"
              >
                <LogOut className="size-4" aria-hidden />
                Sign out
              </button>
            </form>
          </div>
        </aside>

        <div className="flex min-w-0 flex-1 flex-col">
          <header className="sticky top-0 z-20 border-b border-zinc-800 bg-zinc-950/95 px-4 py-3 backdrop-blur md:hidden">
            <div className="mb-3 flex items-center justify-between">
              <div className="flex items-center gap-2">
                <HeartHandshake className="size-5 text-emerald-300" aria-hidden />
                <span className="font-semibold">LST Buddy</span>
              </div>
              <div className="flex items-center gap-2 text-sm text-zinc-300">
                <Initials name={user.name} />
                {unread > 0 ? <span className="rounded-md bg-emerald-400 px-2 py-1 text-xs font-bold text-zinc-950">{unread}</span> : null}
              </div>
            </div>
            <nav className="grid grid-cols-4 gap-2">
              {navItems.map((item) => {
                const Icon = item.icon;
                return (
                  <Link
                    key={item.href}
                    href={item.href}
                    className="flex min-h-12 flex-col items-center justify-center gap-1 rounded-md bg-zinc-900 text-[11px] text-zinc-300"
                  >
                    <Icon className="size-4" aria-hidden />
                    {item.label}
                  </Link>
                );
              })}
            </nav>
          </header>
          <main className="min-w-0 flex-1 px-4 py-5 md:px-6 lg:px-8">{children}</main>
        </div>
      </div>
    </div>
  );
}
