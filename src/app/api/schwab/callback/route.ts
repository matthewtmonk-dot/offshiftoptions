import { NextResponse, type NextRequest } from "next/server";
import { requireCurrentUser } from "@/lib/auth";
import { exchangeSchwabAuthorizationCode, saveSchwabTokensForUser } from "@/providers/schwab/tokens";
import { SCHWAB_OAUTH_STATE_COOKIE, verifySchwabOAuthState } from "@/providers/schwab/oauth-state";
import {
  markSchwabDeveloperCredentialInvalid,
  markSchwabDeveloperCredentialValidated,
  resolveSchwabOAuthConfigForUser,
} from "@/providers/schwab/developer-credentials";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function GET(request: NextRequest) {
  const user = await requireCurrentUser();
  const code = request.nextUrl.searchParams.get("code");
  const returnedState = request.nextUrl.searchParams.get("state");
  const error = request.nextUrl.searchParams.get("error");
  const storedState = verifySchwabOAuthState({
    cookieValue: request.cookies.get(SCHWAB_OAUTH_STATE_COOKIE)?.value,
    returnedState,
    userId: user.id,
  });

  if (error) {
    return redirectAndClearState(request, "/account?schwab=auth_error");
  }
  if (!storedState) {
    return redirectAndClearState(request, "/account?schwab=state_error");
  }
  if (!code) {
    return redirectAndClearState(request, "/account?schwab=missing_code");
  }

  try {
    const oauthConfig = await resolveSchwabOAuthConfigForUser(user.id, {
      developerCredentialId: storedState.developerCredentialId ?? null,
      allowServerEnvFallback: !storedState.developerCredentialId,
    });
    const tokens = await exchangeSchwabAuthorizationCode(code, fetch, oauthConfig);
    await saveSchwabTokensForUser(user.id, tokens, fetch, {
      developerCredentialId: oauthConfig.developerCredentialId,
    });
    await markSchwabDeveloperCredentialValidated(user.id, oauthConfig.developerCredentialId);
  } catch {
    await markSchwabDeveloperCredentialInvalid(user.id, storedState.developerCredentialId ?? null, "token_exchange_failed");
    return redirectAndClearState(request, "/account?schwab=token_error");
  }

  return redirectAndClearState(request, "/account?schwab=connected");
}

function redirectAndClearState(request: NextRequest, path: string) {
  const response = NextResponse.redirect(new URL(path, request.url));
  response.cookies.set(SCHWAB_OAUTH_STATE_COOKIE, "", {
    httpOnly: true,
    sameSite: "lax",
    secure: process.env.NODE_ENV === "production",
    path: "/",
    maxAge: 0,
  });
  return response;
}
