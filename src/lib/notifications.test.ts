import { describe, expect, it } from "vitest";
import { NOTIFICATIONS_PAGE_VISIBLE_TYPES } from "./notifications";

describe("NOTIFICATIONS_PAGE_VISIBLE_TYPES", () => {
  it("excludes MESSAGE - Chat now owns that experience end-to-end via its own unread badge/read state", () => {
    expect(NOTIFICATIONS_PAGE_VISIBLE_TYPES).not.toContain("MESSAGE");
  });

  it("excludes RECOMMENDATION - a new recommendation now also posts a structured Chat message", () => {
    expect(NOTIFICATIONS_PAGE_VISIBLE_TYPES).not.toContain("RECOMMENDATION");
  });

  it("keeps COMMENT and REACTION visible - they have no other home today", () => {
    expect(NOTIFICATIONS_PAGE_VISIBLE_TYPES).toEqual(expect.arrayContaining(["COMMENT", "REACTION"]));
  });

  it("keeps TRADE and SYSTEM visible for future use even though nothing creates them today", () => {
    expect(NOTIFICATIONS_PAGE_VISIBLE_TYPES).toEqual(expect.arrayContaining(["TRADE", "SYSTEM"]));
  });

  it("is an explicit allowlist, not a denylist - a hypothetical future type stays hidden by default", () => {
    // Every NotificationType the schema defines today - if a new one is ever added, this list
    // does NOT grow automatically, which is the whole point of an allowlist over a denylist.
    const allKnownTypes = ["RECOMMENDATION", "COMMENT", "REACTION", "MESSAGE", "TRADE", "SYSTEM"];
    expect(NOTIFICATIONS_PAGE_VISIBLE_TYPES.length).toBeLessThan(allKnownTypes.length);
    for (const type of NOTIFICATIONS_PAGE_VISIBLE_TYPES) {
      expect(allKnownTypes).toContain(type);
    }
  });
});
