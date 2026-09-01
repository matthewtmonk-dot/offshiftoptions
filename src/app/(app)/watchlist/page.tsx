import { redirect } from "next/navigation";

// Watchlist was renamed to Research (2026-09) - see PROJECT_HANDOFF.md Research section.
// This route is kept only as a compatibility redirect for old links/bookmarks.
export default function WatchlistRedirectPage() {
  redirect("/research");
}
