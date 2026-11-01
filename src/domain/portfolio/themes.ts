/**
 * Hand-maintained "theme" tags: companies that tend to rise and fall together even when their official sector
 * labels differ (an AI data-center landlord and a bitcoin miner can sit in different Alpha Vantage sectors).
 * The portfolio plan allows one company per theme. A company with no tag falls back to its industry, then its
 * sector (see themeKeyOf). Add a ticker here whenever you notice a new look-alike group; these are public
 * classifications, not account data.
 */
const THEME_MEMBERS: Record<string, readonly string[]> = {
  "AI infrastructure and bitcoin mining": ["CORZ", "RIOT", "APLD", "IREN", "MARA", "CLSK", "CIFR", "WULF", "HUT", "BTBT", "BITF", "SMCI", "CRWV", "NBIS", "VRT", "ANET"],
  "Consumer fintech and lending": ["UPST", "SOFI", "AFRM", "LC", "HOOD", "DAVE", "MQ", "PAYO", "OPFI", "ENVA", "COIN"],
  "Uranium and nuclear power": ["UEC", "OKLO", "CCJ", "NXE", "DNN", "LEU", "SMR", "NNE", "UUUU", "URG", "BWXT"],
  "Gold and silver miners": ["HL", "KGC", "AU", "AEM", "GOLD", "PAAS", "CDE", "AG", "SVM", "HMY", "EGO", "BTG", "NEM", "WPM", "FNV", "RGLD", "GFI", "IAG", "OR", "SSRM"],
  "Quantum computing": ["IONQ", "RGTI", "QBTS", "QUBT"],
  "Rare earths and critical minerals": ["MP", "USAR", "TMC", "ALB", "LAC", "PLL"],
};

const THEME_BY_TICKER: ReadonlyMap<string, string> = new Map(
  Object.entries(THEME_MEMBERS).flatMap(([theme, tickers]) => tickers.map((ticker) => [ticker, theme] as const)),
);

export function themeForTicker(ticker: string): string | null {
  return THEME_BY_TICKER.get(ticker.trim().toUpperCase()) ?? null;
}
