import { SESSION_SECRET_ENV_NAMES } from "./session-secret";

/**
 * Which expected settings the RUNNING process can actually see - names only, never values. Shown on /api/health so a
 * "configured in the hosting panel but missing at runtime" problem (the Nov 11 2026 outage) is visible in seconds,
 * without server-log access and without being signed in.
 *
 * `required` settings stop the app when missing; `optional` ones switch a feature off. A group like
 * "OSO_SESSION_SECRET|LST_SESSION_SECRET" is satisfied by any one of its names. The names themselves are already
 * public (this repository and .env.example are public); only presence is reported.
 */
const REQUIRED: readonly (readonly string[])[] = [["DATABASE_URL"], SESSION_SECRET_ENV_NAMES];

const OPTIONAL: readonly (readonly string[])[] = [
  ["NEXT_PUBLIC_APP_URL"],
  ["SCHWAB_CLIENT_ID"],
  ["SCHWAB_CLIENT_SECRET"],
  ["SCHWAB_REDIRECT_URI"],
  ["SCHWAB_TOKEN_ENCRYPTION_KEY"],
  ["OSO_CRON_SECRET"],
  ["OSO_SCHEDULED_CAPTURE_SECRET"],
  ["ALPHA_VANTAGE_API_KEY"],
  ["SEC_USER_AGENT"],
  ["OPENAI_API_KEY"],
  ["SUPABASE_URL"],
  ["SUPABASE_SECRET_KEY"],
];

export type RuntimeConfigReport = {
  /** "ok" when every required setting is visible to the running process. */
  status: "ok" | "missing-required";
  missingRequired: string[];
  missingOptional: string[];
};

export function runtimeConfigReport(env: Record<string, string | undefined> = process.env): RuntimeConfigReport {
  const missing = (groups: readonly (readonly string[])[]) => groups.filter((names) => !names.some((name) => Boolean(env[name]?.trim()))).map((names) => names.join("|"));
  const missingRequired = missing(REQUIRED);
  return { status: missingRequired.length ? "missing-required" : "ok", missingRequired, missingOptional: missing(OPTIONAL) };
}
