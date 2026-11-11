"use client";

import { useState } from "react";
import { usePathname } from "next/navigation";
import {
  Bell,
  ChartNoAxesCombined,
  ChevronLeft,
  ChevronRight,
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
        className={`relative hidden shrink-0 border-r border-zinc-800 bg-zinc-900 transition-[width] duration-150 motion-reduce:transition-none md:block ${
          collapsed ? "w-18" : "w-60"
        }`}
      >
        <button
          type="button"
          onClick={toggleCollapsed}
          aria-label={collapsed ? "Expand sidebar" : "Collapse sidebar"}
          aria-expanded={!collapsed}
          data-testid="sidebar-toggle"
          className="absolute -right-3 top-5 z-10 flex size-6 items-center justify-center rounded-full border border-zinc-700 bg-zinc-900 text-zinc-500 shadow-sm transition hover:border-zinc-500 hover:text-zinc-100"
        >
          {collapsed ? <ChevronRight className="size-3.5" aria-hidden /> : <ChevronLeft className="size-3.5" aria-hidden />}
        </button>

        {/* Stays in view while the page scrolls, so navigation and the account controls never scroll away. */}
        <div className={`sticky top-0 flex h-screen flex-col py-4 ${collapsed ? "px-2" : "px-3"}`}>
          <div className={`mb-5 flex items-center gap-2.5 ${collapsed ? "justify-center" : "px-2"}`}>
            <BrandMark />
            {!collapsed ? (
              <div className="min-w-0">
                <div className="truncate text-[15px] font-semibold leading-tight text-zinc-50">Off Shift Options</div>
                <div className="truncate text-xs text-zinc-500">Read-only Schwab tracking</div>
              </div>
            ) : null}
          </div>

          <nav className="space-y-0.5">
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
                  className={`group relative flex min-h-10 items-center gap-3 rounded-md text-sm transition ${
                    collapsed ? "justify-center px-0" : "px-2.5"
                  } ${active ? "bg-zinc-950 font-semibold text-zinc-50" : "font-medium text-zinc-400 hover:bg-zinc-950 hover:text-zinc-50"}`}
                >
                  {active ? <span aria-hidden className="absolute inset-y-2 left-0 w-0.5 rounded-full bg-sky-400" /> : null}
                  <Icon className={`size-[18px] shrink-0 ${active ? "text-sky-300" : ""}`} aria-hidden />
                  {!collapsed ? <span>{item.label}</span> : null}
                  {unreadCount > 0 ? (
                    <span
                      aria-label={`${unreadCount} unread`}
                      className={`rounded-full bg-sky-400 px-1.5 text-[11px] font-semibold leading-5 text-on-accent ${
                        collapsed ? "absolute -right-0.5 -top-0.5" : "ml-auto"
                      }`}
                    >
                      {unreadCount}
                    </span>
                  ) : null}
                  {collapsed ? (
                    <span
                      role="tooltip"
                      className="pointer-events-none absolute left-full z-20 ml-2 hidden whitespace-nowrap rounded-md border border-zinc-700 bg-zinc-900 px-2 py-1 text-xs text-zinc-100 shadow-lg group-hover:block group-focus-visible:block"
                    >
                      {item.label}
                    </span>
                  ) : null}
                </IntentPrefetchLink>
              );
            })}
          </nav>

          <div className={`mt-auto border-t border-zinc-800 pt-3 ${collapsed ? "" : "px-1"}`}>
            <div className={`flex items-center gap-2.5 ${collapsed ? "justify-center" : "min-w-0"}`} title={collapsed ? `${userName} · ${userEmail}` : undefined}>
              <Initials name={userName} />
              {!collapsed ? (
                <div className="min-w-0">
                  <div className="truncate text-sm font-semibold text-zinc-100">{userName}</div>
                  <div className="truncate text-xs text-zinc-500">{userEmail}</div>
                </div>
              ) : null}
            </div>
            <div className={`mt-3 flex items-center gap-2 ${collapsed ? "flex-col" : "justify-between"}`}>
              <NotificationBellLink unread={unread} />
              {/* The 3-option theme picker doesn't fit a ~72px rail - reachable by expanding
                  (the toggle above is always visible), not force-fit into the collapsed rail. */}
              {!collapsed ? <AppearanceControl current={appearance} compact /> : null}
              <form action={signOutAction}>
                <button
                  type="submit"
                  title="Sign out"
                  aria-label="Sign out"
                  className="inline-flex size-8 items-center justify-center rounded-md border border-zinc-800 text-zinc-400 transition hover:border-zinc-600 hover:text-zinc-50"
                >
                  <LogOut className="size-4" aria-hidden />
                </button>
              </form>
            </div>
          </div>
        </div>
      </aside>

      <header className="sticky top-0 z-20 border-b border-zinc-800 bg-zinc-950/95 px-4 py-3 backdrop-blur md:hidden">
        <div className="mb-3 flex items-center justify-between">
          <div className="flex items-center gap-2">
            <BrandMark />
            <span className="text-[15px] font-semibold text-zinc-50">Off Shift Options</span>
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
                  active ? "bg-zinc-800 text-sky-200" : "bg-zinc-900 text-zinc-300"
                }`}
              >
                <Icon className="size-4" aria-hidden />
                {item.label}
                {unreadCount > 0 ? <span aria-label={`${unreadCount} unread`} className="absolute right-1 top-1 rounded-full bg-sky-400 px-1.5 text-[11px] font-semibold leading-4 text-on-accent">{unreadCount}</span> : null}
              </IntentPrefetchLink>
            );
          })}
        </nav>
      </header>
    </>
  );
}

/**
 * The app's mark: the initials on an ink tile. `bg-zinc-100 text-zinc-950` inverts with the theme
 * (dark tile in Light, light tile in Dark), so it never needs a per-theme color.
 */
function BrandMark() {
  return (
    <span aria-hidden className="inline-flex size-8 shrink-0 items-center justify-center rounded-lg bg-zinc-100 text-[13px] font-bold tracking-tight text-zinc-950">
      OS
    </span>
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
      className="relative inline-flex size-8 shrink-0 items-center justify-center rounded-md border border-zinc-800 text-zinc-400 transition hover:border-zinc-600 hover:text-zinc-50"
    >
      <Bell className="size-4" aria-hidden />
      {unread > 0 ? (
        <span
          aria-hidden
          className="absolute -right-1.5 -top-1.5 rounded-full bg-sky-400 px-1 text-[10px] font-semibold leading-4 text-on-accent"
        >
          {unread > 99 ? "99+" : unread}
        </span>
      ) : null}
    </IntentPrefetchLink>
  );
}
