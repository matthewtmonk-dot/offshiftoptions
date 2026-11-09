/**
 * What the Scanner should finish on its own after a live scan, in order: first price the options of stocks that
 * passed the screen, then read company quality for the names worth a look. Pure (no React, no server import) so the
 * ordering and the once-per-scan signatures are unit-tested.
 */
export type FinishStep =
  | { kind: "price-options"; count: number; signature: string }
  | { kind: "check-quality"; tickers: string[]; signature: string };

/** Company-quality reads per automatic pass; anything beyond this stays one click away under Scan details. */
export const AUTO_QUALITY_LIMIT = 30;

export function nextFinishStep({ runId, awaitingOptionCheck, qualityTickers }: { runId: string; awaitingOptionCheck: number; qualityTickers: string[] }): FinishStep | null {
  if (awaitingOptionCheck > 0) {
    return { kind: "price-options", count: awaitingOptionCheck, signature: `${runId}:price:${awaitingOptionCheck}` };
  }
  const tickers = [...new Set(qualityTickers)].sort().slice(0, AUTO_QUALITY_LIMIT);
  if (tickers.length > 0) {
    return { kind: "check-quality", tickers, signature: `${runId}:quality:${tickers.join(",")}` };
  }
  return null;
}
