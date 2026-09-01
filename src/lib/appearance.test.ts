import { describe, expect, it } from "vitest";
import { dataThemeAttributeFor } from "./appearance";

describe("dataThemeAttributeFor", () => {
  it("maps DARK to the explicit dark attribute", () => {
    expect(dataThemeAttributeFor("DARK")).toBe("dark");
  });

  it("maps LIGHT to the explicit light attribute", () => {
    expect(dataThemeAttributeFor("LIGHT")).toBe("light");
  });

  it("omits the attribute for SYSTEM so the OS media query resolves it", () => {
    expect(dataThemeAttributeFor("SYSTEM")).toBeUndefined();
  });
});
