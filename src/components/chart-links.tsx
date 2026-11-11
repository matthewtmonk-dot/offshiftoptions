import { chartLinksFor } from "@/domain/scanner/chartLinks";

/**
 * Small "6M" and "D" links that open the ticker's chart (Bollinger Bands + RSI already on) in a new tab. They are plain
 * anchors with rel="noopener noreferrer" and no referrer, so the chart site learns only the ticker symbol.
 */
export function ChartLinks({ ticker }: { ticker: string }) {
  const links = chartLinksFor(ticker);
  if (links.length === 0) return null;
  return (
    <span className="inline-flex items-center gap-0.5" data-testid={`chart-links-${ticker}`}>
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
          className="rounded px-1 py-0.5 text-[11px] font-medium text-zinc-500 underline decoration-zinc-700 underline-offset-2 transition hover:text-sky-300 hover:decoration-sky-300"
        >
          {link.label}
        </a>
      ))}
    </span>
  );
}
