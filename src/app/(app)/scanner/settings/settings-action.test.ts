import { describe, expect, it } from "vitest";
import { STALE_PAGE_MESSAGE } from "@/lib/action-failure-message";
import { submitSettingsAction } from "./settings-action";

const form = () => new FormData();

describe("submitSettingsAction", () => {
  it("maps a successful action to a success message", async () => {
    await expect(submitSettingsAction(async () => ({ ok: true, message: "Scanner settings saved." }), form())).resolves.toEqual({ kind: "success", message: "Scanner settings saved." });
  });

  it("maps a refused action to its error message (validation or safe database message)", async () => {
    await expect(submitSettingsAction(async () => ({ ok: false, error: "Enter a valid range for DTE." }), form())).resolves.toEqual({ kind: "error", message: "Enter a valid range for DTE." });
  });

  it("passes the submitted form data through to the action", async () => {
    const data = form();
    data.set("dte:min", "3");
    let seen: FormData | null = null;
    await submitSettingsAction(async (formData) => { seen = formData; return { ok: true, message: "ok" }; }, data);
    expect(seen).toBe(data);
  });

  it("turns a THROWN action into an inline message instead of letting it crash the page", async () => {
    const stale = await submitSettingsAction(async () => { throw new Error('Server Action "abc" was not found on the server.'); }, form());
    expect(stale).toEqual({ kind: "error", message: STALE_PAGE_MESSAGE });

    const network = await submitSettingsAction(async () => { throw new TypeError("Failed to fetch"); }, form());
    expect(network.kind).toBe("error");
    expect(network.message).toMatch(/reload the page/i);
    expect(network.message).toContain("(browser detail: Failed to fetch)");
  });
});
