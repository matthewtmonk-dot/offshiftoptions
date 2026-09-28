import type { NextConfig } from "next";

const securityHeaders = [
  { key: "X-Content-Type-Options", value: "nosniff" },
  { key: "X-Frame-Options", value: "DENY" },
  { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
  { key: "Permissions-Policy", value: "camera=(), microphone=(), geolocation=(), payment=()" },
  { key: "Strict-Transport-Security", value: "max-age=63072000; includeSubDomains" },
  {
    key: "Content-Security-Policy",
    value: [
      "default-src 'self'",
      "script-src 'self' 'unsafe-inline'",
      "style-src 'self' 'unsafe-inline'",
      "img-src 'self' data: blob:",
      "font-src 'self' data:",
      "connect-src 'self'",
      "frame-ancestors 'none'",
      "base-uri 'self'",
      "form-action 'self'",
    ].join("; "),
  },
];

const nextConfig: NextConfig = {
  experimental: {
    staleTimes: {
      dynamic: 60,
      static: 300,
    },
  },
  // Next 16.3.x + @swc/helpers 0.5.23 output-file-tracing gap: @vercel/nft's trace resolves
  // through the pnpm virtual store (node_modules/.pnpm/@swc+helpers@0.5.23/...) and never lists
  // the project-root node_modules/@swc/helpers symlink itself - the actual first hop Node's
  // module resolution walks up to from compiled server output. Hostinger's deployment packaging
  // builds its runtime artifact from these traces, so that root symlink is silently dropped even
  // though the real files exist in the .pnpm store, producing a live "Cannot find module
  // '@swc/helpers/_/_interop_require_default'" 500 despite a successful build. Forces the whole
  // package - reached via the project-root path, not the .pnpm-relative one - into every route's
  // trace so the deployed artifact keeps it.
  outputFileTracingIncludes: {
    "/*": ["./node_modules/@swc/helpers/**/*"],
  },
  poweredByHeader: false,
  async headers() {
    return [
      {
        source: "/:path*",
        headers: securityHeaders,
      },
    ];
  },
};

export default nextConfig;
