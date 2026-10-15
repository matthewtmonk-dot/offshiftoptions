import { afterEach, describe, expect, it, vi } from "vitest";
import { runProductionBootstrap } from "./bootstrap";

// The refusal happens before any database call, so no real client is needed.
const noDatabase = {} as never;

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("runProductionBootstrap password safety", () => {
  it("refuses to create production users when no password is supplied (no silent built-in default)", async () => {
    vi.stubEnv("DEV_SEED_PASSWORD", "");
    await expect(runProductionBootstrap(noDatabase)).rejects.toThrow(/Refusing to create production users/);
  });

  it("refuses the publicly-known old default password, whether passed in or read from the environment", async () => {
    await expect(runProductionBootstrap(noDatabase, { password: "lstbuddy-dev-only" })).rejects.toThrow(/Refusing/);
    vi.stubEnv("DEV_SEED_PASSWORD", "lstbuddy-dev-only");
    await expect(runProductionBootstrap(noDatabase)).rejects.toThrow(/Refusing/);
  });
});
