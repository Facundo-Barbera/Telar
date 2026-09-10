/**
 * Bundle the run-header fixture into the shared fixture dir (it reuses that
 * build's compiled app.css).
 * Run: bun apps/web/test-fixtures/run-header/build.mjs
 */
import { resolve } from "node:path";
import fs from "node:fs";

const here = import.meta.dir;
const out = process.env.OUT_DIR ?? "/tmp/telar-model-picker-fixture";
const stubs = {
  "next/navigation": resolve(here, "..", "host-identity", "stubs", "next-navigation.tsx"),
  "next/link": resolve(here, "..", "host-identity", "stubs", "next-link.tsx"),
};

const result = await Bun.build({
  entrypoints: [resolve(here, "harness.tsx")],
  outdir: out,
  target: "browser",
  naming: "run-header.js",
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

const page = "run-header.html";
const script = "/run-header.js";
fs.writeFileSync(
  resolve(out, page),
  `<!doctype html>
<html class="dark"><head><meta charset="utf-8"><title>Run header fixture</title>
<link rel="stylesheet" href="/app.css"></head>
<body><div id="root"></div><script type="module" src="${script}"></script></body></html>
`,
);
console.log(`built ${out}${script} + ${page}`);
