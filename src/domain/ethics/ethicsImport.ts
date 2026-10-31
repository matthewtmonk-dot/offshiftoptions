import { z } from "zod";
import { ETHICS_CATEGORIES, EVIDENCE_CONFIDENCES, INVOLVEMENT_LEVELS } from "./ethicalCompatibility";

/**
 * The only way ethics research enters the app: a small, strictly validated JSON document. Research is done in a
 * Claude session (primary sources first), written to this shape, and pasted into the Research > Ethics page - so
 * there is no per-scan AI cost and every claim arrives with its source. Everything is length-limited, https-only,
 * and plain text; nothing here is ever rendered as HTML or executed.
 */
export const MAX_IMPORT_BYTES = 200_000;
export const MAX_COMPANIES_PER_IMPORT = 40;
export const SOURCE_TYPES = ["PRIMARY_FILING", "COMPANY", "REGULATOR", "NEWS", "SECONDARY"] as const;
export const EVIDENCE_SUPPORTS = ["SUPPORTS_CONCERN", "SUPPORTS_CLEARANCE", "CONTEXT"] as const;

const text = (max: number) => z.string().trim().min(1).max(max);
const dateString = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/, "use YYYY-MM-DD")
  .refine((value) => Number.isFinite(Date.parse(`${value}T00:00:00Z`)), "not a real date");
const httpsUrl = z
  .string()
  .trim()
  .max(500)
  .refine((value) => {
    try {
      const url = new URL(value);
      return url.protocol === "https:" && !url.username && !url.password;
    } catch {
      return false;
    }
  }, "must be an https:// link with no embedded credentials");

const assessmentSchema = z.object({
  category: z.enum(ETHICS_CATEGORIES),
  level: z.enum(INVOLVEMENT_LEVELS),
  confidence: z.enum(EVIDENCE_CONFIDENCES),
  summary: text(400),
  // Only when a source states it - the app never estimates a percentage.
  revenueSharePercent: z.number().min(0).max(100).nullable().optional(),
});

// "GENERAL" is for a source that describes the business as a whole (e.g. a 10-K business section) rather than one category.
export const EVIDENCE_CATEGORIES = [...ETHICS_CATEGORIES, "GENERAL"] as const;

const evidenceSchema = z.object({
  category: z.enum(EVIDENCE_CATEGORIES),
  claim: text(400),
  sourceUrl: httpsUrl,
  sourceType: z.enum(SOURCE_TYPES),
  supports: z.enum(EVIDENCE_SUPPORTS),
  publishedAt: dateString.nullable().optional(),
});

const companySchema = z.object({
  ticker: z.string().trim().toUpperCase().regex(/^[A-Z][A-Z0-9.-]{0,9}$/, "not a ticker symbol"),
  companyName: text(120).optional(),
  summary: text(500).optional(),
  researchedAt: dateString,
  /** Re-research after this many days (default 180). */
  reviewAfterDays: z.number().int().min(7).max(730).optional(),
  assessments: z.array(assessmentSchema).min(1).max(ETHICS_CATEGORIES.length),
  evidence: z.array(evidenceSchema).max(16).default([]),
});

export const ethicsImportSchema = z.object({ companies: z.array(companySchema).min(1).max(MAX_COMPANIES_PER_IMPORT) });
export type EthicsImportCompany = z.infer<typeof companySchema>;
export type EthicsImportDocument = z.infer<typeof ethicsImportSchema>;

export type ParsedEthicsImport = { ok: true; document: EthicsImportDocument } | { ok: false; error: string };

export function parseEthicsImport(raw: string): ParsedEthicsImport {
  if (raw.length > MAX_IMPORT_BYTES) return { ok: false, error: `That file is too large (limit ${Math.round(MAX_IMPORT_BYTES / 1000)} KB).` };
  let json: unknown;
  try {
    json = JSON.parse(raw);
  } catch {
    return { ok: false, error: "That isn't valid JSON. Paste the research file exactly as Claude gave it." };
  }
  const parsed = ethicsImportSchema.safeParse(json);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    const where = issue.path.length ? issue.path.join(".") : "document";
    return { ok: false, error: `Research file rejected at ${where}: ${issue.message}` };
  }
  const tickers = parsed.data.companies.map((company) => company.ticker);
  if (new Set(tickers).size !== tickers.length) return { ok: false, error: "The same ticker appears twice in this file." };
  return { ok: true, document: parsed.data };
}
