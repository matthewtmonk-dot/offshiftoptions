"use client";

import { useState } from "react";
import { usePathname } from "next/navigation";
import {
  Bell,
  ChartNoAxesCombined,
  ChevronLeft,
  ChevronRight,
  Download,
  HeartHandshake,
  KeyRound,
  LayoutDashboard,
  ListChecks,
  LogOut,
  MessageSquareText,
  Send,
  SlidersHorizontal,
  WalletCards,
} from "lucide-react";
import { Initials } from "@/components/ui";
import { AppearanceControl } from "@/components/appearance-control";
import { IntentPrefetchLink } from "@/components/intent-prefetch-link";
import { signOutAction } from "./actions";

type Appearance = "SYSTEM" | "LIGHT" | "DARK";

const navItems = [
  { href: "/dashboard", label: "Dashboard", icon: LayoutDashboard },
  { href: "/positions", label: "Tracker", icon: WalletCards },
  { href: "/scanner", label: "Scanner", icon: ChartNoAxesCombined },
  { href: "/scanner/settings", label: "Scanner Rules", icon: SlidersHorizontal },
  { href: "/research", label: "Research", icon: ListChecks },
  { href: "/recommendations", label: "Recs", icon: Send },
  { href: "/chat", label: "Chat", icon: MessageSquareText },
  { href: "/notifications", label: "Alerts", icon: Bell },
  { href: "/account", label: "Account", icon: KeyRound },
  { href: "/install", label: "Install", icon: Download },
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
  initialCollapsed,
}: {
  userName: string;
  userEmail: string;
  appearance: Appearance;
  unread: number;
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
                {item.href === "/notifications" && unread > 0 ? (
                  <span
                    className={`rounded-md bg-emerald-400 px-1.5 py-0.5 text-xs font-bold text-black ${
                      collapsed ? "absolute -right-1 -top-1" : "ml-auto"
                    }`}
                  >
                    {unread}
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
            {/* The 3-option theme picker doesn't fit a ~72px rail - reachable by expanding
                (the toggle above is always visible), not force-fit into the collapsed rail.
                shrink-0 keeps it fully visible even when the name/email column truncates. */}
            {!collapsed ? <AppearanceControl current={appearance} compact className="shrink-0" /> : null}
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
          <div className="flex items-center gap-2 text-sm text-zinc-300">
            <Initials name={userName} />
            {unread > 0 ? <span className="rounded-md bg-emerald-400 px-2 py-1 text-xs font-bold text-black">{unread}</span> : null}
          </div>
        </div>
        <nav className="grid grid-cols-4 gap-2">
          {navItems.map((item) => {
            const Icon = item.icon;
            const active = isActiveRoute(pathname, item.href);
            return (
              <IntentPrefetchLink
                key={item.href}
                href={item.href}
                aria-current={active ? "page" : undefined}
                className={`flex min-h-12 flex-col items-center justify-center gap-1 rounded-md text-[11px] transition ${
                  active ? "bg-zinc-800 text-zinc-50" : "bg-zinc-900 text-zinc-300"
                }`}
              >
                <Icon className="size-4" aria-hidden />
                {item.label}
              </IntentPrefetchLink>
            );
          })}
        </nav>
      </header>
    </>
  );
}
