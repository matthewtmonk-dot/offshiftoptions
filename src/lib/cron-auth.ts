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
 * characters matched. Returns false immediately (without comparing) if `expected` isn't
 * configured or nothing was `provided` - a misconfigured server must never accidentally accept
 * every request (fail CLOSED, never open).
 */
function constantTimeSecretMatches(expected: string | null, provided: string | null): boolean {
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

export function isValidCronSecret(provided: string | null): boolean {
  return constantTimeSecretMatches(getOsoCronSecret(), provided);
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

/**
 * Codex blocker repair (B6) - a DEDICATED secret for `/api/internal/scheduled-capture` only,
 * deliberately separate from `OSO_CRON_SECRET` (which also authorizes Alpha Vantage queue work,
 * scanner reference-data refresh, and scanner technical preparation). Hermes, the one caller this
 * endpoint expects, should hold the SMALLEST credential that does its job - not a broad secret
 * that could also trigger unrelated internal work if it ever leaked. There is deliberately NO
 * fallback to `OSO_CRON_SECRET` anywhere in this file: a caller presenting the OLD shared secret
 * to the scheduled-capture endpoint is rejected exactly like any other wrong guess.
 */
export function getOsoScheduledCaptureSecret(): string | null {
  return process.env.OSO_SCHEDULED_CAPTURE_SECRET?.trim() || null;
}

export function isValidScheduledCaptureSecret(provided: string | null): boolean {
  return constantTimeSecretMatches(getOsoScheduledCaptureSecret(), provided);
}

/** Reads the dedicated scheduled-capture secret from `Authorization: Bearer <secret>` or a plain
 * `X-OSO-Scheduled-Capture-Secret` header - never from a query string or URL, and never from the
 * `X-OSO-Cron-Secret` header (that header is meaningless to this endpoint). */
export function extractProvidedScheduledCaptureSecret(headers: Headers): string | null {
  const authHeader = headers.get("authorization");
  if (authHeader) {
    const [scheme, ...rest] = authHeader.trim().split(/\s+/);
    if (scheme?.toLowerCase() === "bearer" && rest.length) {
      return rest.join(" ");
    }
  }

  return headers.get("x-oso-scheduled-capture-secret");
}
