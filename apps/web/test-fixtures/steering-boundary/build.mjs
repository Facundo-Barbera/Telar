/**
 * Bundle the steering-boundary fixture into the shared fixture dir (it reuses
 * that build's compiled app.css). `BEFORE=1` reverts the one expression the
 * fix changed, IN MEMORY, so the regression can be seen rather than
 * described; the transform throws if the fixed expression is missing.
 * Run: bun apps/web/test-fixtures/steering-boundary/build.mjs
 */
import { resolve } from "node:path";
import fs from "node:fs";

const here = import.meta.dir;
const out = process.env.OUT_DIR ?? "/tmp/telar-model-picker-fixture";
const stubs = {
  "next/navigation": resolve(here, "..", "host-identity", "stubs", "next-navigation.tsx"),
  "next/link": resolve(here, "..", "host-identity", "stubs", "next-link.tsx"),
};

const before = process.env.BEFORE === "1";
const REVERT = {
  filter: /components\/session-cockpit\.tsx$/,
  fixed: '<LiveActivity items={response.items} tasks={turn.tasks} liveTail={false} {...(onOpenAgent ? { onOpenAgent } : {})} />',
  broken: '<ActivityGroup items={response.items} tasks={turn.tasks} live={false} {...(onOpenAgent ? { onOpenAgent } : {})} />',
};

const result = await Bun.build({
  entrypoints: [resolve(here, "harness.tsx")],
  outdir: out,
  target: "browser",
  naming: before ? "steering-before.js" : "steering.js",
  define: { "process.env.NODE_ENV": '"development"' },
  plugins: [
    ...(before
      ? [
          {
            name: "fixture-revert-steering-seams",
            setup(build) {
              build.onLoad({ filter: REVERT.filter }, async (args) => {
                const source = await Bun.file(args.path).text();
                if (!source.includes(REVERT.fixed)) throw new Error(`BEFORE=1 cannot find the fixed expression in ${args.path}`);
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

const page = before ? "steering-before.html" : "steering.html";
const script = before ? "/steering-before.js" : "/steering.js";
fs.writeFileSync(
  resolve(out, page),
  `<!doctype html>
<html class="dark"><head><meta charset="utf-8"><title>Steering boundary fixture${before ? " — BEFORE (regression)" : ""}</title>
<link rel="stylesheet" href="/app.css"></head>
<body><div id="root"></div><script type="module" src="${script}"></script></body></html>
`,
);
console.log(`built ${out}${script} + ${page}`);
