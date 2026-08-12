import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // The browser-facing app talks to the engine only through its own route
  // handlers. Transpiling the tiny workspace client keeps that boundary usable
  // under Bun's isolated linker without inheriting any legacy web config.
  transpilePackages: ["@telar/engine-client"],
  distDir: process.env.NEXT_DIST_DIR ?? ".next",
};

export default nextConfig;
