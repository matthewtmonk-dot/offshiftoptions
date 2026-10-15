import Link from "next/link";
import { Panel } from "@/components/ui";
import { requireCurrentUser } from "@/lib/auth";
import { getBuildInfo } from "@/lib/build-info";
import { processInfo, readDiagnostics, type DiagnosticEvent } from "@/lib/diagnostics";

export const dynamic = "force-dynamic";

const etFormatter = new Intl.DateTimeFormat("en-US", {
  timeZone: "America/New_York",
  month: "short",
  day: "numeric",
  hour: "numeric",
  minute: "2-digit",
  second: "2-digit",
});

function when(iso: string) {
  const date = new Date(iso);
  return Number.isNaN(date.getTime()) ? iso : `${etFormatter.format(date)} ET`;
}

function uptimeLabel(seconds: number) {
  if (seconds < 90) return `${seconds} seconds`;
  if (seconds < 5400) return `${Math.round(seconds / 60)} minutes`;
  return `${Math.round(seconds / 3600)} hours`;
}

const KIND_TONE: Record<DiagnosticEvent["kind"], string> = {
  boot: "text-sky-300",
  exit: "text-amber-300",
  error: "text-red-300",
  action: "text-zinc-300",
};

/**
 * Self-service view of what the server has been doing (see src/lib/diagnostics.ts) - for working out why
 * something failed without access to hosting logs. Signed-in users only. Contains no secrets: messages
 * are sanitized when they are recorded.
 */
export default async function DiagnosticsPage() {
  await requireCurrentUser();
  const build = getBuildInfo();
  const process_ = processInfo();
  const { events, readable } = readDiagnostics(80);

  return (
    <div className="space-y-4">
      <div>
        <p className="text-sm font-medium text-emerald-300">Account</p>
        <h1 className="text-3xl font-semibold text-zinc-50">Diagnostics</h1>
        <p className="mt-1 max-w-2xl text-sm text-zinc-400">
          What the server has been doing, newest first. If something failed, open this page right afterwards and screenshot it for Claude.{" "}
          <Link href="/account" className="text-sky-300 hover:text-sky-200">Back to Account</Link>
        </p>
      </div>

      <Panel title="This server">
        <dl className="grid gap-x-6 gap-y-2 text-sm sm:grid-cols-2">
          <div><dt className="text-zinc-500">App version</dt><dd className="font-mono text-zinc-200">{build.commit}</dd></div>
          <div><dt className="text-zinc-500">Built</dt><dd className="text-zinc-200">{build.buildTime ? when(build.buildTime) : "unknown"}</dd></div>
          <div><dt className="text-zinc-500">Server started</dt><dd className="text-zinc-200">{when(process_.startedAt)} ({uptimeLabel(process_.uptimeSeconds)} ago)</dd></div>
          <div><dt className="text-zinc-500">Memory in use</dt><dd className="text-zinc-200">{process_.memoryMb} MB</dd></div>
        </dl>
        <p className="mt-3 text-xs text-zinc-500">
          If &quot;Server started&quot; is only minutes ago right after a failure, the server restarted - that is usually the cause.
        </p>
      </Panel>

      <Panel title="Recent events">
        {!readable ? (
          <p className="text-sm text-zinc-400">No log yet. Events appear here after something is recorded (a server start, an error, or a settings save).</p>
        ) : events.length === 0 ? (
          <p className="text-sm text-zinc-400">Nothing recorded yet.</p>
        ) : (
          <ul className="divide-y divide-zinc-800 text-sm" data-testid="diagnostic-events">
            {events.map((event, index) => (
              <li key={`${event.at}-${index}`} className="flex flex-col gap-0.5 py-2 sm:flex-row sm:gap-4">
                <span className="w-44 shrink-0 text-xs text-zinc-500 tabular-nums">{when(event.at)}</span>
                <span className={`w-14 shrink-0 text-xs font-semibold uppercase ${KIND_TONE[event.kind] ?? "text-zinc-300"}`}>{event.kind}</span>
                <span className="min-w-0 text-zinc-300">
                  <span className="font-medium text-zinc-100">{event.source}</span>
                  {event.message ? <span className="text-zinc-400"> - {event.message}</span> : null}
                  {event.durationMs !== undefined ? <span className="text-zinc-500"> ({(event.durationMs / 1000).toFixed(1)}s)</span> : null}
                  {event.digest ? <span className="font-mono text-xs text-zinc-500"> ref {event.digest}</span> : null}
                </span>
              </li>
            ))}
          </ul>
        )}
      </Panel>
    </div>
  );
}
