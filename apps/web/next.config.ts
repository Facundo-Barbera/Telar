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
  // route until a production build happens to leave one behind.
  //
  // WHY transpilePackages FIXES IT: `transpilePackages` takes precedence over
  // the built-in server-external list, so naming shiki here removes it from the
  // set of packages Next leaves unbundled — and a package that is bundled is
  // never `require`d from the dist directory at runtime, which takes the
  // resolution above, and the whole problem, off the table. (An earlier version
  // of this comment cited a line inside next's own webpack config as "the
  // mechanism". That is where the opt-out list is easiest to READ; it is not
  // what fails here, because the failure above is Turbopack's. A line number in
  // a dependency is not a name — §0's citation policy applies to node_modules
  // too.)
  transpilePackages: ["@telar/core", "shiki"],
  // REACHING THE DEV SERVER FROM ANOTHER MACHINE ON THE TAILNET.
  //
  // Next's dev server refuses `/_next/*` requests whose Origin it does not
  // recognize. The failure is quietly asymmetric and that is what makes it hard
  // to read: the SSR'd HTML and every `/api/*` route answer 200 as usual, so the
  // page PAINTS — but each `/_next/static/**` chunk comes back 403, React never
  // hydrates, and the client-side fetches that fill the UI never run. The
  // symptom is "it loads but there is no data", which points at the API, and the
  // API is fine. Measured directly: over the tailnet a chunk returned 403 while
  // `/api/chats` returned 200 with real rows.
  //
  // Both spellings are listed because either can reach this host, and an origin
  // is matched as sent: the MagicDNS name for `http://mini-fbarbera…:3000`, the
  // bare tailnet IP for `http://100.110.136.102:3000`. The wildcard covers the
  // other machines on this tailnet without needing an entry each.
  //
  // DEV-ONLY, and scoped on purpose. This setting has no effect on a production
  // build, and `*.snakebird-cardassian.ts.net` is one private tailnet rather
  // than a blanket allow — do NOT widen it to `*`, which would let any origin
  // drive the dev server's HMR endpoints.
  allowedDevOrigins: [
    "100.110.136.102",
    "mini-fbarbera.snakebird-cardassian.ts.net",
    "*.snakebird-cardassian.ts.net",
  ],
  // Lets a production build run beside the always-on dev server without the
  // two fighting over .next (e.g. NEXT_DIST_DIR=.next-build bunx next build).
  distDir: process.env.NEXT_DIST_DIR ?? ".next",
  // Desktop (Electron) packaging boots the standalone server as a child
  // process. Gated behind an env so every dev flow stays unchanged; composes
  // with NEXT_DIST_DIR (e.g. NEXT_OUTPUT=standalone NEXT_DIST_DIR=.next-desktop).
  output: process.env.NEXT_OUTPUT === "standalone" ? "standalone" : undefined,
};

export default nextConfig;
