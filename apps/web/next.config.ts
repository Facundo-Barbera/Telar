import type { NextConfig } from "next";

/**
 * Which origins may talk to the DEV server.
 *
 * Next blocks cross-origin requests to dev-only assets and endpoints unless the
 * origin is listed here (see `node_modules/next/dist/docs/01-app/03-api-reference/
 * 05-config/01-next-config-js/allowedDevOrigins.md`). Binding the cockpit to a
 * Tailscale address is therefore only HALF of reaching it from another device:
 * without this the page loads and its dev assets are refused, which reads as a
 * broken app rather than as a policy decision.
 *
 * Derived from the SAME env var the launcher binds with, so the two cannot
 * disagree — a host allowed here but never bound, or bound and then refused, are
 * both silent-ish failures that cost a debugging session each.
 *
 * `TELAR_WEB_ALLOWED_ORIGINS` (comma-separated) covers the names that
 * RESOLVE to the bound address without being it. Tailscale is the case that
 * forces this: the launcher binds an IP, but people reach the machine by its
 * MagicDNS name, and an origin Next has never heard of is refused exactly as if
 * the app were broken.
 */
const devHost = process.env.TELAR_WEB_HOST?.trim();
const extraOrigins = (process.env.TELAR_WEB_ALLOWED_ORIGINS ?? "")
  .split(",")
  .map((origin) => origin.trim())
  .filter(Boolean);
const allowedDevOrigins = [
  ...(devHost && devHost !== "127.0.0.1" && devHost !== "localhost" ? [devHost] : []),
  ...extraOrigins,
];

const nextConfig: NextConfig = {
  // The browser-facing app talks to the engine only through its own route
  // handlers. Transpiling the tiny workspace client keeps that boundary usable
  // under Bun's isolated linker without inheriting any legacy web config.
  transpilePackages: ["@telar/engine-client"],
  distDir: process.env.NEXT_DIST_DIR ?? ".next",
  /**
   * Next's dev indicator defaults to `bottom-left`, which is exactly where this
   * app's sidebar puts its session list — it sat on top of the last row and
   * clipped its title. Moved rather than disabled: it still surfaces compile and
   * runtime errors, and losing that to tidy a corner is a bad trade.
   */
  devIndicators: { position: "bottom-right" },
  ...(allowedDevOrigins.length > 0 ? { allowedDevOrigins } : {}),
};

export default nextConfig;
