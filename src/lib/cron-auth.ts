import "server-only";

import { timingSafeEqual } from "node:crypto";

/** Server-side only. Never expose this value to a client component, log line, error message, or response body. */
export function getOsoCronSecret(): string | null {
  return process.env.OSO_CRON_SECRET?.trim() || null;
}

export type CronConfigStatus = {
  configured: boolean;
};

export function getCronConfigStatus(): CronConfigStatus {
  return { configured: Boolean(getOsoCronSecret()) };
}

/**
 * Constant-time secret comparison so a wrong guess can't be timed to learn how many leading
 * characters matched. Returns false immediately (without comparing) if the secret isn't
 * configured or nothing was provided - a misconfigured server must never accidentally accept
 * every request.
 */
export function isValidCronSecret(provided: string | null): boolean {
  const expected = getOsoCronSecret();
  if (!expected || !provided) {
    return false;
  }

  const expectedBuffer = Buffer.from(expected);
  const providedBuffer = Buffer.from(provided);
  if (expectedBuffer.length !== providedBuffer.length) {
    return false;
  }

  return timingSafeEqual(expectedBuffer, providedBuffer);
}

/** Reads the shared secret from `Authorization: Bearer <secret>` or a plain `X-OSO-Cron-Secret` header - never from a query string or URL. */
export function extractProvidedCronSecret(headers: Headers): string | null {
  const authHeader = headers.get("authorization");
  if (authHeader) {
    const [scheme, ...rest] = authHeader.trim().split(/\s+/);
    if (scheme?.toLowerCase() === "bearer" && rest.length) {
      return rest.join(" ");
    }
  }

  return headers.get("x-oso-cron-secret");
}
