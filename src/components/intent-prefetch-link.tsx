"use client";

import { useRouter } from "next/navigation";
import { useRef } from "react";
import type { AnchorHTMLAttributes, MouseEvent } from "react";

const DEFAULT_PREFETCH_TTL_MS = 20_000;
const INTENT_DWELL_MS = 80;
const PREFETCH_MAP_KEY = "__osoIntentPrefetches";

declare global {
  interface Window {
    __osoIntentPrefetches?: Map<string, number>;
  }
}

function recentPrefetches() {
  if (typeof window === "undefined") {
    return new Map<string, number>();
  }

  window[PREFETCH_MAP_KEY] ??= new Map<string, number>();
  return window[PREFETCH_MAP_KEY];
}

type IntentPrefetchLinkProps = Omit<AnchorHTMLAttributes<HTMLAnchorElement>, "href"> & {
  href: string;
  prefetchTtlMs?: number;
  replace?: boolean;
  scroll?: boolean;
};

export function IntentPrefetchLink({
  href,
  prefetchTtlMs = DEFAULT_PREFETCH_TTL_MS,
  onFocus,
  onBlur,
  onPointerDown,
  onPointerEnter,
  onPointerLeave,
  onTouchStart,
  replace,
  scroll,
  ...props
}: IntentPrefetchLinkProps) {
  const router = useRouter();
  const intentTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  function prefetchOnIntent() {
    if (!href.startsWith("/")) {
      return;
    }

    const now = Date.now();
    const prefetches = recentPrefetches();
    const previous = prefetches.get(href);
    if (previous && now - previous < prefetchTtlMs) {
      return;
    }

    prefetches.set(href, now);
    try {
      router.prefetch(href, {
        kind: "full",
        onInvalidate: () => {
          prefetches.delete(href);
        },
      } as Parameters<typeof router.prefetch>[1]);
    } catch {
      prefetches.delete(href);
    }
  }

  function handleClick(event: MouseEvent<HTMLAnchorElement>) {
    cancelScheduledPrefetch();
    props.onClick?.(event);
    if (event.defaultPrevented || !href.startsWith("/") || isModifiedClick(event)) {
      return;
    }

    event.preventDefault();
    if (replace) {
      router.replace(href, { scroll });
    } else {
      router.push(href, { scroll });
    }
  }

  function schedulePrefetch() {
    if (intentTimerRef.current !== null) {
      return;
    }

    intentTimerRef.current = setTimeout(() => {
      intentTimerRef.current = null;
      prefetchOnIntent();
    }, INTENT_DWELL_MS);
  }

  function cancelScheduledPrefetch() {
    if (intentTimerRef.current === null) {
      return;
    }

    clearTimeout(intentTimerRef.current);
    intentTimerRef.current = null;
  }

  return (
    <a
      {...props}
      href={href}
      onClick={handleClick}
      onFocus={(event) => {
        schedulePrefetch();
        onFocus?.(event);
      }}
      onBlur={(event) => {
        cancelScheduledPrefetch();
        onBlur?.(event);
      }}
      onPointerDown={(event) => {
        cancelScheduledPrefetch();
        onPointerDown?.(event);
      }}
      onPointerEnter={(event) => {
        schedulePrefetch();
        onPointerEnter?.(event);
      }}
      onPointerLeave={(event) => {
        cancelScheduledPrefetch();
        onPointerLeave?.(event);
      }}
      onTouchStart={(event) => {
        schedulePrefetch();
        onTouchStart?.(event);
      }}
    />
  );
}

export function clearIntentPrefetchesForTests() {
  recentPrefetches().clear();
}

function isModifiedClick(event: MouseEvent<HTMLAnchorElement>) {
  const target = event.currentTarget.getAttribute("target");
  return (
    event.metaKey ||
    event.ctrlKey ||
    event.shiftKey ||
    event.altKey ||
    event.button !== 0 ||
    (target !== null && target !== "_self")
  );
}
