import "server-only";

export const SCHWAB_AUTHORIZATION_URL = "https://api.schwabapi.com/v1/oauth/authorize";
export const SCHWAB_TOKEN_URL = "https://api.schwabapi.com/v1/oauth/token";
export const SCHWAB_MARKET_DATA_BASE_URL = "https://api.schwabapi.com/marketdata/v1";
export const SCHWAB_TRADER_BASE_URL = "https://api.schwabapi.com/trader/v1";
export const SCHWAB_PRODUCTION_CALLBACK_URL = "https://offshiftoptions.com/api/schwab/callback";

export type SchwabOAuthConfig = {
  clientId: string;
  clientSecret: string;
  redirectUri: string;
};

export type SchwabConfigStatus = {
  configured: boolean;
  missing: string[];
  redirectUri: string | null;
};

const OAUTH_ENV_KEYS = ["SCHWAB_CLIENT_ID", "SCHWAB_CLIENT_SECRET", "SCHWAB_REDIRECT_URI"] as const;

export function getSchwabConfigStatus(): SchwabConfigStatus {
  const missing: string[] = OAUTH_ENV_KEYS.filter((key) => !process.env[key]);
  if (!process.env.SCHWAB_TOKEN_ENCRYPTION_KEY) {
    missing.push("SCHWAB_TOKEN_ENCRYPTION_KEY");
  }

  return {
    configured: missing.length === 0,
    missing,
    redirectUri: process.env.SCHWAB_REDIRECT_URI ?? null,
  };
}

export function getSchwabOAuthConfig(): SchwabOAuthConfig {
  const missing = OAUTH_ENV_KEYS.filter((key) => !process.env[key]);
  if (missing.length) {
    throw new SchwabConfigurationError(`Missing Schwab OAuth environment: ${missing.join(", ")}`);
  }

  return {
    clientId: process.env.SCHWAB_CLIENT_ID!,
    clientSecret: process.env.SCHWAB_CLIENT_SECRET!,
    redirectUri: process.env.SCHWAB_REDIRECT_URI!,
  };
}

export class SchwabConfigurationError extends Error {
  constructor(message = "Schwab is not configured.") {
    super(message);
    this.name = "SchwabConfigurationError";
  }
}
