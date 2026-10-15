"use client";

import { useRouter } from "next/navigation";
import { createContext, useContext, useEffect, useRef, useState, type FormEvent, type ReactNode } from "react";
import type { SettingsActionResult } from "@/lib/safe-action-error";
import { submitSettingsAction, type SettingsStatus } from "./settings-action";

/**
 * One status line for the whole Scanner Rules page. Any of its forms (Save, Reset, Roll Buffer) reports
 * here, so the outcome always appears in the same place - at the top - whichever button was pressed.
 */
const StatusContext = createContext<{ status: SettingsStatus; setStatus: (status: SettingsStatus) => void } | null>(null);

export function SettingsStatusProvider({ children }: { children: ReactNode }) {
  const [status, setStatus] = useState<SettingsStatus>({ kind: "idle" });
  return <StatusContext.Provider value={{ status, setStatus }}>{children}</StatusContext.Provider>;
}

export function SettingsStatusBanner() {
  const context = useContext(StatusContext);
  const ref = useRef<HTMLDivElement>(null);
  const kind = context?.status.kind ?? "idle";

  useEffect(() => {
    // After a Save the user is usually scrolled well down the page - bring the result into view.
    if (kind === "success" || kind === "error") ref.current?.scrollIntoView({ behavior: "smooth", block: "nearest" });
  }, [kind]);

  if (!context || context.status.kind === "idle") return null;
  const { status } = context;
  const tone =
    status.kind === "success"
      ? "border-emerald-400/30 bg-emerald-400/10 text-emerald-100"
      : status.kind === "error"
        ? "border-red-400/30 bg-red-400/10 text-red-100"
        : "border-zinc-700 bg-zinc-900 text-zinc-300";
  return (
    <div ref={ref} role={status.kind === "error" ? "alert" : "status"} aria-live="polite" data-testid="settings-status" className={`rounded-md border px-3 py-2 text-sm ${tone}`}>
      {status.kind === "pending" ? "Saving… this can take a few seconds." : status.message}
      {status.kind === "error" ? (
        <>
          {" "}
          <a href="/account/diagnostics" target="_blank" rel="noopener" className="underline underline-offset-2">Open diagnostics</a>
        </>
      ) : null}
    </div>
  );
}

/**
 * A settings form that calls its server action from the browser and shows the result inline (see
 * settings-action.ts), then refreshes the page data. `revision` changes whenever the saved settings do,
 * which remounts the form so its fields show the freshly-saved values (they are uncontrolled).
 */
export function SettingsActionForm({
  action,
  revision,
  className,
  children,
}: {
  action: (formData: FormData) => Promise<SettingsActionResult>;
  revision: number;
  className?: string;
  children: ReactNode;
}) {
  const router = useRouter();
  const context = useContext(StatusContext);
  const [pending, setPending] = useState(false);

  async function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (pending) return;
    const formData = new FormData(event.currentTarget); // read BEFORE the fieldset below disables the fields
    setPending(true);
    context?.setStatus({ kind: "pending" });
    const result = await submitSettingsAction(action, formData);
    context?.setStatus(result);
    setPending(false);
    if (result.kind === "success") router.refresh();
  }

  return (
    // `action` is the server action itself on purpose: if the user presses Save before the page's
    // JavaScript is ready (a slow connection, a fast click), the browser posts it straight to the server
    // and the save still happens - instead of the browser's default form submit, which would put every
    // field in the address bar and save nothing. Once the page is ready, onSubmit takes over (it calls
    // preventDefault, and React then skips `action`), so the result shows inline.
    <form key={revision} action={action as unknown as (formData: FormData) => void} onSubmit={onSubmit} className={className} aria-busy={pending}>
      <fieldset disabled={pending} className="contents">
        {children}
      </fieldset>
    </form>
  );
}
