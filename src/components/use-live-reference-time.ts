"use client";

import { useEffect, useState } from "react";

/**
 * Codex blocker repair (B) - a historical ("Last valid today" / "Previous session" / "Last valid
 * <date>") timing label must advance as real time passes, even on a page left open across a
 * session boundary with no new server render. Seeds from the page's own server-render instant
 * (hydration-stable: client and server agree on first paint), then advances via the ordinary
 * client wall clock - this is presentation-tier-selection only, never a trust-sensitive decision
 * like useActiveGuidanceExpired's guidance-expiry deadline (which remains fully server-calibrated
 * and untouched by this hook). No network calls, no provider polling - a minute-level interval is
 * sufficient, plus an immediate refresh on tab-visibility/window-focus resume so a throttled
 * background timer can't leave stale wording on return.
 */
export function useLiveReferenceTime(initialNow: Date): Date {
  const [now, setNow] = useState(initialNow);

  useEffect(() => {
    const tick = () => setNow(new Date());
    const interval = setInterval(tick, 60_000);
    const onVisibilityChange = () => {
      if (document.visibilityState === "visible") {
        tick();
      }
    };
    document.addEventListener("visibilitychange", onVisibilityChange);
    window.addEventListener("focus", tick);
    return () => {
      clearInterval(interval);
      document.removeEventListener("visibilitychange", onVisibilityChange);
      window.removeEventListener("focus", tick);
    };
  }, []);

  return now;
}
