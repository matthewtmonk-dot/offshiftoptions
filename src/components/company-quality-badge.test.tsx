import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

// The chip only calls these on click; rendering never touches the server or the database.
vi.mock("@/app/(app)/scanner/company-quality-actions", () => ({
  saveCompanyQualityReviewAction: vi.fn(),
  removeCompanyQualityReviewAction: vi.fn(),
}));

import { CompanyQualityBadge, type CompanyQualityChipData } from "./company-quality-badge";

const base: CompanyQualityChipData = { status: "OK", tier: "CAUTION", reasons: ["Burning cash with about 6 quarters of runway."], runwayQuarters: 6, fetchedAt: "2026-11-05T15:00:00Z", reviewed: null, gate: { eligible: false, label: "CAUTION", reason: "x" } };
const html = (data: CompanyQualityChipData | undefined) => renderToStaticMarkup(<CompanyQualityBadge ticker="TEST" data={data} />);

describe("CompanyQualityBadge", () => {
  it("shows 'Q?' and points at the check button when nothing has been checked", () => {
    const markup = html(undefined);
    expect(markup).toContain("Q?");
    expect(markup).toContain("Not checked yet");
    expect(markup).not.toContain("I&#x27;ve looked at this");
  });

  it("a CAUTION company shows its reasons and offers the written review", () => {
    const markup = html(base);
    expect(markup).toContain("Q:CAUTION");
    expect(markup).toContain("Burning cash with about 6 quarters of runway.");
    expect(markup).toContain("I&#x27;ve looked at this");
    expect(markup).toContain("Save my review");
    expect(markup).toContain("not a valuation and not a recommendation");
  });

  it("a VERIFY company can also be reviewed", () => {
    expect(html({ ...base, tier: "VERIFY", gate: { eligible: false, label: "VERIFY", reason: "y" } })).toContain("Save my review");
  });

  it("A and B offer no review (nothing to override)", () => {
    for (const tier of ["A", "B"] as const) {
      const markup = html({ ...base, tier, gate: { eligible: true, label: tier, reason: "ok" } });
      expect(markup).toContain(`Q:${tier}`);
      expect(markup).not.toContain("Save my review");
    }
  });

  it("REJECT can never be overridden: no review form, and it says so", () => {
    const markup = html({ ...base, tier: "REJECT", gate: { eligible: false, label: "REJECT", reason: "z" } });
    expect(markup).toContain("Q:REJECT");
    expect(markup).toContain("This cannot be overridden.");
    expect(markup).not.toContain("Save my review");
  });

  it("a reviewed company shows the owner's note and a way to remove it, but no new review form", () => {
    const markup = html({ ...base, reviewed: { note: "Strong backlog, funded for two years.", at: "2026-11-05T16:00:00Z" }, gate: { eligible: true, label: "CAUTION - reviewed", reason: "ok" } });
    expect(markup).toContain("You reviewed this");
    expect(markup).toContain("Strong backlog, funded for two years.");
    expect(markup).toContain("Remove my review");
    expect(markup).not.toContain("Save my review");
  });
});
