**Independent product / UX audit**

# Off Shift Options: what to fix, in order

A working pass through every page of the live site as a real user, judged against the cockpit you described — dense, fast, honest about what it doesn't know.

**Session** Aug 31, 2026 · 7:53–8:10 PM ET
**User** matt@lst.local
**Schwab** connected, untouched
**Data written** none

## G · Final assessment — would Matt or Eric open this every trading day?

**Not yet.** Two things block it, and neither is cosmetic.

**The scanner returned zero clean passes.** Thirteen candidates, 0 passes, 3 near matches, and every single one carries `Earnings UNKNOWN`. There is no trade to find here, so there is no reason to open it before the bell.

**The tracker cannot answer "am I winning."** There is no performance view at all — no win rate, no weekly return, no 1% progress — and accounts are hand-typed with no deposit/withdrawal ledger, so the first time you add cash the app will read it as profit. That is the exact failure you named.

Fix the earnings feed, cap scores on hard failures, widen the universe, and ship a Performance tab with a deposits ledger, and this becomes a daily-open app. Everything else in this audit is refinement on top of that.

**10** Critical · **21** High · **18** Medium · **4** Low · **53** Total findings

## Findings ledger

**CRITICAL** Scanner · scoring — A 92 "Excellent" badge sits next to a grey UNKNOWN on the same row. Four candidates carry the top score and the top word while their status is UNKNOWN, because two criteria never resolved. Fix: make the label a function of status, not score; reserve "Excellent" for a clean PASS.

**CRITICAL** Scanner · scoring — A hard failure on a core criterion does not cap the score. AAP scores 85 "Strong" with a 76.92% bid/ask spread against a 25% rule. CORZ scores 90 "Excellent" with delta 0.41 against a 0.12–0.30 rule. Fix: classify criteria as gating vs preference; any gating FAIL hard-caps the score at 49 and forces "Fails".

**CRITICAL** Scanner · data — Earnings distance is UNKNOWN for all 13 candidates, always. Fix: wire an earnings calendar (Schwab fundamentals if exposed, otherwise a scheduled pull into your own table). Until then this is the highest-value single fix in the app.

**CRITICAL** Scanner · results — Zero clean passes; Filter mode returns an empty page with no way out. Header tiles stay stale across modes. Fix: name the binding constraint in the empty state and offer one-click relief; recompute header tiles per mode.

**HIGH** Scanner · universe — The universe is 13 fixed tickers, five of which can never pass the price rule. Fix: pre-filter by price before scoring; build a real, editable universe.

**HIGH** Scanner · options — One expiration for every name; no strike/DTE search is happening. Fix: search all expiries in the DTE window, surface the best contract per ticker.

**HIGH** Scanner · scoring — The score curve is miscalibrated at the bottom (2/14 passing scores both 57 and 46). Fix: publish the weighting; reserve 50+ for candidates clearing every gating criterion.

**HIGH** Scanner · layout — The results table is clipped on a normal laptop; Earnings and Spread fall off. Fix: cut to eight columns that fit; merge OI/VOL/Spread into one Liquidity chip.

**HIGH** Scanner · inspector — The inspector's Criteria column opens off-screen. Fix: move Criteria out of the scroll container, make it the primary full-width column.

**HIGH** Scanner · density — The scanner page is four viewports tall before expanding anything. Fix: results above the fold; move diagnostics below the table; delete the ACTIVE RULES block (duplicates Settings).

**MEDIUM** Scanner · semantics — UNKNOWN means two different things (skipped vs unavailable) and the user can't tell which. Fix: three states — NOT CHECKED (dim, no penalty), UNAVAILABLE (blocks PASS), PASS/FAIL.

**MEDIUM** Scanner · labels — "Refresh demo scan" sits beside "Run live Schwab scan" on a page already showing live data. Fix: one refresh button; retire "Phase 1 demo/manual" chrome.

**MEDIUM** Scanner · near matches — "Near match" applied without saying how near. Fix: put the gap on the badge (`Near · Δ +0.11`) and sort by distance.

**CRITICAL** Tracker · performance — There is no performance view anywhere in the product. Fix: add a Performance tab — account value vs start (deposits removed), realized P/L, win rate, avg weekly return vs 1% target, weeks at/above target, cumulative P/L chart.

**CRITICAL** Tracker · accounts — No deposit/withdrawal ledger, so the first deposit reads as profit. Fix: make the account a dated ledger (opening balance + cash events); derive current value from the ledger; always show trading P/L separately from net contributions.

**HIGH** Tracker · Schwab — Accounts are typed by hand while a live Schwab connection sits idle. Fix: read balances/cash/buying power from the linked account on schedule and on demand; keep manual accounts clearly badged MANUAL, never mixed into one total.

**HIGH** Tracker · privacy — New accounts default to "Shared with Eric". Fix: accounts default Private always, opt-in sharing per account; keep shared-by-default for watchlist/ideas.

