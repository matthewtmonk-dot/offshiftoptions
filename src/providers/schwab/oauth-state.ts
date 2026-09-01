import "server-only";

import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";

const STATE_MAX_AGE_MS = 10 * 60 * 1000;
export const SCHWAB_OAUTH_STATE_COOKIE = "oso_schwab_oauth_state";

export type SchwabOAuthStatePayload = {
  state: string;
  userId: string;
  returnTo: string;
  developerCredentialId?: string | null;
  issuedAt: number;
  expiresAt: number;
};

export function createSchwabOAuthState(
  userId: string,
  returnTo = "/account",
  now = Date.now(),
  developerCredentialId?: string | null,
) {
  const payload: SchwabOAuthStatePayload = {
    state: randomBytes(32).toString("base64url"),
    userId,
    returnTo,
    developerCredentialId: developerCredentialId ?? null,
    issuedAt: now,
    expiresAt: now + STATE_MAX_AGE_MS,
  };
  const unsigned = Buffer.from(JSON.stringify(payload), "utf8").toString("base64url");
  const signature = sign(unsigned);

  return {
    state: payload.state,
    cookieValue: `${unsigned}.${signature}`,
    expiresAt: new Date(payload.expiresAt),
  };
}

export function verifySchwabOAuthState({
  cookieValue,
  returnedState,
  userId,
  now = Date.now(),
}: {
  cookieValue: string | undefined;
  returnedState: string | null;
  userId: string;
  now?: number;
}) {
  if (!cookieValue || !returnedState) {
    return null;
  }

  const [unsigned, signature] = cookieValue.split(".");
  if (!unsigned || !signature || !signatureMatches(unsigned, signature)) {
    return null;
  }

  const payload = parsePayload(unsigned);
  if (!payload || payload.userId !== userId || payload.state !== returnedState || payload.expiresAt < now) {
    return null;
  }

  return payload;
}

function parsePayload(unsigned: string): SchwabOAuthStatePayload | null {
  try {
    const parsed = JSON.parse(Buffer.from(unsigned, "base64url").toString("utf8")) as Partial<SchwabOAuthStatePayload>;
    if (
      typeof parsed.state === "string" &&
      typeof parsed.userId === "string" &&
      typeof parsed.returnTo === "string" &&
      (typeof parsed.developerCredentialId === "string" ||
        parsed.developerCredentialId === null ||
        parsed.developerCredentialId === undefined) &&
      typeof parsed.issuedAt === "number" &&
      typeof parsed.expiresAt === "number"
    ) {
      return parsed as SchwabOAuthStatePayload;
    }
  } catch {
    return null;
  }

  return null;
}

function signatureMatches(unsigned: string, signature: string) {
  const expected = Buffer.from(sign(unsigned), "base64url");
  const actual = Buffer.from(signature, "base64url");
  return expected.length === actual.length && timingSafeEqual(expected, actual);
}

function sign(unsigned: string) {
  return createHmac("sha256", getStateSecret()).update(unsigned).digest("base64url");
}

function getStateSecret() {
  return process.env.LST_SESSION_SECRET ?? "local-development-session-secret";
}
