import "server-only";

import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import { SchwabConfigurationError } from "./config";

const ALGORITHM = "aes-256-gcm";
const VERSION = "v1";

export function encryptToken(plaintext: string, key = getTokenEncryptionKey()): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv(ALGORITHM, key, iv);
  const ciphertext = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();

  return [VERSION, iv.toString("base64url"), tag.toString("base64url"), ciphertext.toString("base64url")].join(":");
}

export function decryptToken(envelope: string, key = getTokenEncryptionKey()): string {
  const [version, ivBase64, tagBase64, ciphertextBase64] = envelope.split(":");
  if (version !== VERSION || !ivBase64 || !tagBase64 || !ciphertextBase64) {
    throw new Error("Unsupported encrypted token format.");
  }

  const decipher = createDecipheriv(ALGORITHM, key, Buffer.from(ivBase64, "base64url"));
  decipher.setAuthTag(Buffer.from(tagBase64, "base64url"));
  const plaintext = Buffer.concat([
    decipher.update(Buffer.from(ciphertextBase64, "base64url")),
    decipher.final(),
  ]);

  return plaintext.toString("utf8");
}

export function getTokenEncryptionKey(): Buffer {
  const raw = process.env.SCHWAB_TOKEN_ENCRYPTION_KEY;
  if (!raw) {
    throw new SchwabConfigurationError("SCHWAB_TOKEN_ENCRYPTION_KEY is required for Schwab token storage.");
  }

  const key = parseTokenEncryptionKey(raw);
  if (key.length !== 32) {
    throw new SchwabConfigurationError("SCHWAB_TOKEN_ENCRYPTION_KEY must decode to exactly 32 bytes.");
  }

  return key;
}

export function parseTokenEncryptionKey(raw: string): Buffer {
  const value = raw.trim();
  if (value.startsWith("base64:")) {
    return Buffer.from(value.slice("base64:".length), "base64");
  }
  if (value.startsWith("hex:")) {
    return Buffer.from(value.slice("hex:".length), "hex");
  }

  const base64 = Buffer.from(value, "base64");
  if (base64.length === 32) {
    return base64;
  }

  return Buffer.from(value, "utf8");
}
