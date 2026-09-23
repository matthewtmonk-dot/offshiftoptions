"use client";

import { useState } from "react";
import { usePathname } from "next/navigation";
import {
  Bell,
  ChartNoAxesCombined,
  ChevronLeft,
  ChevronRight,
  HeartHandshake,
  KeyRound,
  LayoutDashboard,
  ListChecks,
  LogOut,
  MessageSquareText,
  WalletCards,
} from "lucide-react";
import { Initials } from "@/components/ui";
import { AppearanceControl } from "@/components/appearance-control";
import { IntentPrefetchLink } from "@/components/intent-prefetch-link";
import { signOutAction } from "./actions";

type Appearance = "SYSTEM" | "LIGHT" | "DARK";

// "Scanner Rules" (/scanner/settings) and "Install" (/install) are deliberately not top-level
// destinations: both remain fully reachable - Scanner Rules via its own icon-button link inside
// the Scanner page toolbar, Install via a link on the Account page - they just no longer compete
// for primary sidebar space.
//
// Navigation/Communication Cleanup ticket: Recs and Notifications were also trimmed from this
// primary list. Recs (/recommendations) - the recommend-to-buddy workflow now lives inside Chat
// (see chat/chat-recommend-panel.tsx); the route itself still exists unchanged as a compatibility
// destination for its fuller incoming/outgoing/status/comment history, reachable from a link inside
// Chat's Recommend panel. Notifications (/notifications) - still exists unchanged, but is reached
// via the bell control in the user-area footer (desktop) / mobile header, not a primary nav slot,
// since it's a secondary "check occasionally" surface rather than a primary destination.
export const navItems = [
  { href: "/dashboard", label: "Dashboard", icon: LayoutDashboard },
  { href: "/positions", label: "Tracker", icon: WalletCards },
  { href: "/scanner", label: "Scanner", icon: ChartNoAxesCombined },
  { href: "/research", label: "Research", icon: ListChecks },
  { href: "/chat", label: "Chat", icon: MessageSquareText },
  { href: "/account", label: "Account", icon: KeyRound },
];

/**
 * Desktop-only, purely cosmetic per-device preference - never persisted to the database, never
 * gates behavior. Read server-side (see layout.tsx) and passed in as `initialCollapsed` so the
 * very first paint already renders the right width - a plain client-readable cookie (the same
 * pattern `AppearanceControl` already uses for its own instant, no-flash preference) avoids
 * both a hydration-mismatch flash AND the React "no setState-in-effect" lint rule that a naive
 * localStorage-read-on-mount would trip. If the cookie is missing (first visit, cleared
 * storage, cookies disabled), the sidebar defaults to expanded.
 */
const SIDEBAR_COOKIE_NAME = "oso-sidebar-collapsed";

function isActiveRoute(pathname: string, href: string): boolean {
  return pathname === href || pathname.startsWith(`${href}/`);
}

