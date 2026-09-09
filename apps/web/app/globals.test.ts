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
/** The same file with `/* … *␘/` stripped — the stylesheet argues for itself at
 *  length, and a rule quoted in prose is not a rule. Anything asserting about
 *  what the browser SEES reads this rather than `css`. */
const code = css.replaceAll(/\/\*[\s\S]*?\*\//g, "");

/** The declarations inside the FIRST top-level block whose selector is `selector`. */
function block(selector: string): string {
  return blocks(selector)[0] ?? "";
}

/**
 * EVERY top-level block for `selector`, because `:root` is opened more than
 * once: the palette near the top, and the titlebar contract down by the drag
 * rules, which is deliberately grouped with the prose that explains it. A
 * token-definition check that reads only the first block calls the second
 * block's tokens undefined — which is how `--titlebar-height` came to look
 * bare the moment the stylesheet started reading it itself.
 */
function blocks(selector: string): string[] {
  const found: string[] = [];
  for (let start = css.indexOf(`${selector} {`); start !== -1; start = css.indexOf(`${selector} {`, start + 1)) {
    let depth = 0;
    for (let index = css.indexOf("{", start); index < css.length; index += 1) {
      if (css[index] === "{") depth += 1;
      if (css[index] === "}") {
        depth -= 1;
        if (depth === 0) {
          found.push(css.slice(start, index));
          break;
        }
      }
    }
  }
  return found;
}

const rootTokens = new Set([...blocks(":root").join("\n").matchAll(/^\s*(--[a-z0-9-]+)\s*:/gm)].map((match) => match[1]));
const darkTokens = new Set([...blocks(".dark").join("\n").matchAll(/^\s*(--[a-z0-9-]+)\s*:/gm)].map((match) => match[1]));
const theme = block("@theme inline");

describe("the design token palette", () => {
  test("defines every token it reads", () => {
    expect(rootTokens.size).toBeGreaterThan(25);

    /**
     * Tokens supplied from OUTSIDE this stylesheet, which are therefore
     * legitimately read but never defined here:
     *  - `--font-geist-*`, `--font-inter`, `--font-jetbrains`, `--font-plex-*`
     *    and `--font-fira-code` are emitted by next/font in layout.tsx — one
     *    per family the appearance pane offers.
     *  - `--sdm-c`, `--shiki-light` and `--shiki-dark` are written by Shiki into
     *    inline styles — the first by Streamdown's copy for the transcript's
     *    code blocks, the other two by the file viewer's own tokens.
     *  - `--shimmer-*` are set by the Shimmer component's own inline style.
     */
    const external = /^--(?:font-geist-|font-inter|font-jetbrains|font-plex-sans|font-plex-mono|font-fira-code|sdm-c|shiki-light|shiki-dark|shimmer-)/;

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
    //
    // `var(--x-wash, var(--x))` is the wash indirection (see @theme's note on
    // --color-sidebar): the FALLBACK is the themed token and the one that has
    // to exist in both blocks, so the pattern reaches past the override name.
    const bridged = [...theme.matchAll(/--color-[a-z0-9-]+:\s*var\(\s*(--[a-z0-9-]+)(?:\s*,\s*var\(\s*(--[a-z0-9-]+)\s*\))?/g)].map(
      (match) => match[2] ?? match[1],
    );
    expect(bridged.length).toBeGreaterThan(20);
    expect(bridged, "the wash indirection must still bridge the themed token").toContain("--sidebar");
    const missing = bridged.filter((token) => rootTokens.has(token) && !darkTokens.has(token));
    expect(missing).toEqual([]);
  });
});

/**
 * THE WASH THINS GROUNDS AND NEVER RETINTS A MARK.
 *
 * The long note beside the translucency rules in globals.css argues this out;
 * these are the two halves of it that a future edit could quietly undo, so
 * they are assertions rather than prose.
 */
describe("the translucency wash", () => {
  /** Every declaration inside a rule whose selector mentions the wash gate. */
  const washBlocks = [...code.matchAll(/(:is\(\[data-telar-shell\]\[data-translucent\], \[data-backdrop\]\)[^{]*)\{([^}]*)\}/g)];

  test("gates on both attributes, and there is more than one rule doing it", () => {
    expect(washBlocks.length).toBeGreaterThan(1);
  });

  test("never redefines a token every call site also reads at partial alpha", () => {
    // `bg-muted/25` compiles to a mix against transparent, so alpha on the
    // TOKEN multiplies rather than replaces: a 72%-alpha --muted lands those
    // elements at 18% and they vanish over a backdrop. The same class string
    // renders on a page with no scene, where /25 means what it says — so the
    // token is the thing that must not move. --sidebar is the exception and
    // moves through `--sidebar-wash`, which no utility reads directly.
    const forbidden = ["--muted", "--accent", "--sidebar-accent", "--sidebar", "--card", "--popover", "--secondary"];
    const offenders: string[] = [];
    for (const [, , body] of washBlocks) {
      for (const [, token] of body.matchAll(/^\s*(--[a-z0-9-]+)\s*:/gm)) {
        if (forbidden.includes(token)) offenders.push(token);
      }
    }
    expect(offenders).toEqual([]);
  });

  test("the see-through opt-in is a class, never a utility's class name", () => {
    // Matching `.bg-background\/80` made "is this a ground?" a question about
    // the string a component typed, and it stripped the fill off four real
    // components in components/composer.tsx that merely wanted 80%.
    expect(code).not.toMatch(/\.bg-background\\\//);
    const optIn = washBlocks.find(([, selector]) => selector.includes("app-ground"));
    expect(optIn, "a rule must still make .app-ground transparent").toBeDefined();
    expect(optIn?.[2]).toContain("background-color: transparent");
  });
});

describe("the backdrop layer", () => {
  test("the root carries its own background, so the wash paints ABOVE the scene", () => {
    // Without this, body's background PROPAGATES to the canvas, which is
    // painted below a `z-index: -1` descendant — putting the translucency wash
    // underneath the very wallpaper it exists to tint. Scoped to
    // [data-backdrop] so the shell's vibrancy still gets propagation.
    expect(code).toMatch(/\n\[data-backdrop\]\s*\{[^}]*background-color:\s*var\(--background\)/);
    expect(code).toMatch(/z-index:\s*-1/);
  });
});

/**
 * A source file with its PROSE removed — block comments, and lines that are
 * nothing but a comment.
 *
 * This app argues for its decisions in the files that make them, so the note
 * explaining why `text-sky-600` is banned quotes `text-sky-600`. A guard that
 * cannot tell the rule from the code fails on its own documentation, and the
 * only way to satisfy it is to stop writing the rule down.
 *
 * Deliberately not a tokeniser: trailing `//` comments are LEFT ALONE, because
 * dropping the rest of a line would also drop an offender sitting before a URL
 * in a string on that line. Prose lives in the two forms handled here.
 */
function withoutProse(file: string): string {
  return fs
    .readFileSync(file, "utf8")
    .replaceAll(/\/\*[\s\S]*?\*\//g, "")
    .replaceAll(/^[ \t]*\/\/.*$/gm, "");
}

/** Every .ts/.tsx under app/ and components/ (and lib/ when asked), minus
 *  tests — the corpus the class-string guards below read. */
function sources(segments: readonly string[], extension: RegExp): string[] {
  const found: string[] = [];
  const walk = (root: string) => {
    for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
      const file = path.join(root, entry.name);
      if (entry.isDirectory()) {
        walk(file);
        continue;
      }
      if (!extension.test(file) || file.includes(".test.")) continue;
      found.push(file);
    }
  };
  for (const segment of segments) walk(path.join(here, "..", segment));
  return found;
}

describe("the text scale", () => {
  /**
   * THE ZOOM IS THE ROOT FONT SIZE, so anything measured in px opts out of it.
   *
   * lib/appearance.ts sets `html { font-size }` between 13 and 18px and every
   * rem-based dimension in the app follows — which was the claim, but 357
   * `text-[11px]` / `text-[10px]` / `text-[9px]` utilities were quietly
   * exempt. A reader who moved the slider to 18 got a bigger shell with the
   * same unreadable badges, chips and captions in it: the setting appeared to
   * do half its job for no stated reason.
   *
   * The equivalents are exact at the 16px default (11 → 0.6875rem,
   * 10 → 0.625rem, 9 → 0.5625rem), so the sweep changed nothing about how the
   * app looks until the slider moves.
   */
  test("no component pins a font size in px", () => {
    const offenders: string[] = [];
    for (const file of sources(["app", "components", "lib"], /\.tsx?$/)) {
      for (const hit of withoutProse(file).matchAll(/text-\[[0-9.]+px\]/g)) {
        offenders.push(`${path.relative(path.join(here, ".."), file)}: ${hit[0]}`);
      }
    }
    expect(offenders).toEqual([]);
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

    const offenders: string[] = [];
    // components/ui/* are vendored primitives; they are held to the same rule,
    // and any ramp in one is a porting mistake worth catching.
    //
    // lib/ IS IN SCOPE, because that is where the rule was being broken. The
    // guard only ever read .tsx under app/ and components/, and the two files
    // that actually held eight raw ramps each — lib/file-kinds.ts and
    // lib/glyph-paths.ts — are LOOKUP TABLES of class strings in .ts. A class
    // string is a class string wherever it is written down.
    for (const file of sources(["app", "components", "lib"], /\.tsx?$/)) {
      for (const hit of withoutProse(file).matchAll(pattern)) {
        offenders.push(`${path.relative(path.join(here, ".."), file)}: ${hit[0]}`);
      }
    }
    expect(offenders).toEqual([]);
  });

  test("nothing paints a scrim or a shadow in raw black or white", () => {
    // `bg-black/10` on the two overlays and `rgba(0,0,0,.9)` in three shadows:
    // colours no palette owns, so they laid a cold film over a warm theme and
    // could not follow one anywhere. --overlay and --shadow-tint are mixed
    // from the live tokens instead, and each flips ENDS between the schemes.
    const pattern = /\b(?:bg|text|border|ring|fill|stroke)-(?:black|white)\/\d+|rgba?\(\s*0\s*,\s*0\s*,\s*0\s*[,)]/g;
    const offenders: string[] = [];
    for (const file of sources(["app", "components", "lib"], /\.tsx?$/)) {
      for (const hit of withoutProse(file).matchAll(pattern)) {
        offenders.push(`${path.relative(path.join(here, ".."), file)}: ${hit[0]}`);
      }
    }
    expect(offenders).toEqual([]);
  });
});
