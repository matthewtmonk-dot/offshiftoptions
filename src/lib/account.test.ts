import { describe, expect, it } from "vitest";
import { assertStrongPassword } from "./account";
import { ValidationError } from "./tickers";

describe("assertStrongPassword", () => {
  it("rejects passwords shorter than 10 characters", () => {
    expect(() => assertStrongPassword("short1a")).toThrow(ValidationError);
  });

  it("rejects passwords without a letter or without a number", () => {
    expect(() => assertStrongPassword("1234567890")).toThrow(ValidationError);
    expect(() => assertStrongPassword("nolettershere")).toThrow(ValidationError);
  });

  it("accepts a password with letters, numbers, and enough length", () => {
    expect(() => assertStrongPassword("correcthorse9battery")).not.toThrow();
  });
});
