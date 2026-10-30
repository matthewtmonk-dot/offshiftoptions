/**
 * Schwab only lets a read-only app keep a sign-in for 7 days: after that the saved refresh token stops
 * working and EVERYTHING that needs Schwab pauses (scanner data preparation, prices, brokerage sync) until
 * the user signs in again. The first time that happened here nothing on screen said so - the scanner just
 * went quiet and GitHub kept emailing about the worker. This turns the connection's state into a short
 * banner so the cause is obvious, and warns two days ahead so it can be renewed before there is a gap.
 *
 * Pure: takes plain values, returns what to show. The 7-day figure is Schwab's documented refresh-token
 * lifetime; it counts from the moment the user last authorized (not from the last token refresh).
 */
export const SCHWAB_SIGN_IN_LIFETIME_DAYS = 7;
export const SCHWAB_RENEW_WARNING_DAYS = 2;

export type SchwabConnectionNotice =
  | { level: "expired"; title: string; detail: string }
  | { level: "soon"; title: string; detail: string; daysLeft: number }
  | null;

const MS_PER_DAY = 24 * 60 * 60 * 1000;

export function schwabConnectionNotice(input: {
  /** BrokerConnection.status, or null when the user has never connected Schwab. */
  status: string | null;
  /** ISO time the user last authorized Schwab (BrokerConnection.metadata.connectedAt), when known. */
  connectedAt: string | null;
  now: Date;
}): SchwabConnectionNotice {
  const { status, connectedAt, now } = input;
  if (status === null || status === "DISCONNECTED") return null; // never connected / chose to disconnect - never nag

  if (status === "EXPIRED") {
    return {
      level: "expired",
      title: "Schwab needs to be reconnected",
      detail: "Prices, the scanner's nightly data preparation and brokerage sync are paused until you sign in to Schwab again (about 30 seconds).",
    };
  }
  if (status !== "CONNECTED") return null;

  const authorizedAt = connectedAt ? new Date(connectedAt) : null;
  if (!authorizedAt || Number.isNaN(authorizedAt.getTime())) return null;
  const daysLeft = SCHWAB_SIGN_IN_LIFETIME_DAYS - (now.getTime() - authorizedAt.getTime()) / MS_PER_DAY;

  if (daysLeft <= 0) {
    return {
      level: "expired",
      title: "Schwab sign-in has run out",
      detail: "Schwab requires a fresh sign-in every 7 days. Reconnect now - prices, the scanner's data preparation and brokerage sync stop working until you do.",
    };
  }
  if (daysLeft <= SCHWAB_RENEW_WARNING_DAYS) {
    const rounded = Math.max(1, Math.ceil(daysLeft));
    return {
      level: "soon",
      daysLeft: rounded,
      title: `Schwab sign-in expires in about ${rounded} day${rounded === 1 ? "" : "s"}`,
      detail: "Schwab requires a fresh sign-in every 7 days. Reconnect any time before then (about 30 seconds) so nothing pauses.",
    };
  }
  return null;
}
