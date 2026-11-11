/**
 * The one place the session-signing secret is read from the environment. No server imports, so both the auth layer
 * and the Schwab OAuth state signer use the same rule.
 *
 * Two names are accepted. `OSO_SESSION_SECRET` is the current name; `LST_SESSION_SECRET` is the original one and
 * still works. The second name exists because on Nov 11 2026 the production host started the app WITHOUT
 * `LST_SESSION_SECRET` in its environment even though the variable was configured in the hosting panel (every
 * signed-in page returned 500). Both variables must hold the SAME value, or everyone is signed out.
 */
export const SESSION_SECRET_ENV_NAMES = ["OSO_SESSION_SECRET", "LST_SESSION_SECRET"] as const;

export const DEVELOPMENT_SESSION_SECRET = "local-development-session-secret";

/** The first configured (non-empty) session secret, or undefined. */
export function readSessionSecretFromEnv(env: Record<string, string | undefined> = process.env): string | undefined {
  for (const name of SESSION_SECRET_ENV_NAMES) {
    const value = env[name];
    if (value) return value;
  }
  return undefined;
}

/**
 * Fails closed: the repository is public, so the development fallback is publicly known - in production a missing
 * secret must stop sign-in/session checks, never silently use it.
 */
export function resolveSessionSecret(secret: string | undefined, nodeEnv: string | undefined): string {
  if (secret) return secret;
  if (nodeEnv === "production") {
    throw new Error("A session secret is required in production: set OSO_SESSION_SECRET (or the older name LST_SESSION_SECRET).");
  }
  return DEVELOPMENT_SESSION_SECRET;
}
