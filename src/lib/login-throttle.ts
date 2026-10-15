/**
 * Sign-in brute-force protection. The repository is public, so the two login emails are known to
 * anyone - without a limit, a stranger can try passwords forever. This keeps a sliding window of
 * recent FAILED attempts per key (one throttle per email, a more generous one per client IP) and, once
 * a key reaches its limit, refuses further attempts for a lockout period - before any password hashing
 * work is done.
 *
 * Process-local on purpose (no database table, so no migration): it resets when the server restarts
 * and is not shared between server instances. That is still a real brake for a two-user app on a
 * single Node process, and it composes with bcrypt's own cost. Pure and clock-injectable so it is
 * unit-tested without timers.
 */
export type LoginThrottleOptions = {
  /** Failed attempts allowed inside `windowMs` before a lockout. */
  maxFailures: number;
  windowMs: number;
  lockoutMs: number;
  now?: () => number;
  /** Hard cap on tracked keys so a flood of random emails/IPs cannot grow memory without bound. */
  maxTrackedKeys?: number;
};

type Entry = { failures: number[]; lockedUntil: number };

export type ThrottleDecision = { blocked: false } | { blocked: true; retryAfterSeconds: number };

export class LoginThrottle {
  private readonly entries = new Map<string, Entry>();
  private readonly now: () => number;
  private readonly maxTrackedKeys: number;

  constructor(private readonly options: LoginThrottleOptions) {
    this.now = options.now ?? Date.now;
    this.maxTrackedKeys = options.maxTrackedKeys ?? 5000;
  }

  check(key: string): ThrottleDecision {
    const entry = this.entries.get(key);
    const now = this.now();
    if (entry && entry.lockedUntil > now) {
      return { blocked: true, retryAfterSeconds: Math.max(1, Math.ceil((entry.lockedUntil - now) / 1000)) };
    }
    return { blocked: false };
  }

  recordFailure(key: string): void {
    const now = this.now();
    this.prune(now);
    const entry = this.entries.get(key) ?? { failures: [], lockedUntil: 0 };
    // A finished lockout starts a fresh window rather than re-locking on the first new miss.
    if (entry.lockedUntil !== 0 && entry.lockedUntil <= now) {
      entry.failures = [];
      entry.lockedUntil = 0;
    }
    entry.failures = entry.failures.filter((at) => now - at < this.options.windowMs);
    entry.failures.push(now);
    if (entry.failures.length >= this.options.maxFailures) {
      entry.lockedUntil = now + this.options.lockoutMs;
    }
    this.entries.set(key, entry);
  }

  /** A correct password clears that key's history. */
  recordSuccess(key: string): void {
    this.entries.delete(key);
  }

  private prune(now: number): void {
    if (this.entries.size < this.maxTrackedKeys) return;
    for (const [key, entry] of this.entries) {
      const stale = entry.lockedUntil <= now && entry.failures.every((at) => now - at >= this.options.windowMs);
      if (stale) this.entries.delete(key);
    }
    // Still full of live entries (an active flood): drop the oldest rather than grow.
    while (this.entries.size >= this.maxTrackedKeys) {
      const oldest = this.entries.keys().next().value;
      if (oldest === undefined) break;
      this.entries.delete(oldest);
    }
  }
}

const FIFTEEN_MINUTES_MS = 15 * 60 * 1000;

/** Per email: tight. Five wrong passwords locks that email for 15 minutes. */
export const emailLoginThrottle = new LoginThrottle({ maxFailures: 5, windowMs: FIFTEEN_MINUTES_MS, lockoutMs: FIFTEEN_MINUTES_MS });
/** Per client IP: looser, so one shared network (phone + laptop) is not locked out by a few typos,
 * but a script cycling through many emails from one address still is. */
export const ipLoginThrottle = new LoginThrottle({ maxFailures: 20, windowMs: FIFTEEN_MINUTES_MS, lockoutMs: FIFTEEN_MINUTES_MS });

/** First hop of X-Forwarded-For (the real client as reported by the hosting proxy), else "unknown". */
export function clientIpFromHeaders(headers: { get(name: string): string | null }): string {
  const forwarded = headers.get("x-forwarded-for");
  const first = forwarded?.split(",")[0]?.trim();
  return first && first.length <= 64 ? first : headers.get("x-real-ip")?.trim().slice(0, 64) || "unknown";
}
