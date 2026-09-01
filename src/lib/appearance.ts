import "server-only";

import { cookies } from "next/headers";
import type { AppearanceMode } from "@/generated/prisma/enums";
import { getCurrentUser } from "./auth";
import { prisma } from "./prisma";

export const APPEARANCE_COOKIE = "oso-appearance";
const APPEARANCE_COOKIE_MAX_AGE = 60 * 60 * 24 * 365; // 1 year - not sensitive, just a display preference.

export type ResolvedAppearance = {
  appearance: AppearanceMode;
  /** "user" when a logged-in user's own DB preference was used (always authoritative when
   * available); "cookie" for a logged-out visitor's previously-set preference; "default"
   * when neither exists (brand-new, logged-out visitor). */
  source: "user" | "cookie" | "default";
};

function isAppearanceMode(value: string | undefined): value is AppearanceMode {
  return value === "DARK" || value === "LIGHT" || value === "SYSTEM";
}

/**
 * Resolves which appearance to render for the CURRENT request, for use in the root
 * layout (which renders <html> and cannot itself be inside an authenticated route group).
 * A logged-in user's own database preference is always authoritative - this is what
 * guarantees an existing user stays on the appearance they picked (or DARK, if they've
 * never changed it - see the migration) even if their browser's cookie was cleared or
 * they're on a new device. A logged-out visitor falls back to the non-sensitive
 * `oso-appearance` cookie, then to SYSTEM if nothing is set yet.
 */
export async function resolveAppearanceForRequest(): Promise<ResolvedAppearance> {
  const user = await getCurrentUser();
  if (user) {
    const appearance = user.settings?.appearance ?? "DARK";
    return { appearance, source: "user" };
  }

  const cookieStore = await cookies();
  const cookieValue = cookieStore.get(APPEARANCE_COOKIE)?.value;
  if (isAppearanceMode(cookieValue)) {
    return { appearance: cookieValue, source: "cookie" };
  }

  return { appearance: "SYSTEM", source: "default" };
}

/** The `data-theme` attribute value for <html> - omit the attribute entirely for SYSTEM so
 * the browser's own `prefers-color-scheme` CSS media query resolves it with no JS and no
 * flash (see globals.css). */
export function dataThemeAttributeFor(appearance: AppearanceMode): "dark" | "light" | undefined {
  if (appearance === "DARK") return "dark";
  if (appearance === "LIGHT") return "light";
  return undefined;
}

export async function updateAppearanceForUser(userId: string, appearance: AppearanceMode) {
  await prisma.userSettings.upsert({
    where: { userId },
    update: { appearance },
    create: { userId, appearance },
  });

  // Keep the non-sensitive cookie in sync so a subsequent logged-out view (or the next
  // request before the DB round-trip would otherwise be re-read) reflects the same choice.
  const cookieStore = await cookies();
  cookieStore.set(APPEARANCE_COOKIE, appearance.toLowerCase(), {
    httpOnly: false,
    sameSite: "lax",
    secure: process.env.NODE_ENV === "production",
    path: "/",
    maxAge: APPEARANCE_COOKIE_MAX_AGE,
  });
}
