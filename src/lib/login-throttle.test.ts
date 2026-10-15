import { describe, expect, it } from "vitest";
import { clientIpFromHeaders, LoginThrottle } from "./login-throttle";

function makeThrottle(overrides: Partial<ConstructorParameters<typeof LoginThrottle>[0]> = {}) {
  let t = 1_000_000;
  const throttle = new LoginThrottle({ maxFailures: 3, windowMs: 60_000, lockoutMs: 120_000, now: () => t, ...overrides });
  return { throttle, advance: (ms: number) => { t += ms; } };
}

describe("LoginThrottle", () => {
  it("allows attempts until the failure limit, then locks the key out", () => {
    const { throttle } = makeThrottle();
    for (let i = 0; i < 2; i += 1) {
      expect(throttle.check("email:a")).toEqual({ blocked: false });
      throttle.recordFailure("email:a");
    }
    expect(throttle.check("email:a")).toEqual({ blocked: false }); // 2 failures: still allowed
    throttle.recordFailure("email:a"); // 3rd
    const decision = throttle.check("email:a");
    expect(decision).toEqual({ blocked: true, retryAfterSeconds: 120 });
  });

  it("reports a shrinking retry-after and then unlocks with a FRESH window", () => {
    const { throttle, advance } = makeThrottle();
    for (let i = 0; i < 3; i += 1) throttle.recordFailure("k");
    advance(90_000);
    expect(throttle.check("k")).toEqual({ blocked: true, retryAfterSeconds: 30 });
    advance(31_000);
    expect(throttle.check("k")).toEqual({ blocked: false });
    // One new miss after the lockout must not instantly re-lock (the old failures are gone).
    throttle.recordFailure("k");
    expect(throttle.check("k")).toEqual({ blocked: false });
  });

  it("only counts failures inside the window (slow guessing spread over time is not a lockout)", () => {
    const { throttle, advance } = makeThrottle();
    throttle.recordFailure("k");
    advance(40_000);
    throttle.recordFailure("k");
    advance(40_000); // first failure is now 80s old, outside the 60s window
    throttle.recordFailure("k");
    expect(throttle.check("k")).toEqual({ blocked: false });
  });

  it("keeps keys independent, so locking one email never blocks another", () => {
    const { throttle } = makeThrottle();
    for (let i = 0; i < 3; i += 1) throttle.recordFailure("email:matt");
    expect(throttle.check("email:matt").blocked).toBe(true);
    expect(throttle.check("email:eric")).toEqual({ blocked: false });
  });

  it("a successful sign-in clears that key's failures", () => {
    const { throttle } = makeThrottle();
    throttle.recordFailure("k");
    throttle.recordFailure("k");
    throttle.recordSuccess("k");
    throttle.recordFailure("k");
    throttle.recordFailure("k");
    expect(throttle.check("k")).toEqual({ blocked: false }); // would be locked if the two earlier misses still counted
  });

  it("never tracks more than the cap, even under a flood of distinct keys", () => {
    const { throttle } = makeThrottle({ maxTrackedKeys: 50 });
    for (let i = 0; i < 500; i += 1) throttle.recordFailure(`ip:${i}`);
    // @ts-expect-error - reading the private map size is the point of this test
    expect(throttle.entries.size).toBeLessThanOrEqual(50);
  });
});

describe("clientIpFromHeaders", () => {
  const headers = (map: Record<string, string>) => ({ get: (name: string) => map[name.toLowerCase()] ?? null });

  it("uses the first hop of x-forwarded-for", () => {
    expect(clientIpFromHeaders(headers({ "x-forwarded-for": "203.0.113.7, 10.0.0.1" }))).toBe("203.0.113.7");
  });
  it("falls back to x-real-ip, then 'unknown'", () => {
    expect(clientIpFromHeaders(headers({ "x-real-ip": "198.51.100.2" }))).toBe("198.51.100.2");
    expect(clientIpFromHeaders(headers({}))).toBe("unknown");
  });
  it("ignores an absurdly long header value", () => {
    expect(clientIpFromHeaders(headers({ "x-forwarded-for": "x".repeat(500) }))).toBe("unknown");
  });
});