**HIGH** Tracker · privacy — A "Both" scope aggregates two people's P/L into one number. Fix: decide explicitly — drop "Both" for money (keep only for campaign activity) or label a combined figure unmistakably with each person's contribution broken out.

**HIGH** Tracker · history — Open and closed campaigns share one undifferentiated list. Fix: split Open and History tabs; History rows lead with outcome (`WIN +$214 · 31 days · 2 rolls`).

**MEDIUM** Tracker · onboarding — The empty state expands the campaign panel you can't use and collapses the account panel you need. Fix: on zero accounts, collapse New Campaign, expand New Account.

**MEDIUM** Tracker · verification gap — Campaign lifecycle could not be verified (no campaign existed to open). Fix: seed one demo multi-leg campaign so the lifecycle is inspectable.

**CRITICAL** Dashboard — Seven of eight hero tiles say "No data". Fix: collapse to one account strip (~90px total); one honest line with a fix action instead of eight repeated silences.

**CRITICAL** Dashboard · Schwab — Schwab is connected, but account data has never been fetched once (`LAST REFRESH: Not yet`). Fix: ship the balances/positions pull, add a Sync accounts action and a visible last-synced timestamp.

**CRITICAL** Dashboard · target — The 1% weekly target appears nowhere in the product. Fix: one always-on horizontal meter (`This week +0.62% ⟶ target 1.00% · 4-week avg 0.91% · 6 of 9 weeks at target`), editable target in Settings.

**HIGH** Dashboard · scanner widget — The opportunities widget shows the four worst candidates, alphabetically. Fix: sort by score descending, show top three with score/status/ROR.

**MEDIUM** Dashboard · header — The top strip is a greeting + eyebrow + disclaimer, no information. Fix: replace with a live status line; move the no-orders disclaimer to the footer, once.

**MEDIUM** Dashboard · activity — Buddy Activity duplicates events, congratulates you for your own actions, disagrees with Notifications (0 unread). Fix: one deduplicated event stream filtered to the other person's actions; hide reactions on your own events.

**LOW** Dashboard — Three contentless tiles ("Position clarity", "Buddy check-ins", "In-app notifications") close the page. Fix: delete them; sidebar already links there.

**HIGH** Settings · profile — No canonical "LST Core" profile and no way to reset to it. Fix: ship a read-only LST Core profile, show edited fields inline against core value, "N rules differ" summary, Reset to LST Core per-rule and for all.

**HIGH** Settings · universe — You cannot control which stocks get scanned. Fix: add a Universe section — base list, auto-include watchlist, min average volume, exclusion list wired to Do Not Trade.

**MEDIUM** Settings · criteria — Underlying volume and Distance OTM are displayed but have no rule; no absolute-premium-dollar floor exists. Fix: add rules for min average volume, min distance OTM %, min premium per contract.

**MEDIUM** Settings · form — Save is at the top, fields run two screens below, no unsaved-change warning. Fix: sticky save bar with unsaved-changes count; warn on navigate-away.

