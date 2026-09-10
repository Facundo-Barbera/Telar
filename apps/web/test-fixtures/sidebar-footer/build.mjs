// Bundle the sidebar-footer fixture into the shared picker-fixture dir (it
// reuses that build's compiled app.css). next/link and next/navigation
// resolve to the host-identity fixture's stubs — same plugin, same reason.
// Run: bun apps/web/test-fixtures/sidebar-footer/build.mjs
import { resolve } from "node:path";
import fs from "node:fs";

const here = import.meta.dir;
const out = process.env.OUT_DIR ?? "/tmp/telar-model-picker-fixture";
const stubs = {
  "next/navigation": resolve(here, "..", "host-identity", "stubs", "next-navigation.tsx"),
  "next/link": resolve(here, "..", "host-identity", "stubs", "next-link.tsx"),
};

/**
 * `BEFORE=1` bundles the footer with the pull/push race guard removed, IN
 * MEMORY — a harness that only ever reports green proves nothing, so it has
 * to be shown failing against the defect it catches. The file on disk is
 * never touched, and the transform throws if the expression is missing, so
 * it cannot silently bundle the fixed code and call it "before".
 */
const before = process.env.BEFORE === "1";
const REVERT = {
  filter: /components\/app-sidebar-footer\.tsx$/,
  fixed: "if (live && !pushed && current && current.status !== \"unsupported\") setStatus(current);",
  broken: "if (live && current && current.status !== \"unsupported\") setStatus(current);",
};

const result = await Bun.build({
  entrypoints: [resolve(here, "harness.tsx")],
  outdir: out,
  target: "browser",
  naming: before ? "footer-before.js" : "footer.js",
  define: { "process.env.NODE_ENV": '"development"' },
  plugins: [
    ...(before
      ? [
          {
            name: "fixture-revert-race-guard",
            setup(build) {
              build.onLoad({ filter: REVERT.filter }, async (args) => {
                const source = await Bun.file(args.path).text();
                if (!source.includes(REVERT.fixed)) throw new Error(`BEFORE=1 cannot find the guarded expression in ${args.path}`);
                return { contents: source.replace(REVERT.fixed, REVERT.broken), loader: "tsx" };
              });
            },
          },
        ]
      : []),
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
const page = before ? "footer-before.html" : "footer.html";
const script = before ? "/footer-before.js" : "/footer.js";
fs.writeFileSync(
  resolve(out, page),
  `<!doctype html>
<html class="dark"><head><meta charset="utf-8"><title>Sidebar footer fixture${before ? " — BEFORE (race guard removed)" : ""}</title>
<link rel="stylesheet" href="/app.css"></head>
<body><div id="root"></div><script type="module" src="${script}"></script></body></html>
`,
);
console.log(`built ${out}${script} + ${page}`);
