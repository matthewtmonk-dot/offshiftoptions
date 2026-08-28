import { describe, expect, it } from "vitest";
import { AuthorizationError, assertCanMutateRecord, assertCanReadRecord, canMutateRecord, canReadRecord } from "./privacy";

describe("privacy and server-side authorization helpers", () => {
  const matt = "matt";
  const eric = "eric";

  it("allows owners to read private and shared records", () => {
    expect(canReadRecord(matt, matt, "PRIVATE")).toBe(true);
    expect(canReadRecord(matt, matt, "SHARED")).toBe(true);
  });

  it("allows buddies to read shared records only", () => {
    expect(canReadRecord(eric, matt, "SHARED")).toBe(true);
    expect(canReadRecord(matt, eric, "SHARED")).toBe(true);
  });

  it("blocks private records symmetrically", () => {
    expect(canReadRecord(eric, matt, "PRIVATE")).toBe(false);
    expect(canReadRecord(matt, eric, "PRIVATE")).toBe(false);
    expect(() => assertCanReadRecord(eric, matt, "PRIVATE")).toThrow(AuthorizationError);
  });

  it("allows mutation only for the record owner", () => {
    expect(canMutateRecord(matt, matt)).toBe(true);
    expect(canMutateRecord(eric, matt)).toBe(false);
    expect(() => assertCanMutateRecord(eric, matt)).toThrow(AuthorizationError);
  });
});