**MEDIUM** Settings · density — Every rule explanation is printed twice (Settings cards + Scanner's ACTIVE RULES block). Fix: move descriptions behind a `?`; delete ACTIVE RULES from Scanner.

**HIGH** Account · Schwab — "Reconnect Schwab" is the loudest button on the page, on a healthy connection. Fix: primary button becomes "Sync now"; Reconnect drops to a quiet text link; Disconnect moves to muted red behind confirmation.

**HIGH** Account · balances — The linked account shows no balance, cash, or buying power — only plumbing (last updated, token expiry, linked count, last refresh). Fix: lead with account value, cash available, buying power, capital secured by open puts, each with an as-of time.

**MEDIUM** Account · OAuth — Raw token expiry is displayed as a headline metric and reads like an alarm; callback URL is shown to end users. Fix: one health line ("Connected · auto-renewing · last synced 8:04 PM"), amber only on real renewal failure; move raw expiry/callback URL behind "Connection details".

**HIGH** Research — Research does not exist; there is no ticker search anywhere. Fix: one route `/t/RIOT` reachable from a persistent search box — price/RSI/BB/earnings strip, scanner verdict, top qualifying contracts, campaign history, notes, watchlist/DNT toggles.

**HIGH** Nav · exclusions — You cannot mark a company Do Not Trade even though the scanner rule exists and always reports PASS/false. Fix: a "Never trade" toggle on scanner rows and watchlist cards, plus an Excluded list in Settings.

**CRITICAL** Watchlist · density — One watchlist ticker consumes an entire ~640px screen. Fix: collapse to a 40px row per ticker; notes/tags/recommend/comment live in the expanded state.

**HIGH** Watchlist · content — The watchlist doesn't show price, RSI, or live setup state. Fix: every row carries live price, RSI, BB%, scanner score/status, sorted by score.

**MEDIUM** Collab · structure — Four surfaces (Recs, Chat, Alerts, Buddy Activity) for two people who mostly want to say "look at CORZ", all empty. Fix: collapse to one Ideas thread; a rec is a message with a ticker, a comment is a reply.

**LOW** Collab · defaults — "Worth researching" is pre-checked on every recommendation while substantive tags are not. Fix: start with nothing checked, or auto-check tags the scanner actually supports.

**MEDIUM** Nav · labels — "Settings" in the nav is actually scanner settings only. Fix: rename to "Scanner rules", nest under Scanner; reserve "Settings" for when real user preferences exist.

**MEDIUM** Nav · structure — Ten flat destinations, four empty, none grouped. Fix: five — Today, Scanner, Positions (open/history/performance), Watchlist, Ideas. Account/Install move under the user menu.

**MEDIUM** Nav · errors — A wrong URL (e.g. `/tracker`) drops you out of the app entirely with a bare framework 404. Fix: branded 404 inside the app shell; redirect `/tracker` → `/positions`.

**LOW** Install — Install holds a permanent nav slot showing engineering status (VAPID key state). Fix: move to a dismissible first-visit prompt and a row in Account; drop the status cards.

**HIGH** Density · layout — Multi-column layouts only switch on at `xl` (1280px); most laptops get the tall stacked version. Fix: move breakpoints to `lg` (1024px); collapse sidebar to icon rail below 1400px.

**MEDIUM** Density · page chrome — Every page opens with eyebrow + H1 + description sentence (~110–140px), on every visit. Fix: one 32px header row; descriptions move into empty states.

**MEDIUM** Density · tiles — Stat tiles are sized (~100px) for numbers that aren't there, with captions hedging about missing data. Fix: one ~52px strip, label above value, captions become tooltips.

**HIGH** Mobile · nav — The mobile nav is ten chips in a four-column grid, ~120–150px, stuck to the top of every screen. Fix: five-item bottom tab bar, matching the five-item nav.

**HIGH** Mobile · dashboard — On a phone, eight stacked "No data" tiles (~800px) sit under a ~140px sticky nav before anything useful. Fix: three figures only (account value, week vs target, open CSPs) as a 60px strip; rest behind "More numbers".

**MEDIUM** Mobile · scanner — The mobile scanner renders thirteen full inspectors (table and cards both present in the DOM at once). Fix: mobile cards collapse to five lines, expand on tap; render one variant, not both.

**LOW** Mobile · verification gap — Browser resizing was unavailable this session; mobile findings are read from the shipped stylesheet/DOM, not a rendered phone screenshot.

## A · The ten changes, in order

1. Get earnings dates into the scanner.
2. Cap the score on any hard failure; stop labelling unknowns "Excellent".
3. Build the Performance tab, on a deposits ledger.
4. Widen the universe and pre-filter it by price.
5. Sync Schwab balances and put a Sync now button on the Account page.
6. Rebuild the dashboard as one status strip plus three panels.
7. Search the whole option chain in the DTE window.
8. Ship the ticker page at `/t/RIOT` with a persistent search box.
9. Add the LST Core profile with per-rule reset, and a universe section.
10. Collapse ten nav items to five and Recs/Chat/Alerts into one Ideas thread.

## E · What already works — don't touch it

- The criteria explanations are excellent plain-English writing — the only problem is they're off-screen.
- PASS / FAIL / UNKNOWN as a first-class, propagating concept is the right architecture — the bug is the score badge ignoring UNKNOWN, not the state existing.
- The "why so few results" per-rule exclusion diagnostic is genuinely uncommon and exactly right — it just belongs below the results, not above.
- The near-match concept is the right idea; it only needs distances attached.
- Send-to-buddy from inside the inspector is the correct interaction — keep the shortcut, change where it posts.
- Account number masking (`1 (…5106)`) is handled correctly.
- The mobile card fallback for the scanner is the right call — it just needs a collapsed default.
- Pro/Con notes on watchlist items are a good, opinionated idea worth keeping.
- The visual language (dark ground, restrained green accent, consistent chips/badges) is fine — the problem is spacing and hierarchy, not the palette.

## F · The one-screen test

Ten seconds after login on desktop: How is my account doing? No — "No data" x8. What positions are open? Barely — a seeding sentence, not your account. Am I winning? No — win/loss doesn't exist anywhere. Am I near the 1% target? No — the target isn't in the app. What did the scanner find? Worse than no — four failing candidates chosen alphabetically, which reads as an answer and isn't one.

**Scope and limits.** Audited live at offshiftoptions.com on Aug 31 2026 between 7:53 and 8:10 PM ET, signed in as matt@lst.local. No production data was created or changed, and the Schwab connection was not touched. Because no account or campaign existed, the campaign lifecycle, roll accounting, win/loss determination and account-history views could not be exercised and are unaudited. Browser window resizing was unavailable, so mobile findings are derived from the shipped stylesheet and live DOM rather than a rendered phone viewport.
