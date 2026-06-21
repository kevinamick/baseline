import type { NextConfig } from "next";
import createNextIntlPlugin from "next-intl/plugin";

// Points the next-intl plugin at our per-request config. (The default would be
// ./src/i18n/request.ts; we pass it explicitly to keep the wiring obvious.)
const withNextIntl = createNextIntlPlugin("./src/i18n/request.ts");

// Static security headers applied to every response. The per-request CSP is set in
// proxy.ts (it needs a nonce); these are constant so they live here and also cover
// static assets and error pages the proxy matcher skips.
const securityHeaders = [
  { key: "X-Content-Type-Options", value: "nosniff" },
  { key: "X-Frame-Options", value: "DENY" },
  { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
  {
    key: "Permissions-Policy",
    value: "camera=(), microphone=(), geolocation=(), browsing-topics=()",
  },
  // HSTS only in production — never instruct http://localhost to force HTTPS.
  ...(process.env.NODE_ENV === "production"
    ? [
        {
          key: "Strict-Transport-Security",
          value: "max-age=63072000; includeSubDomains; preload",
        },
      ]
    : []),
];

const nextConfig: NextConfig = {
  async headers() {
    return [{ source: "/:path*", headers: securityHeaders }];
  },
  async rewrites() {
    return [
      {
        source: "/ingest/static/:path*",
        destination: "https://us-assets.i.posthog.com/static/:path*",
      },
      {
        source: "/ingest/array/:path*",
        destination: "https://us-assets.i.posthog.com/array/:path*",
      },
      {
        source: "/ingest/:path*",
        destination: "https://us.i.posthog.com/:path*",
      },
    ];
  },
  skipTrailingSlashRedirect: true,
  // The Temporal client (gRPC) must not be bundled by Next — keep it as a runtime require
  // so its transitive native/protobuf deps load correctly in the server runtime.
  serverExternalPackages: ["@temporalio/client", "@temporalio/common"],
};

export default withNextIntl(nextConfig);
