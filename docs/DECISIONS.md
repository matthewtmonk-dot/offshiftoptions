# Decisions

## 2026-08-28: Next.js App Router And Prisma 7

Use Next.js App Router with server components and server actions. Use Prisma 7 with `@prisma/adapter-pg` because the generated Prisma 7 client expects an adapter-backed connection.

## 2026-08-28: Database-Backed Sessions

Use simple first-party cookie sessions rather than adding a larger auth framework in the first session. Session tokens are opaque random values in cookies and HMAC-hashed in the database.

## 2026-08-28: Demo/Manual Data Boundary

Seed realistic demo data and label Phase 1 financial values as demo/manual. Do not present modeled or seeded values as live market data.

## 2026-08-28: In-App Notifications First

Implement in-app notifications now. Store push subscriptions and provide a Web Push abstraction, but defer external push delivery until HTTPS and VAPID key handling exist.

## 2026-08-28: Read-Only Broker Contracts

Create read-oriented provider interfaces only. Do not add order placement methods or broker trading abstractions.

## 2026-08-28: Scanner Criteria Preserve Explanations

Model scanner results as criterion-level records with PASS/FAIL/UNKNOWN and explanations, then derive the summary from those rows.
