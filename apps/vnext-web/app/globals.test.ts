/**
 * Every design token this stylesheet reads must be one it defines.
 *
 * THE BUG THIS PINS WAS INVISIBLE AND SHIPPED. `--v-border`, `--v-muted` and
 * `--v-accent` were referenced 23 times and defined nowhere. CSS does not warn:
 * an undefined `var()` in `border: 1px solid var(--v-border)` falls back to
 * `currentColor`, so every tool card drew a heavy ink-coloured border where a
 * hairline was intended, and `color: var(--v-muted)` simply dropped the
 * declaration and inherited. Nothing failed; it just looked wrong, which is the
 * hardest kind of wrong to attribute.
 */
// @ts-expect-error bun:test has no types in this app's tsconfig
import { expect, test } from "bun:test";
import fs from "node:fs";
import { fileURLToPath } from "node:url";

// `import.meta.url` rather than Bun's `import.meta.dir`: this app's tsconfig
// does not carry Bun's types, and the URL form is standard and typed.
const css = fs.readFileSync(fileURLToPath(new URL("./globals.css", import.meta.url)), "utf8");

test("no rule reads a --v- token the stylesheet never defines", () => {
  const defined = new Set([...css.matchAll(/^\s*(--v-[a-z0-9-]+)\s*:/gm)].map((m) => m[1]));
  expect(defined.size).toBeGreaterThan(8);

  const read = new Set([...css.matchAll(/var\(\s*(--v-[a-z0-9-]+)/g)].map((m) => m[1]));
  expect(read.size).toBeGreaterThan(5);

  // A `var(--x, fallback)` is legitimate — the fallback is the intent. Bare
  // reads of an undefined token are not.
  const bare = [...read].filter((token) => {
    if (defined.has(token)) return false;
    return !new RegExp(`var\\(\\s*${token}\\s*,`).test(css);
  });
  expect(bare).toEqual([]);
});
