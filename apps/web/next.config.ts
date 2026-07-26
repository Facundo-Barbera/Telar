import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // "shiki" is not ours — it is a transitive dep of @streamdown/code, listed here
  // to force Next to BUNDLE it. Next ships shiki on its built-in
  // serverExternalPackages list, so by default it is never bundled and is loaded
  // by native Node `require` from .next/**/chunks/ at runtime. Under bun's
  // isolated linker shiki exists only at node_modules/.bun/shiki@x/node_modules/
  // shiki, which is not reachable from there, so Turbopack rewrites the import to
  // a hashed alias and expects a symlink at <distDir>/node_modules/shiki-<hash>.
  // `next build` writes that symlink; `next dev` does not — so dev 500s on every
  // route until a production build happens to leave one behind. transpilePackages
  // removes a package from the opt-out-bundling list (build/webpack-config.js:697),
  // which takes the runtime require, and the whole problem, off the table.
  transpilePackages: ["@telar/core", "shiki"],
  // Lets a production build run beside the always-on dev server without the
  // two fighting over .next (e.g. NEXT_DIST_DIR=.next-build bunx next build).
  distDir: process.env.NEXT_DIST_DIR ?? ".next",
  // Desktop (Electron) packaging boots the standalone server as a child
  // process. Gated behind an env so every dev flow stays unchanged; composes
  // with NEXT_DIST_DIR (e.g. NEXT_OUTPUT=standalone NEXT_DIST_DIR=.next-desktop).
  output: process.env.NEXT_OUTPUT === "standalone" ? "standalone" : undefined,
};

export default nextConfig;
