/**
 * The palette has to be REACHABLE and COMPLETE.
 *
 * Two failure modes, both silent, both shipped here before:
 *
 * 1. A TOKEN READ BUT NEVER DEFINED. CSS does not warn: an undefined `var()` in
 *    `border: 1px solid var(--x)` falls back to `currentColor`, so a hairline
 *    draws as heavy ink, and `color: var(--x)` drops the declaration and
 *    inherits. Nothing fails; it just looks wrong, which is the hardest kind of
 *    wrong to attribute. Three tokens were read 23 times and defined never.
 *
 * 2. A TOKEN DEFINED BUT NEVER BRIDGED. Tailwind v4 only emits a utility for a
 *    `--color-*` name it can see in the `@theme` block, so a token declared in
 *    `:root` and nowhere else is unreachable — `text-success` compiles to
 *    nothing and leaves the text whatever it inherited.
 *
 * Both are checked against the file rather than against a list, so adding a
 * token cannot quietly skip either half.
 */
// @ts-expect-error bun:test has no types in this app's tsconfig
import { describe, expect, test } from "bun:test";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

// `import.meta.url` rather than Bun's `import.meta.dir`: this app's tsconfig
// does not carry Bun's types, and the URL form is standard and typed.
const here = fileURLToPath(new URL(".", import.meta.url));
const css = fs.readFileSync(path.join(here, "globals.css"), "utf8");

/** The declarations inside a top-level block whose selector is `selector`. */
function block(selector: string): string {
  const start = css.indexOf(`${selector} {`);
  if (start === -1) return "";
  let depth = 0;
  for (let index = css.indexOf("{", start); index < css.length; index += 1) {
    if (css[index] === "{") depth += 1;
    if (css[index] === "}") {
      depth -= 1;
      if (depth === 0) return css.slice(start, index);
    }
  }
  return "";
}

const rootTokens = new Set([...block(":root").matchAll(/^\s*(--[a-z0-9-]+)\s*:/gm)].map((match) => match[1]));
const darkTokens = new Set([...block(".dark").matchAll(/^\s*(--[a-z0-9-]+)\s*:/gm)].map((match) => match[1]));
const theme = block("@theme inline");

describe("the design token palette", () => {
  test("defines every token it reads", () => {
    expect(rootTokens.size).toBeGreaterThan(25);

    /**
     * Tokens supplied from OUTSIDE this stylesheet, which are therefore
     * legitimately read but never defined here:
     *  - `--font-geist-*` are emitted by next/font in layout.tsx.
     *  - `--sdm-c`, `--shiki-light` and `--shiki-dark` are written by Shiki into
     *    inline styles — the first by Streamdown's copy for the transcript's
     *    code blocks, the other two by the file viewer's own tokens.
     *  - `--shimmer-*` are set by the Shimmer component's own inline style.
     */
    const external = /^--(?:font-geist-|sdm-c|shiki-light|shiki-dark|shimmer-)/;

    const read = new Set([...css.matchAll(/var\(\s*(--[a-z0-9-]+)/g)].map((match) => match[1]));
    expect(read.size).toBeGreaterThan(10);

    const bare = [...read].filter((token) => {
      if (rootTokens.has(token) || darkTokens.has(token) || external.test(token)) return false;
      // `var(--x, fallback)` is legitimate — the fallback IS the intent.
      return !new RegExp(`var\\(\\s*${token}\\s*,`).test(css);
    });
    expect(bare).toEqual([]);
  });

  test("bridges every colour token into @theme, so a utility exists for it", () => {
    // The state vocabulary is the part that regressed historically: --info,
    // --verify, --success and --warning were declared and unreachable.
    for (const token of ["info", "verify", "success", "warning", "destructive", "primary", "muted-foreground", "border"]) {
      expect(theme, `--color-${token} is not bridged in @theme`).toContain(`--color-${token}: var(--${token})`);
    }
  });

  test("gives every themed colour a dark counterpart", () => {
    // A token bridged into @theme is used by utilities in BOTH themes, so a
    // value that only exists in :root silently keeps its light value on a dark
    // surface. `--ring` is excluded: it aliases --primary in both blocks.
    const bridged = [...theme.matchAll(/--color-[a-z0-9-]+:\s*var\((--[a-z0-9-]+)\)/g)].map((match) => match[1]);
    expect(bridged.length).toBeGreaterThan(20);
    const missing = bridged.filter((token) => rootTokens.has(token) && !darkTokens.has(token));
    expect(missing).toEqual([]);
  });
});

describe("the state vocabulary", () => {
  /**
   * "Do not add a sixth ramp; keep new state colours on this vocabulary."
   *
   * The palette's own note says so, and the frozen app records what happens
   * otherwise: a status rail on `bg-emerald-400` sitting next to a badge on
   * --success reads as two different products. A raw Tailwind ramp also cannot
   * re-theme, because it is a fixed sRGB value rather than a token.
   */
  test("no component reaches for a raw Tailwind colour ramp", () => {
    const ramps = "red|orange|amber|yellow|lime|green|emerald|teal|cyan|sky|blue|indigo|violet|purple|fuchsia|pink|rose|slate|gray|zinc|neutral|stone";
    const pattern = new RegExp(`\\b(?:bg|text|border|ring|fill|stroke|from|to|via)-(?:${ramps})-\\d{2,3}\\b`, "g");

    const roots = ["app", "components"].map((segment) => path.join(here, "..", segment));
    const offenders: string[] = [];
    const walk = (root: string) => {
      for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
        const file = path.join(root, entry.name);
        if (entry.isDirectory()) {
          walk(file);
          continue;
        }
        if (!/\.tsx$/.test(file) || file.includes(".test.")) continue;
        // components/ui/* are vendored primitives; they are held to the same
        // rule, and any ramp in one is a porting mistake worth catching.
        for (const hit of fs.readFileSync(file, "utf8").matchAll(pattern)) {
          offenders.push(`${path.relative(path.join(here, ".."), file)}: ${hit[0]}`);
        }
      }
    };
    for (const root of roots) walk(root);
    expect(offenders).toEqual([]);
  });
});
