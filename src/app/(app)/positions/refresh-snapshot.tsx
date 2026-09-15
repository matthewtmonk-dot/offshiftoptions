"use client";

import { useTransition } from "react";
import { useRouter } from "next/navigation";
import { RefreshCw } from "lucide-react";

export function RefreshSnapshot() {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  return (
    <button
      type="button"
      disabled={pending}
      onClick={() => startTransition(() => router.refresh())}
      className="inline-flex min-h-10 items-center gap-2 rounded-md border border-zinc-700 px-3 text-sm font-medium text-zinc-100 hover:border-sky-400 disabled:opacity-60"
    >
      <RefreshCw className={`size-4 ${pending ? "animate-spin" : ""}`} aria-hidden />
      {pending ? "Checking snapshot…" : "Refresh snapshot"}
    </button>
  );
}
