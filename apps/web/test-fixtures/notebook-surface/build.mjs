/**
 * Bundle the #204 harness for a browser, with `next/navigation` and
 * `next/link` resolved to the fixture's own stubs.
 *
 * A plugin rather than a tsconfig alias: the alias would apply to the whole
 * app, and the point is that only THIS bundle runs the real sidebar outside
 * Next. Everything else — the component, the libs it reads, the sidebar
 * primitives — is the production module.
 *
 * PLAIN `.mjs` ON PURPOSE: it is a build script for Bun's own API, not app
 * source, and the app's tsconfig has neither `bun-types` nor `import.meta.dir`.
 * Typing it would mean relaxing the project's types for one file that never
 * ships.
 *
 * Run: bun run apps/web/test-fixtures/notebook-surface/build.mjs
 */
import { resolve } from "node:path";

const here = import.meta.dir;
const out = process.env.OUT_DIR ?? "/tmp/telar-notebook-surface-fixture";

const stubs = {
  "next/navigation": resolve(here, "../host-identity/stubs/next-navigation.tsx"),
  "next/link": resolve(here, "../host-identity/stubs/next-link.tsx"),
};

const result = await Bun.build({
  entrypoints: [resolve(here, "harness.tsx")],
  outdir: out,
  target: "browser",
  naming: "harness.js",
  define: { "process.env.NODE_ENV": '"development"' },
  plugins: [
    {
      name: "fixture-next-stubs",
      setup(build) {
        build.onResolve({ filter: /^next\/(navigation|link)$/ }, (args) => ({ path: stubs[args.path] }));
      },
    },
  ],
});

if (!result.success) {
  for (const log of result.logs) console.error(log);
  process.exit(1);
}
console.log(`built ${result.outputs.map((output) => output.path).join(", ")}`);
