import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  transpilePackages: ["@telar/core"],
  // Lets a production build run beside the always-on dev server without the
  // two fighting over .next (e.g. NEXT_DIST_DIR=.next-build bunx next build).
  distDir: process.env.NEXT_DIST_DIR ?? ".next",
  // Desktop (Electron) packaging boots the standalone server as a child
  // process. Gated behind an env so every dev flow stays unchanged; composes
  // with NEXT_DIST_DIR (e.g. NEXT_OUTPUT=standalone NEXT_DIST_DIR=.next-desktop).
  output: process.env.NEXT_OUTPUT === "standalone" ? "standalone" : undefined,
};

export default nextConfig;
