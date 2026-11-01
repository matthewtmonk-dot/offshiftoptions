import { describe, expect, it } from "vitest";
import { summarizeAccountBalances } from "./balances-diagnostic";

describe("summarizeAccountBalances", () => {
  it("lists numeric balance fields sorted by name and the account type, ignoring everything else", () => {
    const summary = summarizeAccountBalances({
      securitiesAccount: {
        type: "MARGIN",
        accountNumber: "12345678",
        positions: [{ instrument: { symbol: "SOFI" } }],
        currentBalances: { cashBalance: 100.5, availableFunds: 90, label: "text is ignored", buyingPower: null },
        initialBalances: { accountValue: 200 },
        projectedBalances: { availableFunds: 80 },
      },
    });
    expect(summary).toEqual({
      accountType: "MARGIN",
      current: [
        { name: "availableFunds", value: 90 },
        { name: "cashBalance", value: 100.5 },
      ],
      initial: [{ name: "accountValue", value: 200 }],
      projected: [{ name: "availableFunds", value: 80 }],
      malformedResponse: false,
    });
    expect(JSON.stringify(summary)).not.toContain("12345678");
    expect(JSON.stringify(summary)).not.toContain("SOFI");
  });

  it("flags a response with no securitiesAccount as malformed instead of showing zeros", () => {
    expect(summarizeAccountBalances({ nope: true })).toEqual({ accountType: null, current: [], initial: [], projected: [], malformedResponse: true });
    expect(summarizeAccountBalances(null).malformedResponse).toBe(true);
  });

  it("handles an account with no balance blocks", () => {
    expect(summarizeAccountBalances({ securitiesAccount: { type: "CASH" } })).toEqual({ accountType: "CASH", current: [], initial: [], projected: [], malformedResponse: false });
  });
});
