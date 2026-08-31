import os from "node:os";
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
/**
 * BINDING EVERYTHING IMPLIES ALLOWING EVERY LOCAL ADDRESS AS AN ORIGIN. A
 * wildcard bind never equals the origin a browser presents — the laptop
 * reaching this machine over Tailscale says `100.x.y.z`, not `0.0.0.0` — so
 * the bound host alone allowed nothing, and the page loaded with every dev
 * asset refused: an app that renders and does not respond. The machine's own
 * interface addresses are exactly the set of origins a wildcard bind makes
 * reachable, so they are derived rather than asked for. MagicDNS or other
 * NAMES for this machine still need `TELAR_WEB_ALLOWED_ORIGINS`.
 */
const wildcardBind = devHost === "0.0.0.0" || devHost === "::";
const interfaceAddresses = wildcardBind
  ? Object.values(os.networkInterfaces())
      .flat()
      .flatMap((entry) => (entry && !entry.internal ? [entry.address] : []))
  : [];
const allowedDevOrigins = [
  ...(devHost && devHost !== "127.0.0.1" && devHost !== "localhost" && !wildcardBind ? [devHost] : []),
  ...interfaceAddresses,
  ...extraOrigins,
];

const nextConfig: NextConfig = {
  // The browser-facing app talks to the engine only through its own route
  // handlers. Transpiling the tiny workspace client keeps that boundary usable
  // under Bun's isolated linker without inheriting any legacy web config.
  transpilePackages: ["@telar/engine-client"],
  distDir: process.env.NEXT_DIST_DIR ?? ".next",
  /**
   * THE PACKAGED APP'S SERVER, and only when asked for.
   *
   * `standalone` makes Next emit a `server.js` plus the traced subset of
   * node_modules it actually needs, which is what the desktop shell forks —
   * there is no `bun install` inside a .app. It is opt-in through the env rather
   * than always-on because it changes what a build PRODUCES, and a developer
   * running `next build` to check for type errors should not pay for a
   * deployment artefact.
   *
   * Composed with NEXT_DIST_DIR above by the same script, so a packaging build
   * never collides with the dev server's `.next`.
   */
  output: process.env.NEXT_OUTPUT === "standalone" ? "standalone" : undefined,
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
