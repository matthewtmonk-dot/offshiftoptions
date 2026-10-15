import { describe, expect, it } from "vitest";
import { runSettingsMutation, userFacingSaveError } from "./safe-action-error";
import { vi } from "vitest";

describe("userFacingSaveError", () => {
  it("keeps short, user-written validation messages exactly as they are", () => {
    expect(userFacingSaveError(new Error("Enter a valid range for DTE."), "save your settings")).toEqual({
      message: "Enter a valid range for DTE.", reference: null, internal: false,
    });
  });

  it("never passes a Prisma/database error through - it becomes one short sentence with a reference code", () => {
    const prismaError = Object.assign(
      new Error("Invalid `tx.scannerRule.upsert()` invocation in /app/src/lib/workflows.ts:2358:30\n\nTransaction API error: A commit cannot be executed on an expired transaction. " + "x".repeat(3000)),
      { code: "P2028", name: "PrismaClientKnownRequestError" },
    );
    const result = userFacingSaveError(prismaError, "save your settings");
    expect(result.internal).toBe(true);
    expect(result.reference).toBe("P2028");
    expect(result.message).toBe("Couldn't save your settings (reference: P2028). Please try again in a moment. If it keeps happening, tell Claude this reference.");
    expect(result.message.length).toBeLessThan(160);
    expect(result.message).not.toMatch(/scannerRule|workflows\.ts|invocation/);
  });

  it("treats a very long or stack-like message with no code as internal too, using the error name as the reference", () => {
    const long = Object.assign(new Error("y".repeat(500)), { name: "SomeInternalError" });
    expect(userFacingSaveError(long, "save your settings")).toMatchObject({ internal: true, reference: "SomeInternalError" });
    expect(userFacingSaveError(new Error("failed at Object.run (/app/x.js:12:3)"), "do it").internal).toBe(true);
  });

  it("handles a thrown non-Error", () => {
    expect(userFacingSaveError("boom", "save your settings")).toMatchObject({ internal: true, reference: "Unknown" });
  });

  it("produces a message that is safe to put in a redirect URL (short, no control characters)", () => {
    const result = userFacingSaveError(Object.assign(new Error("a".repeat(9000)), { code: "P2028" }), "reset your settings");
    expect(encodeURIComponent(result.message).length).toBeLessThan(400);
    expect(result.message).not.toMatch(/[\n\r]/);
  });
});

describe("runSettingsMutation (settings actions never throw or redirect)", () => {
  it("returns the success message when the change works", async () => {
    await expect(runSettingsMutation("save your settings", "Saved.", async () => undefined)).resolves.toEqual({ ok: true, message: "Saved." });
  });

  it("returns a validation message unchanged and does not log it as an internal failure", async () => {
    const log = vi.fn();
    const result = await runSettingsMutation("save your settings", "Saved.", async () => { throw new Error("Enter a valid range for DTE."); }, log);
    expect(result).toEqual({ ok: false, error: "Enter a valid range for DTE." });
    expect(log).not.toHaveBeenCalled();
  });

  it("turns a database failure into a short message with a reference code, logging only name and code", async () => {
    const log = vi.fn();
    const dbError = Object.assign(new Error("Invalid `tx.scannerRule.createMany()` invocation: " + "z".repeat(2000)), { code: "P2028", name: "PrismaClientKnownRequestError" });
    const result = await runSettingsMutation("save your settings", "Saved.", async () => { throw dbError; }, log);
    expect(result.ok).toBe(false);
    expect(result.ok === false && result.error).toMatch(/reference: P2028/);
    expect(result.ok === false && result.error.length).toBeLessThan(200);
    expect(log).toHaveBeenCalledTimes(1);
    expect(JSON.stringify(log.mock.calls)).not.toMatch(/createMany|zzzz/);
  });

  it("survives a thrown non-Error", async () => {
    const result = await runSettingsMutation("save your settings", "Saved.", async () => { throw "boom"; }, () => {});
    expect(result).toMatchObject({ ok: false });
  });
});
