import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  poweredByHeader: false,
  output: "standalone",
  // Browser tests run isolated dev servers even if the developer already has one open.
  distDir: process.env.NEXT_DIST_DIR || ".next",
  // FEATURE_OFFLINE_READONLY, spelled out in src/config/features.ts. Both the
  // connectivity detection and the shell cache are decided when the app is
  // built, so cutting offline read-only means building with the flag off.
  experimental: {
    useOffline: process.env.FEATURE_OFFLINE_READONLY?.toLowerCase() === "true",
  },
  async headers() {
    return [
      {
        // The worker controls every navigation, so it is never cached itself.
        source: "/sw.js",
        headers: [
          {
            key: "Content-Type",
            value: "application/javascript; charset=utf-8",
          },
          {
            key: "Cache-Control",
            value: "no-cache, no-store, must-revalidate",
          },
          {
            key: "Content-Security-Policy",
            value: "default-src 'self'; script-src 'self'",
          },
        ],
      },
    ];
  },
};

export default nextConfig;