export function AppSidebar({
  userName,
  userEmail,
  appearance,
  unread,
  unreadChat,
  initialCollapsed,
}: {
  userName: string;
  userEmail: string;
  appearance: Appearance;
  unread: number;
  unreadChat: number;
  initialCollapsed: boolean;
}) {
  const pathname = usePathname();
  const [collapsed, setCollapsed] = useState(initialCollapsed);

  function toggleCollapsed() {
    setCollapsed((prev) => {
      const next = !prev;
      try {
        document.cookie = `${SIDEBAR_COOKIE_NAME}=${next ? "1" : "0"}; path=/; max-age=31536000; samesite=lax`;
      } catch {
        // Purely cosmetic preference - a failed write just means it won't survive reload.
      }
      return next;
    });
  }

  return (
    <>
      <aside
        data-testid="app-sidebar"
        data-collapsed={collapsed}
        className={`relative hidden shrink-0 border-r border-zinc-800 bg-zinc-950/95 py-5 transition-[width] duration-150 motion-reduce:transition-none md:block ${
          collapsed ? "w-18 px-2" : "w-64 px-4"
        }`}
      >
        <button
          type="button"
          onClick={toggleCollapsed}
          aria-label={collapsed ? "Expand sidebar" : "Collapse sidebar"}
          aria-expanded={!collapsed}
          data-testid="sidebar-toggle"
          className="absolute -right-3 top-6 z-10 flex size-6 items-center justify-center rounded-full border border-zinc-700 bg-zinc-900 text-zinc-400 transition hover:border-zinc-500 hover:text-zinc-100"
        >
          {collapsed ? <ChevronRight className="size-3.5" aria-hidden /> : <ChevronLeft className="size-3.5" aria-hidden />}
        </button>

        <div className={`mb-7 flex items-center gap-3 ${collapsed ? "justify-center" : ""}`}>
          <Initials name="Off Shift Options" />
          {!collapsed ? (
            <div>
              <div className="text-lg font-semibold text-zinc-50">Off Shift Options</div>
              <div className="text-xs text-zinc-500">Tracking + read-only Schwab data</div>
            </div>
          ) : null}
        </div>

        <nav className="space-y-1">
          {navItems.map((item) => {
            const Icon = item.icon;
            const active = isActiveRoute(pathname, item.href);
            const unreadCount = item.href === "/chat" ? unreadChat : 0;
            return (
              <IntentPrefetchLink
                key={item.href}
                href={item.href}
                aria-label={collapsed ? item.label : undefined}
                aria-current={active ? "page" : undefined}
                className={`group relative flex min-h-11 items-center gap-3 rounded-md text-sm transition ${
                  collapsed ? "justify-center px-0" : "px-3"
                } ${active ? "bg-zinc-900 text-zinc-50" : "text-zinc-300 hover:bg-zinc-900 hover:text-zinc-50"}`}
              >
                <Icon className="size-4 shrink-0" aria-hidden />
                {!collapsed ? <span>{item.label}</span> : null}
                {unreadCount > 0 ? (
                  <span
                    aria-label={`${unreadCount} unread`}
                    className={`rounded-md bg-emerald-400 px-1.5 py-0.5 text-xs font-bold text-black ${
                      collapsed ? "absolute -right-1 -top-1" : "ml-auto"
                    }`}
                  >
                    {unreadCount}
                  </span>
                ) : null}
                {collapsed ? (
                  <span
                    role="tooltip"
                    className="pointer-events-none absolute left-full ml-2 hidden whitespace-nowrap rounded-md border border-zinc-700 bg-zinc-900 px-2 py-1 text-xs text-zinc-100 shadow-lg group-hover:block group-focus-visible:block"
                  >
                    {item.label}
                  </span>
                ) : null}
              </IntentPrefetchLink>
            );
          })}
        </nav>

        <div className={`mt-8 rounded-lg border border-zinc-800 bg-zinc-900 ${collapsed ? "p-2" : "p-3"}`}>
          <div className={`flex items-center gap-2 ${collapsed ? "flex-col" : "min-w-0 justify-between"}`}>
            <div
              className={`flex min-w-0 items-center gap-2 ${collapsed ? "" : ""}`}
              title={collapsed ? `${userName} · ${userEmail}` : undefined}
            >
              <Initials name={userName} />
              {!collapsed ? (
                <div className="min-w-0">
                  <div className="truncate text-sm font-semibold text-zinc-100">{userName}</div>
                  <div className="truncate text-xs text-zinc-500">{userEmail}</div>
                </div>
              ) : null}
            </div>
            <div className={`flex shrink-0 items-center gap-2 ${collapsed ? "mt-1" : ""}`}>
              <NotificationBellLink unread={unread} />
              {/* The 3-option theme picker doesn't fit a ~72px rail - reachable by expanding
                  (the toggle above is always visible), not force-fit into the collapsed rail. */}
              {!collapsed ? <AppearanceControl current={appearance} compact /> : null}
            </div>
          </div>
          <form action={signOutAction} className="mt-3">
            <button
              type="submit"
              title={collapsed ? "Sign out" : undefined}
              aria-label="Sign out"
              className="inline-flex min-h-10 w-full items-center justify-center gap-2 rounded-md border border-zinc-700 text-sm text-zinc-300 transition hover:border-zinc-500 hover:text-zinc-50"
            >
              <LogOut className="size-4" aria-hidden />
              {!collapsed ? "Sign out" : null}
            </button>
          </form>
        </div>
      </aside>

      <header className="sticky top-0 z-20 border-b border-zinc-800 bg-zinc-950/95 px-4 py-3 backdrop-blur md:hidden">
        <div className="mb-3 flex items-center justify-between">
          <div className="flex items-center gap-2">
            <HeartHandshake className="size-5 text-emerald-300" aria-hidden />
            <span className="font-semibold">Off Shift Options</span>
          </div>
          <div className="flex items-center gap-3 text-sm text-zinc-300">
            <NotificationBellLink unread={unread} />
            <Initials name={userName} />
          </div>
        </div>
        <nav className="grid grid-cols-3 gap-2">
          {navItems.map((item) => {
            const Icon = item.icon;
            const active = isActiveRoute(pathname, item.href);
            const unreadCount = item.href === "/chat" ? unreadChat : 0;
            return (
              <IntentPrefetchLink
                key={item.href}
                href={item.href}
                aria-current={active ? "page" : undefined}
                className={`relative flex min-h-12 flex-col items-center justify-center gap-1 rounded-md text-xs transition ${
                  active ? "bg-zinc-800 text-zinc-50" : "bg-zinc-900 text-zinc-300"
                }`}
              >
                <Icon className="size-4" aria-hidden />
                {item.label}
                {unreadCount > 0 ? <span aria-label={`${unreadCount} unread`} className="absolute right-1 top-1 rounded bg-emerald-400 px-1 text-xs font-bold text-black">{unreadCount}</span> : null}
              </IntentPrefetchLink>
            );
          })}
        </nav>
      </header>
    </>
  );
}

/**
 * Navigation/Communication Cleanup ticket: Notifications is no longer a primary nav destination -
 * this is its sole remaining entry point (desktop user-area footer, mobile header), reusing the
 * same `unread` count `/notifications` used to show as a nav badge. The full history/mark-read
 * page at `/notifications` is unchanged; this is purely a smaller, secondary access point to it.
 */
function NotificationBellLink({ unread }: { unread: number }) {
  return (
    <IntentPrefetchLink
      href="/notifications"
      aria-label={unread > 0 ? `Notifications, ${unread} unread` : "Notifications"}
      className="relative inline-flex size-9 shrink-0 items-center justify-center rounded-md border border-zinc-700 text-zinc-300 transition hover:border-emerald-400/60 hover:text-emerald-200"
    >
      <Bell className="size-4" aria-hidden />
      {unread > 0 ? (
        <span
          aria-hidden
          className="absolute -right-1 -top-1 rounded-full bg-emerald-400 px-1 text-[10px] font-bold leading-tight text-black"
        >
          {unread > 99 ? "99+" : unread}
        </span>
      ) : null}
    </IntentPrefetchLink>
  );
}
