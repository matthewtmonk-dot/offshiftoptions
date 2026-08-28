import { Bell, Download, Smartphone } from "lucide-react";
import { InstallPrompt } from "@/components/install-prompt";
import { Badge, Panel } from "@/components/ui";

export const dynamic = "force-dynamic";

export default function InstallPage() {
  return (
    <div className="space-y-6">
      <div>
        <p className="text-sm font-medium text-emerald-300">Progressive Web App foundation</p>
        <h1 className="text-3xl font-semibold text-zinc-50">Install LST Buddy</h1>
      </div>

      <div className="grid gap-4 lg:grid-cols-[0.8fr_1.2fr]">
        <Panel title="Install">
          <InstallPrompt />
        </Panel>
        <Panel title="PWA Status">
          <div className="grid gap-3 md:grid-cols-3">
            <div className="rounded-lg border border-zinc-800 bg-zinc-900 p-4">
              <Download className="mb-3 size-5 text-emerald-300" aria-hidden />
              <h2 className="font-semibold text-zinc-50">Manifest</h2>
              <p className="mt-2 text-sm text-zinc-400">Name, short name, standalone display, icons, and colors are configured.</p>
              <div className="mt-3"><Badge tone="good">Ready</Badge></div>
            </div>
            <div className="rounded-lg border border-zinc-800 bg-zinc-900 p-4">
              <Smartphone className="mb-3 size-5 text-emerald-300" aria-hidden />
              <h2 className="font-semibold text-zinc-50">Mobile</h2>
              <p className="mt-2 text-sm text-zinc-400">Primary workflows use cards, touch targets, and compact navigation.</p>
              <div className="mt-3"><Badge tone="good">Ready</Badge></div>
            </div>
            <div className="rounded-lg border border-zinc-800 bg-zinc-900 p-4">
              <Bell className="mb-3 size-5 text-emerald-300" aria-hidden />
              <h2 className="font-semibold text-zinc-50">Web Push</h2>
              <p className="mt-2 text-sm text-zinc-400">Subscription storage exists; push delivery waits for HTTPS and VAPID keys.</p>
              <div className="mt-3"><Badge tone="warn">Deferred</Badge></div>
            </div>
          </div>
        </Panel>
      </div>
    </div>
  );
}
