import { describe, expect, it } from "vitest";
import { describeActionFailure, STALE_PAGE_MESSAGE } from "./action-failure-message";

describe("describeActionFailure", () => {
  it("recognizes Next's stale-deployment error and says to refresh", () => {
    expect(describeActionFailure(new Error('Server Action "7f1c" was not found on the server.'), "fallback")).toBe(STALE_PAGE_MESSAGE);
    expect(describeActionFailure(new Error("Failed to find Server Action 'abc'. This request might be from an older or newer deployment."), "fallback")).toBe(STALE_PAGE_MESSAGE);
  });

  it("keeps the caller's own fallback for any other thrown error (network drop, real bug)", () => {
    expect(describeActionFailure(new Error("Network request failed"), "Live scan failed unexpectedly.")).toBe("Live scan failed unexpectedly.");
    expect(describeActionFailure("nope", "fallback")).toBe("fallback");
    expect(describeActionFailure(undefined, "fallback")).toBe("fallback");
  });
});
