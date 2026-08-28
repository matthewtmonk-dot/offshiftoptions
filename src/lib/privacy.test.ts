import { describe, expect, it } from "vitest";
import {
  AuthorizationError,
  assertCanMutateRecord,
  assertCanReadInheritedRecord,
  assertCanReadRecord,
  canMutateRecord,
  canReadInheritedRecord,
  canReadRecord,
  resolveInheritedVisibility,
} from "./privacy";

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

  it("resolves inherited visibility from its parent record", () => {
    expect(resolveInheritedVisibility("INHERIT", "SHARED")).toBe("SHARED");
    expect(resolveInheritedVisibility("INHERIT", "PRIVATE")).toBe("PRIVATE");
    expect(resolveInheritedVisibility("SHARED", "PRIVATE")).toBe("SHARED");
    expect(resolveInheritedVisibility("PRIVATE", "SHARED")).toBe("PRIVATE");
  });

  it("allows shared overrides and blocks private overrides with inherited records", () => {
    expect(canReadInheritedRecord(eric, matt, "INHERIT", "SHARED")).toBe(true);
    expect(canReadInheritedRecord(eric, matt, "INHERIT", "PRIVATE")).toBe(false);
    expect(canReadInheritedRecord(eric, matt, "SHARED", "PRIVATE")).toBe(true);
    expect(canReadInheritedRecord(eric, matt, "PRIVATE", "SHARED")).toBe(false);
    expect(() => assertCanReadInheritedRecord(eric, matt, "PRIVATE", "SHARED")).toThrow(AuthorizationError);
  });
});
