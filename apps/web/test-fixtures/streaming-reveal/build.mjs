// Bundle the streaming-reveal fixture (the REAL hook on a controllable
// clock). Run: bun apps/web/test-fixtures/streaming-reveal/build.mjs
import { resolve } from "node:path";
import fs from "node:fs";

const here = import.meta.dir;
const out = process.env.OUT_DIR ?? "/tmp/telar-streaming-reveal-fixture";

const result = await Bun.build({
  entrypoints: [resolve(here, "fixture.tsx")],
  outdir: out,
  target: "browser",
  naming: "fixture.js",
  define: { "process.env.NODE_ENV": '"development"' },
});
if (!result.success) {
  for (const log of result.logs) console.error(log);
  process.exit(1);
}

fs.writeFileSync(
  resolve(out, "index.html"),
  `<!doctype html>
<html><head><meta charset="utf-8"><title>Streaming reveal fixture</title>
<style>
  body { font: 13px/1.5 -apple-system, system-ui, sans-serif; margin: 0; padding: 16px 20px; background: #111; color: #ddd; }
  .controls { display: flex; flex-wrap: wrap; gap: 6px; margin-bottom: 12px; }
  button { font: inherit; font-size: 12px; padding: 4px 10px; border-radius: 6px; border: 1px solid #444; background: #222; color: #ddd; }
  button:hover { background: #333; }
  .meta { color: #888; font-family: ui-monospace, monospace; font-size: 11px; margin: 8px 0; }
  pre { background: #1a1a1a; border-radius: 8px; padding: 10px; white-space: pre-wrap; min-height: 4em; }
  .result { margin: 6px 0; font-family: ui-monospace, monospace; font-size: 11px; }
  .scenario { font-weight: 600; margin-top: 8px; }
  .pass { color: #6fbf73; } .fail { color: #e5484d; }
  #summary { font-weight: 700; margin: 10px 0; }
</style></head>
<body><div id="root"></div><script type="module" src="/fixture.js"></script></body></html>
`,
);
console.log(`built ${out}/fixture.js + index.html`);
