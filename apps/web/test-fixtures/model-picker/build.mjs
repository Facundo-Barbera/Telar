/**
 * Bundle the model-picker fixture: the REAL AgentControl with only the
 * catalogue cache resolved to the fixture stub (captured real catalogues).
 * Run: bun apps/web/test-fixtures/model-picker/build.mjs
 * (build-css.mjs compiles the app's real Tailwind output separately.)
 */
import { resolve } from "node:path";
import fs from "node:fs";

const here = import.meta.dir;
const out = process.env.OUT_DIR ?? "/tmp/telar-model-picker-fixture";

const result = await Bun.build({
  entrypoints: [resolve(here, "harness.tsx")],
  outdir: out,
  target: "browser",
  naming: "harness.js",
  define: { "process.env.NODE_ENV": '"development"' },
  loader: { ".txt": "text" },
  plugins: [
    {
      name: "fixture-catalogue-stub",
      setup(build) {
        build.onResolve({ filter: /(^|\/)model-catalogue-cache$/ }, (args) => {
          if (args.importer.includes("test-fixtures")) return undefined; // the stub's own relative imports
          return { path: resolve(here, "stubs", "model-catalogue-cache.ts") };
        });
      },
    },
  ],
});

if (!result.success) {
  for (const log of result.logs) console.error(log);
  process.exit(1);
}

fs.writeFileSync(
  resolve(out, "index.html"),
  `<!doctype html>
<html class="dark"><head><meta charset="utf-8"><title>Model picker fixture</title>
<link rel="stylesheet" href="/app.css"></head>
<body><div id="root"></div><script type="module" src="/harness.js"></script></body></html>
`,
);
console.log(`built ${result.outputs.map((output) => output.path).join(", ")} + index.html`);
