import type { ReactNode } from "react";
import { CheckCircle2, CircleAlert, CircleHelp, XCircle } from "lucide-react";

type Tone = "neutral" | "good" | "bad" | "warn" | "info";

const badgeTone: Record<Tone, string> = {
  neutral: "border-zinc-700 bg-zinc-800 text-zinc-200",
  good: "border-emerald-400/30 bg-emerald-400/15 text-emerald-200",
  bad: "border-red-400/30 bg-red-400/15 text-red-200",
  warn: "border-amber-400/30 bg-amber-400/15 text-amber-200",
  info: "border-sky-400/30 bg-sky-400/15 text-sky-200",
};

export function Panel({ title, action, children }: { title?: string; action?: ReactNode; children: ReactNode }) {
  return (
    <section className="rounded-lg border border-zinc-800 bg-zinc-950/80 p-4 shadow-sm shadow-black/20">
      {(title || action) && (
        <div className="mb-4 flex items-center justify-between gap-3">
          {title ? <h2 className="text-sm font-semibold uppercase tracking-normal text-zinc-300">{title}</h2> : <span />}
          {action}
        </div>
      )}
      {children}
    </section>
  );
}

export function Metric({ label, value, subtext }: { label: string; value: ReactNode; subtext?: ReactNode }) {
  return (
    <div className="rounded-lg border border-zinc-800 bg-zinc-900 p-4">
      <div className="text-xs uppercase tracking-normal text-zinc-500">{label}</div>
      <div className="mt-2 text-2xl font-semibold text-zinc-50">{value}</div>
      {subtext ? <div className="mt-1 text-xs text-zinc-400">{subtext}</div> : null}
    </div>
  );
}

export function Badge({ children, tone = "neutral" }: { children: ReactNode; tone?: Tone }) {
  return (
    <span className={`inline-flex items-center rounded-md border px-2 py-1 text-xs font-medium ${badgeTone[tone]}`}>
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
    <span className="inline-flex size-8 shrink-0 items-center justify-center rounded-md bg-zinc-800 text-xs font-bold text-emerald-200">
      {initials}
    </span>
  );
}

export function FieldLabel({ children }: { children: ReactNode }) {
  return <label className="text-xs font-medium uppercase tracking-normal text-zinc-400">{children}</label>;
}

export function EmptyState({ children }: { children: ReactNode }) {
  return <div className="rounded-lg border border-dashed border-zinc-800 p-4 text-sm text-zinc-400">{children}</div>;
}

export function Definition({ term, children }: { term: string; children: string }) {
  return (
    <span className="cursor-help underline decoration-zinc-600 underline-offset-4" title={children}>
      {term}
    </span>
  );
}
