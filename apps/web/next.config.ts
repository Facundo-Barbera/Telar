import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  transpilePackages: ["@telar/core"],
  // Lets a production build run beside the always-on dev server without the
  // two fighting over .next (e.g. NEXT_DIST_DIR=.next-build bunx next build).
  distDir: process.env.NEXT_DIST_DIR ?? ".next",
};

export default nextConfig;
