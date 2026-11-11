import type { ReactNode } from "react";
import { CheckCircle2, CircleAlert, CircleHelp, XCircle } from "lucide-react";

type Tone = "neutral" | "good" | "bad" | "warn" | "info";

const badgeTone: Record<Tone, string> = {
  neutral: "border-zinc-700 bg-zinc-800 text-zinc-300",
  good: "border-emerald-400/40 bg-emerald-400/15 text-emerald-200",
  bad: "border-red-400/40 bg-red-400/15 text-red-200",
  warn: "border-amber-400/40 bg-amber-400/15 text-amber-200",
  info: "border-sky-400/40 bg-sky-400/15 text-sky-200",
};

export function Panel({ title, action, children }: { title?: string; action?: ReactNode; children: ReactNode }) {
  return (
    <section className="rounded-lg border border-zinc-800 bg-zinc-900 p-4 shadow-[0_1px_2px_rgba(16,24,40,0.05)]">
      {(title || action) && (
        <div className="mb-3 flex items-center justify-between gap-3">
          {title ? <h2 className="text-[15px] font-semibold text-zinc-100">{title}</h2> : <span />}
          {action}
        </div>
      )}
      {children}
    </section>
  );
}

export function Metric({ label, value, subtext }: { label: string; value: ReactNode; subtext?: ReactNode }) {
  return (
    <div className="rounded-lg border border-zinc-800 bg-zinc-900 p-4 shadow-[0_1px_2px_rgba(16,24,40,0.05)]">
      <div className="text-[13px] font-medium text-zinc-500">{label}</div>
      <div className="mt-1.5 text-[26px] font-semibold leading-tight text-zinc-50">{value}</div>
      {subtext ? <div className="mt-1.5 text-[13px] text-zinc-400">{subtext}</div> : null}
    </div>
  );
}

export function Badge({ children, tone = "neutral" }: { children: ReactNode; tone?: Tone }) {
  return (
    <span className={`inline-flex items-center whitespace-nowrap rounded-md border px-2 py-0.5 text-xs font-semibold ${badgeTone[tone]}`}>
      {children}
    </span>
  );
}

export function StatusBadge({ status }: { status: string }) {
  const tone = status === "PASS" ? "good" : status === "FAIL" ? "bad" : "neutral";
  const Icon = status === "PASS" ? CheckCircle2 : status === "FAIL" ? XCircle : status === "UNKNOWN" ? CircleHelp : CircleAlert;
  return (
    <Badge tone={tone}>
      <Icon className="mr-1 size-3.5" aria-hidden />
      {status}
    </Badge>
  );
}

export function Initials({ name }: { name: string }) {
  const initials = name
    .split(" ")
    .map((part) => part[0])
    .join("")
    .slice(0, 2)
    .toUpperCase();

  return (
    <span className="inline-flex size-8 shrink-0 items-center justify-center rounded-full bg-zinc-800 text-xs font-semibold text-zinc-200">
      {initials}
    </span>
  );
}

export function FieldLabel({ children }: { children: ReactNode }) {
  return <label className="text-xs font-medium text-zinc-400">{children}</label>;
}

export function EmptyState({ children }: { children: ReactNode }) {
  return <div className="rounded-md border border-dashed border-zinc-700 px-3.5 py-3 text-sm text-zinc-400">{children}</div>;
}

export function Definition({ term, children }: { term: string; children: string }) {
  return (
    <span className="cursor-help underline decoration-zinc-600 underline-offset-4" title={children}>
      {term}
    </span>
  );
}

/**
 * The one look for "pick one of a few" switches (Tracker tabs, Scanner mode, Mine / buddy / Both, theme): a quiet
 * tray with the selected option raised on the panel surface. Selection is neutral on purpose - green is reserved for
 * money made / PASS and blue for links - so a selected tab never reads as a result or a button to press.
 * Plain strings (not a component) so both server and client files can use them on their own link / button elements.
 */
export const segmentedGroupClass = "inline-flex rounded-md border border-zinc-800 bg-zinc-950 p-0.5";

export function segmentedItemClass(active: boolean) {
  return `inline-flex min-h-8 items-center rounded px-3 text-sm transition ${
    active ? "bg-zinc-900 font-semibold text-zinc-50 shadow-sm ring-1 ring-zinc-700" : "font-medium text-zinc-500 hover:text-zinc-100"
  }`;
}

/** The one primary (filled) action button. Fill and text are theme-aware together (see --on-accent in globals.css). */
export const primaryButtonClass =
  "inline-flex min-h-9 items-center justify-center gap-2 rounded-md bg-emerald-400 px-3.5 text-sm font-semibold text-on-accent shadow-[0_1px_2px_rgba(16,24,40,0.1)] transition hover:bg-emerald-300 disabled:opacity-60";

/** The one secondary (outlined) action button. */
export const secondaryButtonClass =
  "inline-flex min-h-9 items-center justify-center gap-2 rounded-md border border-zinc-700 bg-zinc-900 px-3 text-sm font-medium text-zinc-200 shadow-[0_1px_2px_rgba(16,24,40,0.05)] transition hover:border-zinc-500 hover:text-zinc-50 disabled:opacity-60";
