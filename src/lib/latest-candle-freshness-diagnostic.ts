import "server-only";

/**
 * Re-exports the shared latest-candle-freshness probe from technical-indicator-cache.ts, where it
 * now lives so it can be reused by the automatic daily-candle-availability gate
 * (checkDailyCandleAvailabilityGate) without a circular import between the two modules. Kept as
 * its own file/export path so nothing importing from here needs to change - the manual
 * explicit-click diagnostic and the automatic gate share the exact same underlying logic.
 */
export {
  runLatestCandleFreshnessDiagnostic,
  LATEST_CANDLE_FRESHNESS_DIAGNOSTIC_SYMBOL_COUNT,
  type LatestCandleFreshnessDiagnosticResult,
  type LatestCandleFreshnessRow,
} from "./technical-indicator-cache";
