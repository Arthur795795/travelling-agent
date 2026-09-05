import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  poweredByHeader: false,
  // Browser tests run isolated dev servers even if the developer already has one open.
  distDir: process.env.NEXT_DIST_DIR || ".next",
};

export default nextConfig;
