import { LockKeyhole } from "lucide-react";
import { redirect } from "next/navigation";
import { getCurrentUser } from "@/lib/auth";
import { signInAction } from "./actions";

export const dynamic = "force-dynamic";

export default async function LoginPage({
  searchParams,
}: {
  searchParams: Promise<{ error?: string }>;
}) {
  const user = await getCurrentUser();
  if (user) {
    redirect("/dashboard");
  }

  const params = await searchParams;
  const showDevLogin = process.env.NODE_ENV !== "production";
  const devPassword = process.env.DEV_SEED_PASSWORD ?? "lstbuddy-dev-only";

  return (
    <main className="flex min-h-screen items-center justify-center bg-[radial-gradient(circle_at_top_left,rgba(52,211,153,0.16),transparent_34%),linear-gradient(135deg,#090d0b,#18181b_58%,#0f1720)] px-4 py-10">
      <section className="w-full max-w-md rounded-lg border border-zinc-800 bg-zinc-950/90 p-6 shadow-2xl shadow-black/40">
        <div className="mb-8 flex items-center gap-3">
          <div className="flex size-11 items-center justify-center rounded-md bg-emerald-400 text-zinc-950">
            <LockKeyhole className="size-5" aria-hidden />
          </div>
          <div>
            <h1 className="text-2xl font-semibold text-zinc-50">LST Buddy</h1>
            <p className="text-sm text-zinc-400">Demo/manual research workspace</p>
          </div>
        </div>

        <form action={signInAction} className="space-y-4">
          <div className="space-y-2">
            <label className="text-sm font-medium text-zinc-300" htmlFor="email">
              Email
            </label>
            <input
              id="email"
              name="email"
              type="email"
              autoComplete="email"
              required
              placeholder="matt@lst.local"
              className="min-h-12 w-full rounded-md border border-zinc-700 bg-zinc-900 px-3 text-zinc-50 outline-none transition focus:border-emerald-400"
            />
          </div>
          <div className="space-y-2">
            <label className="text-sm font-medium text-zinc-300" htmlFor="password">
              Password
            </label>
            <input
              id="password"
              name="password"
              type="password"
              autoComplete="current-password"
              required
              className="min-h-12 w-full rounded-md border border-zinc-700 bg-zinc-900 px-3 text-zinc-50 outline-none transition focus:border-emerald-400"
            />
          </div>

          {params.error ? (
            <div className="rounded-md border border-red-400/30 bg-red-400/10 px-3 py-2 text-sm text-red-200">
              Email or password did not match a seeded development user.
            </div>
          ) : null}

          <button
            type="submit"
            className="min-h-12 w-full rounded-md bg-emerald-400 px-4 text-sm font-semibold text-zinc-950 transition hover:bg-emerald-300"
          >
            Sign in
          </button>
        </form>

        {showDevLogin ? (
          <div className="mt-5 grid gap-2 sm:grid-cols-2">
            <form action={signInAction}>
              <input type="hidden" name="email" value="matt@lst.local" />
              <input type="hidden" name="password" value={devPassword} />
              <button
                type="submit"
                className="min-h-11 w-full rounded-md border border-zinc-700 px-3 text-sm font-medium text-zinc-200 transition hover:border-emerald-400/60 hover:text-emerald-200"
              >
                Login as Matt
              </button>
            </form>
            <form action={signInAction}>
              <input type="hidden" name="email" value="eric@lst.local" />
              <input type="hidden" name="password" value={devPassword} />
              <button
                type="submit"
                className="min-h-11 w-full rounded-md border border-zinc-700 px-3 text-sm font-medium text-zinc-200 transition hover:border-emerald-400/60 hover:text-emerald-200"
              >
                Login as Eric
              </button>
            </form>
          </div>
        ) : null}

        <div className="mt-6 rounded-md border border-zinc-800 bg-zinc-900/70 p-3 text-sm text-zinc-400">
          Seed users are Matt and Eric. The password comes from DEV_SEED_PASSWORD.
        </div>
      </section>
    </main>
  );
}
