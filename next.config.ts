import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  compiler: {
    styledComponents: true,
  },
  // Baseline security headers for a self-hosted auth'd app. HSTS is a no-op over
  // plain HTTP (dev), and the app is never meant to be framed. A full CSP is left
  // out deliberately — it needs per-request nonce wiring for Next's inline runtime
  // + styled-components; see SECURITY.md.
  async headers() {
    return [
      {
        source: "/:path*",
        headers: [
          { key: "X-Frame-Options", value: "DENY" },
          { key: "X-Content-Type-Options", value: "nosniff" },
          { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
          {
            key: "Strict-Transport-Security",
            value: "max-age=31536000; includeSubDomains",
          },
        ],
      },
    ];
  },
};

export default nextConfig;
