import Link from "next/link";
import type { ReactNode } from "react";
import { Panel } from "@/components/ui";
import { requireCurrentUser } from "@/lib/auth";

export const metadata = { title: "How it works - Off Shift Options" };

/**
 * The one plain-English explanation of the site: a short version anyone can follow, with the detail folded away
 * underneath. Static on purpose (no data reads beyond the sign-in check) so it can never be the page that breaks.
 * Keep it true: when a routine, a default or a label changes elsewhere, change the sentence here in the same PR.
 */
export default async function GuidePage() {
  await requireCurrentUser();

  return (
    <div className="mx-auto max-w-3xl space-y-5">
      <div>
        <h1 className="text-3xl font-semibold text-zinc-50">How it works</h1>
        <p className="mt-2 max-w-2xl text-sm leading-6 text-zinc-300">
          Off Shift Options finds cash-secured puts that fit your rules, checks them against your account and your ethics screen, and keeps score on the ones you place. It only reads from Schwab. You place every trade yourself in thinkorswim.
        </p>
      </div>

      <Panel title="Your week">
        <ol className="list-decimal space-y-3 pl-5 text-sm leading-6 text-zinc-300" data-testid="guide-week">
          <li>
            <strong className="text-zinc-50">Weekend - build the shortlist.</strong> Saturday after noon ET, or Sunday: open the <GuideLink href="/scanner">Scanner</GuideLink> and press Run Live Scan. If a name you might trade shows a grey <Chip>?</Chip>, get it researched now (see The ethics screen below). If a Schwab banner is showing, press Reconnect Schwab.
          </li>
          <li>
            <strong className="text-zinc-50">Monday 10:20 AM ET - look.</strong> Open the Scanner and press Run Live Scan. Give it a minute or two: the page prices the options and checks each company by itself. This week&apos;s picks appear at the top.
          </li>
          <li>
            <strong className="text-zinc-50">Monday 10:30 AM ET - confirm and place.</strong> Press Run Live Scan once more. A pick that is still there at live prices is the one to place, in thinkorswim. The entry window runs to about 12:30 PM ET. No picks means keep the cash this week.
          </li>
          <li>
            <strong className="text-zinc-50">Right after placing - sync.</strong> Go to <GuideLink href="/account">Account</GuideLink> and press Brokerage Sync. The trade shows up in the <GuideLink href="/positions">Tracker</GuideLink> and on the <GuideLink href="/dashboard">Dashboard</GuideLink>.
          </li>
          <li>
            <strong className="text-zinc-50">Monday to Thursday, about 3:00 PM ET - check.</strong> Open the Dashboard. Anything under Attention Now needs a look. Nothing there means nothing to do.
          </li>
          <li>
            <strong className="text-zinc-50">Friday, about 3:00 PM ET - roll call.</strong> Look at positions that expire today and decide: let it expire, roll it, or take the shares.
          </li>
        </ol>
      </Panel>

      <Panel title="The details">
        <div className="divide-y divide-zinc-800 text-sm leading-6 text-zinc-300">
          <Topic title="How a stock becomes a pick">
            <p>A stock has to get through five checks. Failing any one keeps it out of the picks.</p>
            <ol className="mt-2 list-decimal space-y-1 pl-5">
              <li><strong className="text-zinc-100">Your Scanner Rules.</strong> Price, trading volume, RSI, Bollinger position, and the option&apos;s bid, spread, delta, open interest and return. PASS meets them all. NEAR misses one preference narrowly.</li>
              <li><strong className="text-zinc-100">Earnings.</strong> The option must expire with room to spare before the next earnings report.</li>
              <li><strong className="text-zinc-100">Company quality.</strong> A read of the company&apos;s SEC filings. A and B are fine. CAUTION and VERIFY stay out unless you review them. REJECT stays out.</li>
              <li><strong className="text-zinc-100">Your ethics screen.</strong> Unresearched, flagged or excluded companies are never picked.</li>
              <li><strong className="text-zinc-100">Your portfolio limits.</strong> Cash available at Schwab, the most of the account in use at once, one company per theme, and a minimum return.</li>
            </ol>
            <p className="mt-2">Change the rules and the limits under <GuideLink href="/scanner/settings">Scanner settings</GuideLink>.</p>
          </Topic>

          <Topic title="The ethics screen">
            <p>
              Each company is rated on how directly it takes part in six things: abortion, pornography, gambling, predatory lending, substances and marketing, and donations and associations. Direct participation counts. Distant association does not.
            </p>
            <ul className="mt-2 list-disc space-y-1 pl-5">
              <li><Chip>?</Chip> Not researched yet. Never offered as a pick.</li>
              <li><Chip>~82</Chip> A score out of 100. The <span className="font-mono">~</span> means nothing was found but it is not verified from primary sources.</li>
              <li><Chip>!</Chip> Something needs your decision before it can be picked.</li>
              <li><Chip>EX</Chip> Excluded. Hidden from the Scanner and the picks. Show Excluded on the Scanner brings it back into view.</li>
            </ul>
            <p className="mt-2">
              Research is done once per company and saved. When the Scanner lists names that are not researched, press Copy research request under the picks, paste it to Claude, then paste the file Claude gives you into <GuideLink href="/research/ethics">Research &gt; Ethics</GuideLink> &gt; Import research. Your own Approve or Exclude decision always wins over the score.
            </p>
          </Topic>

          <Topic title="What you see on the Scanner">
            <ul className="list-disc space-y-1 pl-5">
              <li><strong className="text-zinc-100">This week&apos;s picks.</strong> What fits right now, sized against your Schwab balance. Tick or untick to try your own mix. Limits shows the numbers in force.</li>
              <li><strong className="text-zinc-100">Would qualify once you OK the company.</strong> Passes everything except ethics research.</li>
              <li><strong className="text-zinc-100">Worth a look.</strong> The default list: PASS, NEAR, and names still waiting on option prices. All shows everything scanned.</li>
              <li><strong className="text-zinc-100">Colors.</strong> Green meets the rule, amber is close, red misses, grey is unknown or switched off.</li>
              <li><strong className="text-zinc-100">Hints.</strong> Hover a dotted-underlined heading or a small circled i for what it means. Click a row for the full breakdown.</li>
            </ul>
          </Topic>

          <Topic title="How trades are tracked">
            <p>
              Brokerage Sync reads your Schwab activity and builds a campaign for each position: the put you sold, and whatever follows it - expiry, a roll, assignment, a covered call, shares sold. The Tracker lists every campaign. The Dashboard shows the account value, the whole-account gain since your starting balance, confirmed profit and loss, and what needs attention today.
            </p>
            <p className="mt-2">Refresh status, top right on every page, re-checks prices and positions. It does not import new trades. Brokerage Sync does that.</p>
          </Topic>

          <Topic title="Your limits">
            <p>
              Set under <GuideLink href="/scanner/settings#portfolio-limits">Scanner settings &gt; Portfolio limits</GuideLink> and saved to your account. The starting values: at most 60% of the account in use at once, one company per theme, at least 0.6% return per trade. The per-company size limits (20%, with one position allowed up to 50%) only start blocking once the account reaches $25,000. Below that, a large position shows a warning instead.
            </p>
          </Topic>

          <Topic title="When something looks off">
            <ul className="list-disc space-y-1 pl-5">
              <li><strong className="text-zinc-100">A Schwab banner across the top.</strong> Schwab asks for a fresh sign-in every 7 days. Press Reconnect Schwab. Until you do, prices, the scanner&apos;s morning data and syncing pause. Account shows the date the current sign-in runs out.</li>
              <li><strong className="text-zinc-100">Scanner says its data is not current.</strong> RSI and Bollinger values are prepared on weekday mornings by about 9:15 AM ET, and on Saturday by about noon. Press Prepare data now on the Scanner to do it on the spot. It can take several minutes.</li>
              <li><strong className="text-zinc-100">No picks.</strong> Scan details on the Scanner says why priced names did not pass. Early in the session spreads are wide, so scan again after 10:30 AM ET.</li>
              <li><strong className="text-zinc-100">A trade is missing from the Tracker.</strong> Run Brokerage Sync on Account. If it is still missing, add it with New Campaign on the Tracker.</li>
            </ul>
          </Topic>
        </div>
      </Panel>
    </div>
  );
}

function Topic({ title, children }: { title: string; children: ReactNode }) {
  return (
    <details className="group py-3 first:pt-0 last:pb-0">
      <summary className="flex cursor-pointer list-none items-center justify-between gap-3 text-[15px] font-medium text-zinc-100 hover:text-zinc-50">
        {title}
        <span aria-hidden className="text-zinc-500 transition group-open:rotate-90">›</span>
      </summary>
      <div className="mt-2 max-w-2xl">{children}</div>
    </details>
  );
}

function GuideLink({ href, children }: { href: string; children: ReactNode }) {
  return (
    <Link href={href} className="text-sky-300 underline underline-offset-2 hover:text-sky-200">
      {children}
    </Link>
  );
}

function Chip({ children }: { children: ReactNode }) {
  return <span className="mr-1 inline-flex min-w-7 items-center justify-center rounded-md border border-zinc-700 bg-zinc-900 px-1 py-0.5 text-[11px] font-semibold leading-none text-zinc-300">{children}</span>;
}
