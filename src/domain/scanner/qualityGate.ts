import type { CompanyQualityTier } from "./companyQuality";

/**
 * Turns a company's quality tier (and whether the owner has personally reviewed it) into the one thing the allocation
 * planner needs: may this candidate be recommended automatically, and if not, why. Pure.
 *
 * Rules (Claude + ChatGPT review, Nov 5 2026; owner approved):
 *  - A and B are eligible.
 *  - CAUTION and VERIFY are excluded by default. The owner may override with a written reason ("I've looked at this"); the
 *    override is recorded and stays visible.
 *  - REJECT is never overridable while the reading persists.
 *  - A company that has not been checked yet is excluded (same idea as "ethics not researched yet").
 *  - When the feature is not set up (no database table or no SEC contact configured) nothing is gated at all.
 */
export type QualityGate = { eligible: boolean; label: string; reason: string };

export function qualityGateFor(input: { configured: boolean; tier: CompanyQualityTier | null; reviewed: boolean }): QualityGate | null {
  if (!input.configured) return null;
  const { tier, reviewed } = input;
  if (tier === null) return { eligible: false, label: "Not checked", reason: "Company quality not checked yet" };
  if (tier === "A") return { eligible: true, label: "A", reason: "Company quality A" };
  if (tier === "B") return { eligible: true, label: "B", reason: "Company quality B (caution flags)" };
  if (tier === "REJECT") return { eligible: false, label: "REJECT", reason: "Company quality REJECT: cannot be overridden while it persists" };
  if (reviewed) return { eligible: true, label: `${tier} - reviewed`, reason: `Company quality ${tier}, reviewed by you` };
  return {
    eligible: false,
    label: tier,
    reason: tier === "CAUTION" ? "Company quality CAUTION: excluded unless you review it" : "Company quality needs a human look (VERIFY): excluded unless you review it",
  };
}
