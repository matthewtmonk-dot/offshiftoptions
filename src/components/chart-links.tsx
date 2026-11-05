import { chartLinksFor } from "@/domain/scanner/chartLinks";

/**
 * Small "6M" and "D" links that open the ticker's chart (Bollinger Bands + RSI already on) in a new tab. They are plain
 * anchors with rel="noopener noreferrer" and no referrer, so the chart site learns only the ticker symbol.
 */
export function ChartLinks({ ticker }: { ticker: string }) {
  const links = chartLinksFor(ticker);
  if (links.length === 0) return null;
  return (
    <span className="inline-flex items-center gap-1" data-testid={`chart-links-${ticker}`}>
      {links.map((link) => (
        <a
          key={link.key}
          href={link.url}
          target="_blank"
          rel="noopener noreferrer"
          referrerPolicy="no-referrer"
          title={link.title}
          aria-label={`${ticker} ${link.title}`}
          onClick={(event) => event.stopPropagation()}
          className="rounded border border-zinc-700 bg-zinc-900 px-1.5 py-0.5 text-[10px] font-semibold text-sky-300 hover:border-sky-400/60 hover:text-sky-200"
        >
          {link.label}
        </a>
      ))}
    </span>
  );
}
