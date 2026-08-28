# PWA And Notifications

LST Buddy is designed as one web application that can run on desktop browsers, mobile browsers, supported installable Home Screen contexts, and future HTTPS hosting.

## Implemented

- `public/manifest.webmanifest`
- app name and short name
- standalone display mode
- theme and background colors
- replaceable SVG app icon placeholder
- `public/sw.js` service worker shell
- client-side service worker registration
- install prompt component
- responsive authenticated app shell
- in-app notification model, UI, and server-side provider
- push subscription storage endpoint

## Web Push Boundary

Phase 1 does not send external Web Push notifications.

Reasons:

- Reliable phone push requires HTTPS and browser-specific support.
- VAPID keys must not be fabricated or committed.
- Local insecure LAN URLs should not be documented as if mobile push is production-ready.

The `WebPushNotificationProvider` returns a documented skipped result until HTTPS hosting, VAPID public/private key handling, and production delivery infrastructure are configured.
