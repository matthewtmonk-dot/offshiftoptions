import { KeyRound, Save } from "lucide-react";
import { Badge, FieldLabel, Panel } from "@/components/ui";
import { requireCurrentUser } from "@/lib/auth";
import { changePasswordAction } from "../actions";

export const dynamic = "force-dynamic";

export default async function AccountPage({
  searchParams,
}: {
  searchParams: Promise<{ error?: string; saved?: string }>;
}) {
  const user = await requireCurrentUser();
  const params = await searchParams;

  return (
    <div className="space-y-6">
      <div>
        <p className="text-sm font-medium text-emerald-300">{user.name}&apos;s account</p>
        <h1 className="text-3xl font-semibold text-zinc-50">Account</h1>
      </div>

      {params.error ? (
        <div className="rounded-md border border-red-400/30 bg-red-400/10 px-3 py-2 text-sm text-red-100">
          {params.error}
        </div>
      ) : null}
      {params.saved ? (
        <div className="rounded-md border border-emerald-400/30 bg-emerald-400/10 px-3 py-2 text-sm text-emerald-100">
          Password changed. Your other signed-in sessions were signed out.
        </div>
      ) : null}

      <Panel title="Change Password">
        <form action={changePasswordAction} className="max-w-sm space-y-4">
          <div className="space-y-2">
            <FieldLabel>Current password</FieldLabel>
            <input
              name="currentPassword"
              type="password"
              autoComplete="current-password"
              required
              className="min-h-11 w-full rounded-md border border-zinc-700 bg-zinc-950 px-3 text-sm text-zinc-50 outline-none focus:border-emerald-400"
            />
          </div>
          <div className="space-y-2">
            <FieldLabel>New password</FieldLabel>
            <input
              name="newPassword"
              type="password"
              autoComplete="new-password"
              minLength={10}
              required
              className="min-h-11 w-full rounded-md border border-zinc-700 bg-zinc-950 px-3 text-sm text-zinc-50 outline-none focus:border-emerald-400"
            />
            <p className="text-xs text-zinc-500">At least 10 characters, with both letters and numbers.</p>
          </div>
          <div className="space-y-2">
            <FieldLabel>Confirm new password</FieldLabel>
            <input
              name="confirmPassword"
              type="password"
              autoComplete="new-password"
              minLength={10}
              required
              className="min-h-11 w-full rounded-md border border-zinc-700 bg-zinc-950 px-3 text-sm text-zinc-50 outline-none focus:border-emerald-400"
            />
          </div>
          <button
            type="submit"
            className="inline-flex min-h-11 w-full items-center justify-center gap-2 rounded-md bg-emerald-400 px-4 text-sm font-semibold text-zinc-950 hover:bg-emerald-300"
          >
            <Save className="size-4" aria-hidden />
            Update Password
          </button>
        </form>
      </Panel>

      <Panel title="Session">
        <div className="flex items-start gap-3">
          <KeyRound className="mt-0.5 size-5 text-emerald-300" aria-hidden />
          <div className="space-y-2 text-sm text-zinc-400">
            <p>
              Signed in as <span className="font-medium text-zinc-200">{user.email}</span>.
            </p>
            <p>Changing your password signs out any other browsers or devices currently signed in as you.</p>
            <Badge tone="neutral">This account is private to Off Shift Options — no public signup exists.</Badge>
          </div>
        </div>
      </Panel>
    </div>
  );
}
