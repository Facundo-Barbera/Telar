// Compile the app's real globals.css (Tailwind v4) for the picker fixture, so
// the rendered evidence shows the production look — tokens, dark mode and all.
// Uses the repo's own @tailwindcss/node + oxide; writes to OUT_DIR.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const web = path.resolve(here, "..", "..");
// The tailwind build packages live in the workspace's bun store without a
// symlink under apps/web/node_modules — imported by store path, version-pinned
// to what the app itself compiles with.
const store = path.resolve(web, "..", "..", "node_modules", ".bun");
const { compile } = await import(path.join(store, "@tailwindcss+node@4.3.3", "node_modules", "@tailwindcss", "node", "dist", "index.mjs"));
const { Scanner } = await import(path.join(store, "@tailwindcss+oxide@4.3.3", "node_modules", "@tailwindcss", "oxide", "index.js"));
const out = process.env.OUT_DIR ?? "/tmp/telar-model-picker-fixture";

const css = fs.readFileSync(path.join(web, "app", "globals.css"), "utf8");
const compiler = await compile(css, {
  base: path.join(web, "app"),
  onDependency: () => {},
});
const scanner = new Scanner({
  sources: [
    { base: path.join(web, "components"), pattern: "**/*.tsx", negated: false },
    { base: path.join(web, "app"), pattern: "**/*.tsx", negated: false },
    // Every fixture, not just this one: the sidebar-footer harness shares
    // this stylesheet and its own classes would otherwise be missing.
    { base: path.join(web, "test-fixtures"), pattern: "**/*.tsx", negated: false },
  ],
});
const candidates = scanner.scan();
fs.mkdirSync(out, { recursive: true });
fs.writeFileSync(path.join(out, "app.css"), compiler.build(candidates));
console.log(`app.css written with ${candidates.length} candidates`);
