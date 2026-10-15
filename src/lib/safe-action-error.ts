/**
 * What a user may be shown (and what may travel in a redirect URL) when a settings save fails.
 *
 * Input-validation messages ("Enter a valid range for DTE.") are short, written for the user, and stay
 * as they are. Anything that looks INTERNAL - a Prisma/database error (long, quotes the query, carries a
 * code like P2028) - must never be put in a URL or on the page: it can be thousands of characters long
 * (long enough to break the redirect itself and show the generic "page couldn't load" screen) and it
 * leaks table/query details. Those become one short sentence plus a small reference code the user can
 * read back so the real cause can be found.
 */
const MAX_USER_MESSAGE_LENGTH = 200;

function errorCode(error: unknown): string | null {
  const code = (error as { code?: unknown } | null)?.code;
  return typeof code === "string" && /^[A-Za-z0-9_]{2,16}$/.test(code) ? code : null;
}

function looksInternal(error: Error): boolean {
  return (
    errorCode(error) !== null ||
    /^PrismaClient|DriverAdapter|Prisma/i.test(error.name) ||
    error.message.length > MAX_USER_MESSAGE_LENGTH ||
    /invocation|prisma|\bat\s+[^\n]*:\d+:\d+/i.test(error.message)
  );
}

export function userFacingSaveError(error: unknown, what: string): { message: string; reference: string | null; internal: boolean } {
  if (error instanceof Error && !looksInternal(error)) {
    return { message: error.message, reference: null, internal: false };
  }
  const reference = errorCode(error) ?? (error instanceof Error ? error.name.replace(/[^A-Za-z0-9]/g, "").slice(0, 40) || "Error" : "Unknown");
  return {
    message: `Couldn't ${what} (reference: ${reference}). Please try again in a moment. If it keeps happening, tell Claude this reference.`,
    reference,
    internal: true,
  };
}
