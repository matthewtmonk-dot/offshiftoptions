import { NextResponse, type NextRequest } from "next/server";
import { requireCurrentUser } from "@/lib/auth";
import { safeReturnPath } from "@/lib/workflows";
import { SCHWAB_AUTHORIZATION_URL, SchwabConfigurationError } from "@/providers/schwab/config";
import { resolveSchwabOAuthConfigForUser } from "@/providers/schwab/developer-credentials";
import { createSchwabOAuthState, SCHWAB_OAUTH_STATE_COOKIE } from "@/providers/schwab/oauth-state";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function GET(request: NextRequest) {
  const user = await requireCurrentUser();
  const returnTo = safeReturnPath(request.nextUrl.searchParams.get("returnTo"), "/account");
  let resolvedConfig;
  try {
    resolvedConfig = await resolveSchwabOAuthConfigForUser(user.id);
  } catch (error) {
    if (!(error instanceof SchwabConfigurationError)) {
      throw error;
    }
    return NextResponse.redirect(new URL("/account?schwab=missing_config", request.url));
  }

  const oauthState = createSchwabOAuthState(user.id, returnTo, Date.now(), resolvedConfig.developerCredentialId);
  const authorizeUrl = new URL(SCHWAB_AUTHORIZATION_URL);
  authorizeUrl.searchParams.set("response_type", "code");
  authorizeUrl.searchParams.set("client_id", resolvedConfig.config.clientId);
  authorizeUrl.searchParams.set("redirect_uri", resolvedConfig.config.redirectUri);
  authorizeUrl.searchParams.set("state", oauthState.state);

  const response = NextResponse.redirect(authorizeUrl);
  response.cookies.set(SCHWAB_OAUTH_STATE_COOKIE, oauthState.cookieValue, {
    httpOnly: true,
    sameSite: "lax",
    secure: process.env.NODE_ENV === "production",
    path: "/",
    expires: oauthState.expiresAt,
  });

  return response;
}
