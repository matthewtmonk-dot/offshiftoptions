"use client";

import { Info } from "lucide-react";
import { useEffect, useId, useRef, useState, type CSSProperties } from "react";
import { createPortal } from "react-dom";

type InfoTipProps = {
  label: string;
  children: string;
  align?: "start" | "center" | "end";
  side?: "top" | "bottom";
  className?: string;
  testId?: string;
};

const TIP_WIDTH = 288;
const SCREEN_MARGIN = 8;
/** Rough height used only to decide whether the tip fits below (or above) the icon. */
const TIP_ESTIMATED_HEIGHT = 170;

/**
 * Where the tip sits, in screen coordinates, so it is never cut off: it is drawn on top of the page (not inside the
 * card that holds the icon, which would clip it), kept inside the screen's left and right edges, and flipped above
 * the icon when there is no room below.
 */
function tipStyle(button: HTMLElement, side: "top" | "bottom", align: "start" | "center" | "end"): CSSProperties {
  const rect = button.getBoundingClientRect();
  const viewportWidth = window.innerWidth;
  const viewportHeight = window.innerHeight;
  const width = Math.min(TIP_WIDTH, viewportWidth - SCREEN_MARGIN * 2);
  const wantedLeft = align === "start" ? rect.left : align === "end" ? rect.right - width : rect.left + rect.width / 2 - width / 2;
  const left = Math.max(SCREEN_MARGIN, Math.min(wantedLeft, viewportWidth - width - SCREEN_MARGIN));
  const fitsBelow = rect.bottom + 8 + TIP_ESTIMATED_HEIGHT <= viewportHeight;
  const fitsAbove = rect.top - 8 - TIP_ESTIMATED_HEIGHT >= 0;
  const placeBelow = side === "bottom" ? fitsBelow || !fitsAbove : !fitsAbove && fitsBelow;
  return placeBelow ? { position: "fixed", top: rect.bottom + 8, left, width } : { position: "fixed", bottom: viewportHeight - rect.top + 8, left, width };
}

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
  const buttonRef = useRef<HTMLButtonElement>(null);
  const [hovered, setHovered] = useState(false);
  const [focused, setFocused] = useState(false);
  const [pinned, setPinned] = useState(false);
  const [style, setStyle] = useState<CSSProperties | null>(null);
  const open = hovered || focused || pinned;

  function place() {
    if (buttonRef.current) setStyle(tipStyle(buttonRef.current, side, align));
  }

  useEffect(() => {
    if (!open) {
      return;
    }

    function closeAll() {
      setPinned(false);
      setHovered(false);
      setFocused(false);
    }

    function handlePointerDown(event: PointerEvent) {
      if (rootRef.current?.contains(event.target as Node)) {
        return;
      }
      closeAll();
    }

    function handleKeyDown(event: KeyboardEvent) {
      if (event.key !== "Escape") {
        return;
      }
      closeAll();
      const active = document.activeElement;
      if (active instanceof HTMLElement && rootRef.current?.contains(active)) {
        active.blur();
      }
    }

    // The tip is positioned in screen coordinates, so scrolling or resizing would leave it behind the icon.
    document.addEventListener("pointerdown", handlePointerDown, true);
    document.addEventListener("keydown", handleKeyDown);
    window.addEventListener("scroll", closeAll, true);
    window.addEventListener("resize", closeAll);
    return () => {
      document.removeEventListener("pointerdown", handlePointerDown, true);
      document.removeEventListener("keydown", handleKeyDown);
      window.removeEventListener("scroll", closeAll, true);
      window.removeEventListener("resize", closeAll);
    };
  }, [open]);

  return (
    <span
      ref={rootRef}
      className={`relative inline-flex align-middle ${className}`}
      onMouseEnter={() => {
        place();
        setHovered(true);
      }}
      onMouseLeave={() => setHovered(false)}
    >
      <button
        ref={buttonRef}
        type="button"
        aria-label={`Help: ${label}`}
        aria-describedby={open ? tooltipId : undefined}
        aria-expanded={open}
        data-testid={testId}
        className="inline-flex size-5 shrink-0 items-center justify-center rounded-full text-zinc-500 transition hover:text-sky-300 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-sky-300"
        onClick={(event) => {
          event.preventDefault();
          event.stopPropagation();
          place();
          setPinned(true);
        }}
        onFocus={() => {
          place();
          setFocused(true);
        }}
        onBlur={() => setFocused(false)}
      >
        <Info className="size-3.5" aria-hidden />
      </button>
      {open && style
        ? createPortal(
            <span
              id={tooltipId}
              role="tooltip"
              style={style}
              className="pointer-events-none z-50 rounded-md border border-zinc-700 bg-zinc-950 px-3 py-2 text-left text-xs font-normal normal-case leading-relaxed tracking-normal text-zinc-200 shadow-xl shadow-black/40"
            >
              {children}
            </span>,
            document.body,
          )
        : null}
    </span>
  );
}
