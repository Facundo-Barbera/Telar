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
 * Run: bun run apps/web/test-fixtures/host-identity/build.mjs
 */
import { resolve } from "node:path";

const here = import.meta.dir;
const out = process.env.OUT_DIR ?? "/tmp/telar-host-identity-fixture";

const stubs = {
  "next/navigation": resolve(here, "stubs/next-navigation.tsx"),
  "next/link": resolve(here, "stubs/next-link.tsx"),
};

/**
 * `BEFORE=1` bundles the rail with its pre-fix line restored, IN MEMORY.
 *
 * A harness that only ever reports green proves nothing: it has to be shown
 * failing against the defect it is meant to catch. So this reverts exactly the
 * one expression the fix changed, as the bundler loads the file — the file on
 * disk is never touched, and the transform throws if the expression is not
 * found, so it cannot silently bundle the fixed code and call it "before".
 */
const before = process.env.BEFORE === "1";

/** Each entry: the file, and the one expression to put back as it was. */
const REVERTS = [
  {
    filter: /components\/app-sidebar\.tsx$/,
    fixed: "const hostApi = createEngineApi(hostFetcher(host?.id ?? LOCAL_HOST_ID));",
    broken: "const hostApi = host ? createEngineApi(hostFetcher(host.id)) : api;",
  },
  {
    filter: /components\/session\/fresh-greeting\.tsx$/,
    fixed: "if (project.id !== projectId) router.push(canvasHref(project.id, hostId));",
    broken: "if (project.id !== projectId) router.push(`/projects/${encodeURIComponent(project.id)}/sessions/new`);",
  },
];

const revertPlugin = {
  name: "fixture-revert-host-fixes",
  setup(build) {
    for (const revert of REVERTS) {
      build.onLoad({ filter: revert.filter }, async (args) => {
        const source = await Bun.file(args.path).text();
        if (!source.includes(revert.fixed)) throw new Error(`BEFORE=1 cannot find the fixed expression to revert in ${args.path}`);
        return { contents: source.replace(revert.fixed, revert.broken), loader: "tsx" };
      });
    }
  },
};

const result = await Bun.build({
  entrypoints: [resolve(here, "harness.tsx")],
  outdir: out,
  target: "browser",
  naming: before ? "harness-before.js" : "harness.js",
  define: { "process.env.NODE_ENV": '"development"' },
  plugins: [
    ...(before ? [revertPlugin] : []),
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
