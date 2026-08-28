<!-- BEGIN:nextjs-agent-rules -->

# This is NOT the Next.js you know

This version has breaking changes — APIs, conventions, and file structure may all differ from your training data. Read the relevant guide in `node_modules/next/dist/docs/` (resolved from this file's directory; in monorepos the `next` package may not be visible from the repo root) before writing any code. Heed deprecation notices.

This block is written and re-added by `next dev` — verify at `node_modules/next/dist/server/lib/generate-agent-files.js`. Removing it from a diff only re-creates the uncommitted change; committing it with your work keeps the tree clean.

<!-- END:nextjs-agent-rules -->

# LST Buddy Agent Notes

LST Buddy is a private, fun, educational trading research and tracking PWA for Matt and Eric. It helps with conservative cash-secured-put research, manual/demo tracking, watchlists, recommendations, chat, notifications, and rule-following.

## Absolute Product Rule

This application does not place trades. Do not add buy, sell, place order, submit order, replace order, cancel order, automated trading, or algorithmic execution methods. Future Schwab work is read-only.

## Stack

- Next.js App Router
- strict TypeScript
- Prisma 7 with PostgreSQL
- Tailwind CSS
- server-side cookie/database sessions
- pnpm
- Vitest
- Docker Compose

## Commands

- `pnpm dev`
- `pnpm build`
- `pnpm lint`
- `pnpm typecheck`
- `pnpm test`
- `pnpm db:migrate`
- `pnpm db:seed`
- `pnpm db:reset`
- `docker compose up --build`

## Coding Expectations

- Keep financial calculations isolated in `src/domain/finance` and covered by deterministic tests.
- Keep scanner logic in `src/domain/scanner` with PASS/FAIL/UNKNOWN per criterion.
- Enforce privacy server-side with `src/lib/privacy.ts`; never rely only on React hiding.
- Treat Phase 1 financial values as DEMO or MANUAL.
- Use record-level `Visibility` for shareable records.
- Keep UI friendly and dark with restrained green accents. Use red/green mainly for fail/pass states.
- Update `docs/HANDOFF.md` at the end of every session.

## Key Docs

- `docs/ARCHITECTURE.md`
- `docs/DATA_MODEL.md`
- `docs/DECISIONS.md`
- `docs/HANDOFF.md`
- `docs/SCHWAB_INTEGRATION.md`
