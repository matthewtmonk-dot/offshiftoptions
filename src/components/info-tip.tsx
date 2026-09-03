"use client";

import { Info } from "lucide-react";
import { useEffect, useId, useRef, useState } from "react";

type InfoTipProps = {
  label: string;
  children: string;
  align?: "start" | "center" | "end";
  side?: "top" | "bottom";
  className?: string;
  testId?: string;
};

export function InfoTip({
  label,
  children,
  align = "center",
  side = "bottom",
  className = "",
  testId,
}: InfoTipProps) {
  const tooltipId = useId();
  const rootRef = useRef<HTMLSpanElement>(null);
  const [hovered, setHovered] = useState(false);
  const [focused, setFocused] = useState(false);
  const [pinned, setPinned] = useState(false);
  const open = hovered || focused || pinned;

  useEffect(() => {
    if (!open) {
      return;
    }

    function handlePointerDown(event: PointerEvent) {
      if (rootRef.current?.contains(event.target as Node)) {
        return;
      }
      setPinned(false);
      setHovered(false);
      setFocused(false);
    }

    function handleKeyDown(event: KeyboardEvent) {
      if (event.key !== "Escape") {
        return;
      }
      setPinned(false);
      setHovered(false);
      setFocused(false);
      const active = document.activeElement;
      if (active instanceof HTMLElement && rootRef.current?.contains(active)) {
        active.blur();
      }
    }

    document.addEventListener("pointerdown", handlePointerDown, true);
    document.addEventListener("keydown", handleKeyDown);
    return () => {
      document.removeEventListener("pointerdown", handlePointerDown, true);
      document.removeEventListener("keydown", handleKeyDown);
    };
  }, [open]);

  return (
    <span
      ref={rootRef}
      className={`relative inline-flex align-middle ${className}`}
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
    >
      <button
        type="button"
        aria-label={`Help: ${label}`}
        aria-describedby={open ? tooltipId : undefined}
        aria-expanded={open}
        data-testid={testId}
        className="inline-flex size-5 shrink-0 items-center justify-center rounded-full text-zinc-500 transition hover:text-sky-300 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-sky-300"
        onClick={(event) => {
          event.preventDefault();
          event.stopPropagation();
          setPinned(true);
        }}
        onFocus={() => setFocused(true)}
        onBlur={() => setFocused(false)}
      >
        <Info className="size-3.5" aria-hidden />
      </button>
      {open ? (
        <span
          id={tooltipId}
          role="tooltip"
          className={`pointer-events-none absolute z-50 w-72 max-w-[calc(100vw-2rem)] rounded-md border border-zinc-700 bg-zinc-950 px-3 py-2 text-left text-xs font-normal normal-case leading-relaxed tracking-normal text-zinc-200 shadow-xl shadow-black/40 ${placementClass(
            side,
            align,
          )}`}
        >
          {children}
        </span>
      ) : null}
    </span>
  );
}

function placementClass(side: "top" | "bottom", align: "start" | "center" | "end") {
  const vertical = side === "top" ? "bottom-full mb-2" : "top-full mt-2";
  if (align === "start") {
    return `${vertical} left-0`;
  }
  if (align === "end") {
    return `${vertical} right-0`;
  }
  return `${vertical} left-1/2 -translate-x-1/2`;
}
