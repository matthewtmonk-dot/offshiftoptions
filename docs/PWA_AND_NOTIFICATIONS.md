# PWA And Notifications

Off Shift Options is designed as one web application that can run on desktop browsers, mobile browsers, supported installable Home Screen contexts, and (now live) HTTPS hosting on Hostinger.

## Implemented

- `public/manifest.webmanifest` — name "Off Shift Options", short name "OSO"
- standalone display mode
- theme and background colors
- PNG icons at 192x192 and 512x512 (`purpose: "any"`), separate maskable-safe-zone 192x192/512x512 PNGs (`purpose: "maskable"`), a scalable SVG icon, and a 180x180 `apple-touch-icon.png`
- `public/sw.js` service worker shell — network-first for navigations (falls back to the cached `/login` shell, never a stale authenticated page), cache-first only for the small fixed shell asset list
- client-side service worker registration
- install prompt component
- responsive authenticated app shell
- in-app notification model, UI, and server-side provider
- push subscription storage endpoint (`POST /api/push-subscriptions`) — stores subscription rows but nothing currently calls it from the client

## Web Push Boundary

Off Shift Options does not currently send external Web Push notifications. In-app notifications (bell icon, `/notifications`) are the only delivery channel today.

Now that Hostinger serves the app over HTTPS, the earlier blocker (no HTTPS) no longer applies. Completing Web Push is deferred anyway because it is a real scope expansion, not a small addition:

- Generate and configure a VAPID key pair (`VAPID_PUBLIC_KEY`, `VAPID_PRIVATE_KEY`, plus a `VAPID_SUBJECT` contact `mailto:`/URL) — never fabricate or commit these; generate them for real when this phase starts (e.g. `npx web-push generate-vapid-keys`) and store them as Hostinger environment variables, private key server-only.
- Add a `web-push` (or equivalent) server dependency and wire `WebPushNotificationProvider.deliver()` to actually call it instead of returning a documented skipped result.
- Add client-side code that requests `Notification` permission, calls `pushManager.subscribe()` with the VAPID public key, and POSTs the resulting subscription to the existing `/api/push-subscriptions` endpoint — this does not exist yet even though the storage endpoint does.
- Handle a declined/blocked permission gracefully (no repeated prompts, no broken UI) and handle expired/invalid subscriptions (410/404 from the push service) by disabling the stored `PushSubscription` row.
- Add a `push` event handler to `public/sw.js` to actually display the notification.

The `WebPushNotificationProvider` returns a documented skipped result until this work is done. Track it as a Phase 2/3 task rather than blocking this release on it.
