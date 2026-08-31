import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createSchwabOAuthState, verifySchwabOAuthState } from "./oauth-state";

describe("Schwab OAuth state", () => {
  const previousSecret = process.env.LST_SESSION_SECRET;

  beforeEach(() => {
    process.env.LST_SESSION_SECRET = "state-test-secret";
  });

  afterEach(() => {
    if (previousSecret === undefined) {
      delete process.env.LST_SESSION_SECRET;
    } else {
      process.env.LST_SESSION_SECRET = previousSecret;
    }
  });

  it("verifies the signed state for the same user", () => {
    const state = createSchwabOAuthState("user-1", "/account", 1000);

    expect(
      verifySchwabOAuthState({
        cookieValue: state.cookieValue,
        returnedState: state.state,
        userId: "user-1",
        now: 2000,
      }),
    ).toMatchObject({ userId: "user-1", returnTo: "/account" });
  });

  it("rejects tampered, cross-user, mismatched, and expired state", () => {
    const state = createSchwabOAuthState("user-1", "/account", 1000);

    expect(
      verifySchwabOAuthState({
        cookieValue: `${state.cookieValue.slice(0, -1)}x`,
        returnedState: state.state,
        userId: "user-1",
      }),
    ).toBeNull();
    expect(verifySchwabOAuthState({ cookieValue: state.cookieValue, returnedState: state.state, userId: "user-2" })).toBeNull();
    expect(verifySchwabOAuthState({ cookieValue: state.cookieValue, returnedState: "wrong", userId: "user-1" })).toBeNull();
    expect(
      verifySchwabOAuthState({
        cookieValue: state.cookieValue,
        returnedState: state.state,
        userId: "user-1",
        now: 1000 + 11 * 60 * 1000,
      }),
    ).toBeNull();
  });
});
