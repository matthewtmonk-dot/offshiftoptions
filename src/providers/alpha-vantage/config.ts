import "server-only";

export const ALPHA_VANTAGE_BASE_URL = "https://www.alphavantage.co/query";

export type AlphaVantageConfigStatus = {
  configured: boolean;
};

export function getAlphaVantageConfigStatus(): AlphaVantageConfigStatus {
  return { configured: Boolean(process.env.ALPHA_VANTAGE_API_KEY?.trim()) };
}

/** Server-side only. Never expose this value to a client component, log line, or error message. */
export function getAlphaVantageApiKey(): string | null {
  return process.env.ALPHA_VANTAGE_API_KEY?.trim() || null;
}
