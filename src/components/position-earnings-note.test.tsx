import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { buildPositionEarningsNote } from "@/domain/finance/positionEarningsWarning";
import { PositionEarningsNoteView } from "./position-earnings-note";

const now = new Date("2026-11-04T15:00:00Z");
const day = (iso: string) => new Date(`${iso}T00:00:00Z`);

function html(report: string | null, rollSuggested = false) {
  const note = buildPositionEarningsNote({
    legType: "PUT",
    expiration: day("2026-11-06"),
    evidence: report ? { status: "SCHEDULED", reportDate: day(report) } : null,
    now,
    rollSuggested,
  });
  return renderToStaticMarkup(<PositionEarningsNoteView note={note} />);
}

describe("PositionEarningsNoteView", () => {
  it("shows an amber warning when earnings land before the put expires", () => {
    const markup = html("2026-11-05");
    expect(markup).toContain('data-level="BEFORE_EXPIRY"');
    expect(markup).toContain("text-amber-300");
    expect(markup).toContain("2026-11-05");
  });

  it("adds the roll caution only when a roll is being suggested", () => {
    expect(html("2026-11-05", true)).toContain("Don&#x27;t roll into earnings");
    expect(html("2026-11-05", false)).not.toContain("roll into earnings");
  });

  it("is muted, not alarming, when the date is unconfirmed", () => {
    const markup = html(null);
    expect(markup).toContain('data-level="UNKNOWN"');
    expect(markup).toContain("text-zinc-500");
    expect(markup).not.toContain("text-amber-300");
  });

  it("renders nothing when earnings are clear of the expiration", () => {
    expect(html("2026-11-20")).toBe("");
  });

  it("renders nothing without a note", () => {
    expect(renderToStaticMarkup(<PositionEarningsNoteView note={null} />)).toBe("");
  });
});
