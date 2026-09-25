# Temporary Schwab account-structure diagnostic

Manual CLI only. No route, build/start hook, sync, token refresh, migration, or financial calculation.

Run from a checkout containing this script, `src/providers/schwab/account-structure-diagnostic.ts`, `src/providers/schwab/account-structure-preflight.ts`, and the `allowRefresh: false` token-helper support in `src/providers/schwab/tokens.ts`. These local files are not present in production baseline a50f3d4. Do not run with an older token helper. Dependencies and generated Prisma client must already be installed. Existing production DATABASE_URL and token encryption configuration must be available to the process; never paste them into a command or output.

The `--list` mode prints only safe app-level selection metadata for linked Schwab accounts:

- ownerId
- accountId
- appAccountName
- accountSource
- accountType
- hasOwnerSchwabConnection
- isMappedToConnectedSchwabAccount
- diagnosticCaptureEligible

It performs no OAuth/token refresh or network request. Listing is not a promise of a fresh eligible token for capture mode. List mode always prints these safe rows plus `eligibleCount` so trusted operators can distinguish zero eligible mappings from multiple eligible mappings without exposing sensitive identifiers. Capture mode remains fail-closed and still requires an explicit valid owner/account selection.

Using the trusted SSH operator's selected **internal** user ID and TradingAccount ID (not an account number/hash):

```bash
NODE_ENV=production node --conditions=react-server --import tsx scripts/diagnostics/schwab-account-structure.ts --list
read -r -s -p 'Internal owner ID: ' OSO_DIAGNOSTIC_OWNER_ID; printf '\n'
read -r -s -p 'Internal TradingAccount ID: ' OSO_DIAGNOSTIC_ACCOUNT_ID; printf '\n'
export OSO_DIAGNOSTIC_OWNER_ID OSO_DIAGNOSTIC_ACCOUNT_ID
NODE_ENV=production node --conditions=react-server --import tsx scripts/diagnostics/schwab-account-structure.ts
unset OSO_DIAGNOSTIC_OWNER_ID OSO_DIAGNOSTIC_ACCOUNT_ID
```

This is a trusted operator command, not web-session authentication. The selected account must belong to the selected user; shared visibility never authorizes it. Its external identity must be in that user's existing connection metadata. A still-valid access token is required. If missing, expired, or within the existing refresh threshold, the command stops without refreshing it or updating the database. Establish a normal authenticated connection separately if needed, then rerun manually.

Success prints JSON to stdout: transport timestamps (never valuation proof) and sanitized field paths/types/values. No output file is created automatically. Failure prints only a fixed message to stderr. No library error details are printed. There is exactly one GET on successful preflight, zero on failed preflight, and no retries or redirects. No DB/brokerage mutations are performed.

Numbers/strings/booleans are redacted by default. Only strictly validated ISO dates/timestamps, plausible epoch values in timing fields, selected timezone strings, and a small session/source/basis enum allowlist survive. Sensitive ancestor fields override those exceptions. Nulls remain distinguishable. Array indices/counts are suppressed; heterogeneous field shapes remain. Only allowlisted schema field names survive literally. All other keys use numbered `[REDACTED_KEY_n]` placeholders: their nesting/types/nulls remain visible, but their names and descendant values are withheld. A camel-case key can itself be a private name, symbol or identifier, so unrestricted unknown key text cannot safely be printed. Unknown literal field names need separate authorized review before an allowlist extension. Free-form source descriptions, URLs, unfamiliar timezone/session values, and ambiguous timing formats remain redacted until reviewed. Raw JSON is only held in memory.

The capture shows field presence, not provider-guaranteed valuation semantics. Never interpret the HTTP Date header or request/response timestamps as account pricing provenance.
