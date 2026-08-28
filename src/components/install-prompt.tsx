"use client";

import { useEffect, useState } from "react";
import { Download } from "lucide-react";

type BeforeInstallPromptEvent = Event & {
  prompt: () => Promise<void>;
  userChoice: Promise<{ outcome: "accepted" | "dismissed" }>;
};

export function InstallPrompt() {
  const [promptEvent, setPromptEvent] = useState<BeforeInstallPromptEvent | null>(null);
  const [status, setStatus] = useState("Browser support varies; HTTPS may be required outside localhost.");

  useEffect(() => {
    const handler = (event: Event) => {
      event.preventDefault();
      setPromptEvent(event as BeforeInstallPromptEvent);
      setStatus("Install prompt available on this device.");
    };

    window.addEventListener("beforeinstallprompt", handler);
    return () => window.removeEventListener("beforeinstallprompt", handler);
  }, []);

  async function install() {
    if (!promptEvent) {
      setStatus("Use your browser menu to add Off Shift Options to the Home Screen when a prompt is unavailable.");
      return;
    }

    await promptEvent.prompt();
    const choice = await promptEvent.userChoice;
    setPromptEvent(null);
    setStatus(choice.outcome === "accepted" ? "Install accepted." : "Install dismissed.");
  }

  return (
    <div className="flex flex-col gap-3 rounded-lg border border-emerald-400/20 bg-emerald-400/10 p-4">
      <button
        type="button"
        onClick={install}
        className="inline-flex min-h-11 items-center justify-center gap-2 rounded-md bg-emerald-400 px-4 text-sm font-semibold text-zinc-950 transition hover:bg-emerald-300"
      >
        <Download className="size-4" aria-hidden />
        Install Off Shift Options
      </button>
      <p className="text-sm text-zinc-300">{status}</p>
    </div>
  );
}
