import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { decryptToken, encryptToken, parseTokenEncryptionKey } from "./crypto";

describe("Schwab token encryption", () => {
  const previousKey = process.env.SCHWAB_TOKEN_ENCRYPTION_KEY;

  beforeEach(() => {
    process.env.SCHWAB_TOKEN_ENCRYPTION_KEY = `base64:${Buffer.alloc(32, 7).toString("base64")}`;
  });

  afterEach(() => {
    if (previousKey === undefined) {
      delete process.env.SCHWAB_TOKEN_ENCRYPTION_KEY;
    } else {
      process.env.SCHWAB_TOKEN_ENCRYPTION_KEY = previousKey;
    }
  });

  it("round-trips a token without deterministic ciphertext", () => {
    const first = encryptToken("access-token-secret");
    const second = encryptToken("access-token-secret");

    expect(first).not.toBe("access-token-secret");
    expect(first).not.toBe(second);
    expect(decryptToken(first)).toBe("access-token-secret");
    expect(decryptToken(second)).toBe("access-token-secret");
  });

  it("rejects authentication with the wrong key", () => {
    const encrypted = encryptToken("refresh-token-secret");
    const wrongKey = Buffer.alloc(32, 9);

    expect(() => decryptToken(encrypted, wrongKey)).toThrow();
  });

  it("accepts explicit base64 and hex 32-byte keys", () => {
    expect(parseTokenEncryptionKey(`base64:${Buffer.alloc(32, 1).toString("base64")}`)).toHaveLength(32);
    expect(parseTokenEncryptionKey(`hex:${Buffer.alloc(32, 2).toString("hex")}`)).toHaveLength(32);
  });
});
