import { LoaderCircle } from "lucide-react";

export function RouteLoading({ title = "Loading", detail }: { title?: string; detail?: string }) {
  return (
    <div className="space-y-4" aria-busy="true" aria-live="polite">
      <div className="flex flex-wrap items-center justify-between gap-3 rounded-lg border border-zinc-800 bg-zinc-950/80 p-4 shadow-sm shadow-black/20">
        <div className="flex items-center gap-3">
          <LoaderCircle className="size-4 animate-spin text-emerald-300" aria-hidden />
          <div>
            <div className="text-sm font-semibold text-zinc-100">{title}</div>
            {detail ? <div className="mt-0.5 text-xs text-zinc-500">{detail}</div> : null}
          </div>
        </div>
        <div className="hidden h-2 w-28 overflow-hidden rounded-full bg-zinc-800 sm:block">
          <div className="h-full w-1/2 animate-pulse rounded-full bg-emerald-300/70" />
        </div>
      </div>
      <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
        {[0, 1, 2, 3].map((index) => (
          <div key={index} className="h-24 rounded-lg border border-zinc-800 bg-zinc-950/65 p-4">
            <div className="h-3 w-20 animate-pulse rounded bg-zinc-800" />
            <div className="mt-5 h-6 w-24 animate-pulse rounded bg-zinc-800/80" />
            <div className="mt-3 h-2 w-32 animate-pulse rounded bg-zinc-900" />
          </div>
        ))}
      </div>
    </div>
  );
}
