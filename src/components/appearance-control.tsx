"use client";

import { useState, useTransition } from "react";
import { Monitor, Moon, Sun } from "lucide-react";
import { updateAppearanceAction } from "@/app/(app)/actions";

type Appearance = "SYSTEM" | "LIGHT" | "DARK";

const OPTIONS: { value: Appearance; label: string; icon: typeof Monitor }[] = [
  { value: "SYSTEM", label: "System", icon: Monitor },
  { value: "LIGHT", label: "Light", icon: Sun },
  { value: "DARK", label: "Dark", icon: Moon },
];

/** Applies the choice to the live page instantly (no reload, no flash) - see globals.css
 * for how the absence of data-theme falls back to the OS's prefers-color-scheme. */
function applyAppearanceToDocument(value: Appearance) {
  if (value === "SYSTEM") {
    document.documentElement.removeAttribute("data-theme");
  } else {
    document.documentElement.setAttribute("data-theme", value.toLowerCase());
  }

  try {
    document.cookie = `oso-appearance=${value.toLowerCase()}; path=/; max-age=31536000; samesite=lax`;
  } catch {
    // Cookies can be unavailable (e.g. some privacy modes) - the DB preference still persists via the server action.
  }
}

export function AppearanceControl({ current, compact = false }: { current: Appearance; compact?: boolean }) {
  const [value, setValue] = useState<Appearance>(current);
  const [isPending, startTransition] = useTransition();

  function choose(next: Appearance) {
    setValue(next);
    applyAppearanceToDocument(next);
    startTransition(() => {
      updateAppearanceAction(next).catch(() => {
        // Best-effort: the optimistic DOM/cookie change already applied; a failed persist
        // just means the choice may not survive the next fresh session load.
      });
    });
  }

  if (compact) {
    return (
      <div role="radiogroup" aria-label="Appearance" className="inline-flex rounded-md border border-zinc-800 bg-zinc-900 p-0.5">
        {OPTIONS.map((option) => {
          const Icon = option.icon;
          const active = value === option.value;
          return (
            <button
              key={option.value}
              type="button"
              role="radio"
              aria-checked={active}
              aria-label={option.label}
              title={option.label}
              disabled={isPending}
              onClick={() => choose(option.value)}
              className={`inline-flex size-7 items-center justify-center rounded transition ${
                active ? "bg-emerald-400 text-black" : "text-zinc-400 hover:text-zinc-100"
              }`}
            >
              <Icon className="size-3.5" aria-hidden />
            </button>
          );
        })}
      </div>
    );
  }

  return (
    <div role="radiogroup" aria-label="Appearance" className="inline-flex flex-wrap gap-2">
      {OPTIONS.map((option) => {
        const Icon = option.icon;
        const active = value === option.value;
        return (
          <button
            key={option.value}
            type="button"
            role="radio"
            aria-checked={active}
            disabled={isPending}
            onClick={() => choose(option.value)}
            className={`inline-flex min-h-10 items-center justify-center gap-2 rounded-md border px-3 text-sm font-medium transition ${
              active
                ? "border-emerald-400/70 bg-emerald-400/15 text-emerald-200"
                : "border-zinc-700 bg-zinc-900 text-zinc-300 hover:border-zinc-600 hover:text-zinc-50"
            }`}
          >
            <Icon className="size-4" aria-hidden />
            {option.label}
          </button>
        );
      })}
    </div>
  );
}
