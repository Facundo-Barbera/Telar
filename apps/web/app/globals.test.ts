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
    //
    // `var(--x-wash, var(--x))` counts as bridged: the wash indirection (see
    // @theme's note on --color-sidebar) is how a token the translucency rules
    // have to move reaches a utility, and the FALLBACK is still the themed
    // token. --muted-foreground wears it since #434.
    for (const token of ["info", "verify", "success", "warning", "destructive", "primary", "muted-foreground", "border"]) {
      const bridge = new RegExp(`--color-${token}:\\s*var\\(--${token}\\)|--color-${token}:\\s*var\\(--${token}-wash,\\s*var\\(--${token}\\)\\)`);
      expect(theme, `--color-${token} is not bridged in @theme`).toMatch(bridge);
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

  /**
   * THE TWO HALVES DO NOT SPEND THE SLIDER THE SAME WAY — issues #399, #434.
   *
   * Translucent light read as a sheet where translucent dark read as glass, and
   * #399 got the direction of the fix backwards: it gave light LESS of the
   * slider, on a contrast argument, and the pane stayed opaque. The same alpha
   * simply does not buy the same see-through in the two halves — a near-white
   * canvas frosts where a near-black one glasses — so light has to OVERSHOOT,
   * with a cap keeping the top of the slider from erasing the canvas.
   *
   * Asserted as a SHAPE (factor above 1, and a cap) rather than as the two
   * numbers, because both are tunings and a re-tune should not be a test edit.
   */
  test("the light half spends MORE of the slider than the dark half, up to a cap", () => {
    const rule = code.match(/--wash-transparency:\s*min\(\s*calc\(\s*var\(--translucency[^)]*\)\s*\*\s*([0-9.]+)\s*\)\s*,\s*([0-9.]+)%\s*\)/);
    expect(rule, "the light half must overshoot --translucency and cap the result").not.toBeNull();
    expect(Number(rule?.[1]), "light must spend more of the slider, not less").toBeGreaterThan(1);
    expect(Number(rule?.[2])).toBeGreaterThan(0);
    expect(Number(rule?.[2]), "the cap has to leave some canvas").toBeLessThan(100);
  });

  test("only the light half declares it — dark takes the fallback, unchanged", () => {
    // The dark half is byte-for-byte what it computed before #399, which is
    // what makes this a light-mode repair rather than a retune of both.
    const declarations = [...code.matchAll(/^([^\n{]*)\{[^}]*--wash-transparency\s*:/gm)].map(([, selector]) => selector.trim());
    expect(declarations).toHaveLength(1);
    expect(declarations[0]).toContain(":not(.dark)");
  });

  /**
   * THE QUIET TOKENS GET A FLOOR UNDER GLASS, IN LIGHT ONLY — issue #434.
   *
   * --muted-foreground is tuned to clear 4.5:1 on the quietest OPAQUE surface
   * it lands on; thinning that surface takes the measurement away with it and
   * sidebar rows and hints go grey on grey. The scope is the assertion: on the
   * dark half the floor would only make text heavier for nothing, and on an
   * opaque window the palette is already correct.
   */
  test("light under glass gets a legibility floor, and nothing else does", () => {
    const floor = code.match(/html:not\(\.dark\)\[data-telar-shell\]\[data-translucent\]\s*\{([^{}]*)\}/);
    expect(floor, "the light translucent scene must raise its quiet text tokens").not.toBeNull();
    // Toward the theme's OWN ink — a hardcoded colour here would throw away a
    // custom theme's hue, which is the mistake the wash contract above records.
    expect(floor?.[1]).toContain("--muted-foreground-wash: color-mix(in oklab, var(--foreground)");
    expect(floor?.[1]).toContain("--sidebar-foreground-wash: color-mix(in oklab, var(--foreground)");

    for (const token of ["--muted-foreground-wash", "--sidebar-foreground-wash"]) {
      const declarations = [...code.matchAll(new RegExp(`([^\\n{]*)\\{[^{}]*${token}\\s*:`, "g"))].map(([, selector]) => selector.trim());
      expect(declarations, `${token} must be declared exactly once`).toHaveLength(1);
      expect(declarations[0]).toBe("html:not(.dark)[data-telar-shell][data-translucent]");
    }
  });

  test("body and the rail read the scaled value, not the raw slider", () => {
    // Scaling one and not the other is how the canvas and the rail start
    // disagreeing about how transparent 45% is.
    const body = washBlocks.find(([, selector]) => selector.trim().endsWith("body"));
    const rail = washBlocks.find(([, , declarations]) => declarations.includes("--sidebar-wash"));
    for (const rule of [body, rail]) {
      expect(rule?.[2]).toContain("var(--wash-transparency,");
    }
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
  /**
   * `test-fixtures/` IS IN SCOPE for both guards below. A harness renders the
   * real components for a visual test, so a size pinned in one is a size the
   * snapshot then certifies — the fixture would go on asserting the drift it
   * introduced.
   */
  const corpus = ["app", "components", "lib", "test-fixtures"] as const;

  test("no component pins a font size in px", () => {
    const offenders: string[] = [];
    for (const file of sources(corpus, /\.tsx?$/)) {
      for (const hit of withoutProse(file).matchAll(/text-\[[0-9.]+px\]/g)) {
        offenders.push(`${path.relative(path.join(here, ".."), file)}: ${hit[0]}`);
      }
    }
    expect(offenders).toEqual([]);
  });

  /**
   * A NAMED STEP AND ITS ARBITRARY TWIN CANNOT BOTH BE IN THE TREE.
   *
   * The px guard above is not enough on its own. Converting `text-[11px]` to
   * `text-[0.6875rem]` satisfies it while leaving the call site exactly as
   * unnamed as it was: the ramp still has no name at the point of use, the
   * next 11px caption is still written by copying a decimal out of a
   * neighbouring file, and a re-tune of the step has to find all of them by
   * value. That is the state 61 files were in before the tokens existed, and
   * it is the state they drift back to one paste at a time.
   *
   * Read off the `@theme` block rather than from a list of four, so naming a
   * fifth step forbids its arbitrary twin in the same commit — the list here
   * could only ever be the one that was true when it was typed.
   *
   * Only the EXACT declared value is an offender. A size that is genuinely not
   * on the ramp stays writable — the point is that the scale is named, not
   * that every size must come from it.
   */
  test("no component writes a named step's own value as an arbitrary size", () => {
    const steps = [
      ...theme.replaceAll(/\/\*[\s\S]*?\*\//g, "").matchAll(/^\s*--text-([a-z0-9-]+)\s*:\s*([0-9.]+rem)\s*;/gm),
    ].map(([, name, value]) => ({ name, value }));
    // The four the sweep introduced; a regex that matched nothing would make
    // this test vacuous rather than failing.
    expect(steps.length).toBeGreaterThanOrEqual(4);

    const offenders: string[] = [];
    for (const file of sources(corpus, /\.tsx?$/)) {
      const source = withoutProse(file);
      for (const { name, value } of steps) {
        for (const hit of source.matchAll(new RegExp(`text-\\[${value.replaceAll(".", "\\.")}\\]`, "g"))) {
          offenders.push(`${path.relative(path.join(here, ".."), file)}: ${hit[0]} → text-${name}`);
        }
      }
    }
    expect(offenders).toEqual([]);
  });
});

/**
 * A CARD MUST PAINT — issue #691, and the half of the wash contract that had no
 * test at all.
 *
 * `globals.css` argues the rule out at length and `globals.test.ts` checked it
 * from the stylesheet's side only: that the wash thins nothing it does not own,
 * that the opt-in is a class, that the floors are declared once. None of that
 * can see a CALL SITE, and the call sites are where it broke. The Git surfaces
 * drew a comment card as `rounded-md border border-border` with an author bar
 * and no fill of its own — correct-looking for as long as the panel behind it was
 * opaque, and a 1px hairline over the desktop holding a paragraph the moment it
 * was not. The rule was never disputed; nothing enforced it.
 *
 * THE RULE IS DRAWN BY WHAT A SURFACE HOLDS, not by what it is:
 *
 *   - A READING SURFACE NEVER THINS. A comment body, a diff hunk, a CI log, a
 *     file view, the composer — anything read word by word, at 100% at every
 *     slider setting.
 *   - CHROME MAY THIN FREELY. The rail, the panel shell, section headers, tab
 *     strips, gutters, chips, a `kbd`. This is where glass reads as glass.
 *
 * WHICH IS WHY THE THREE GUARDS BELOW HAVE TWO DIFFERENT SCOPES, and the split is
 * the honest part rather than a shortcut. "Holds prose" is not a property of a
 * class string: `rounded-full border px-2.5` is a filter chip in one file and a
 * status pill in another, and a guard that called both a card would have to be
 * satisfied by painting forty chips that are correct as they are. So the first
 * assertion is APP-WIDE, over the one shape that cannot be anything but a card —
 * a bordered box that CLIPS its children is a wrapper around content, always —
 * and the two that need to know what a surface holds run over the surfaces that
 * have been brought under the rule. #691 seeded that list with the Git surfaces;
 * a surface joins it in the commit that makes it pass.
 */
describe("cards must paint", () => {
  /**
   * The unprefixed classes in a class string. A variant is dropped on purpose:
   * `hover:bg-muted` is not a resting fill and `focus-visible:ring-2` is not an
   * edge, and counting either would let a box with no fill at rest pass because
   * it lights up under the pointer.
   */
  function classes(value: string): string[] {
    return value.split(/\s+/).filter((name) => name && !name.includes(":"));
  }

  /** The sides, for telling a box's edge from a divider. */
  const SIDES = new Set(["t", "b", "l", "r", "x", "y", "s", "e"]);

  /**
   * Whether a class string draws an edge a reader can see, all the way round.
   * `border-b` is a divider between rows, `border-transparent` reserves the
   * layout a border would occupy without drawing one, and `border-0`/`-none`
   * remove it.
   */
  function drawsAnEdge(value: string): boolean {
    const names = classes(value);
    if (names.some((name) => name === "border-transparent" || name === "border-0" || name === "border-none")) return false;
    return names.some((name) => {
      if (name === "border") return true;
      if (name === "ring-1" || name === "ring-2") return true;
      if (!name.startsWith("border-") || name.startsWith("border-spacing")) return false;
      return !SIDES.has(name.slice("border-".length).split("-")[0] ?? "");
    });
  }

  /** Whether the box supplies its own background. */
  function paints(value: string): boolean {
    return classes(value).some((name) => name.startsWith("bg-"));
  }

  /** Every quoted string mentioning a radius — how a card is written here. */
  const CARD_SHAPED = /"([^"\n]*\brounded[^"\n]*)"|'([^'\n]*\brounded[^'\n]*)'/g;

  test("a bordered box that clips its children paints", () => {
    /**
     * `overflow-hidden` or `divide-y` on a bordered, rounded box says the box
     * exists to WRAP something: it is clipping children to its own corners, or
     * ruling lines between them. That is a card by construction, whatever it
     * holds — and a card with no fill is borrowing an ancestor's, which is the
     * exact thing translucency takes away.
     *
     * A BOX WHOSE WHOLE CONTENT IS AN IMAGE IS EXEMPT, because an image paints
     * its own pixels: there is no ground to show through and a fill behind it
     * would never be seen. `aspect-*`, `size-full` and `object-*` are how those
     * are written (look-thumb, the studio's scene previews).
     */
    const offenders: string[] = [];
    for (const file of sources(["app", "components", "lib"], /\.tsx?$/)) {
      const source = withoutProse(file);
      for (const hit of source.matchAll(CARD_SHAPED)) {
        const value = hit[1] ?? hit[2] ?? "";
        const names = classes(value);
        const clips = names.some((name) => name === "overflow-hidden" || name.startsWith("divide-y"));
        const holdsAnImage = names.some((name) => name.startsWith("aspect-") || name === "size-full" || name.startsWith("object-"));
        if (!clips || holdsAnImage || paints(value) || !drawsAnEdge(value)) continue;
        offenders.push(`${path.relative(path.join(here, ".."), file)}: ${value}`);
      }
    }
    expect(offenders).toEqual([]);
  });

  /**
   * The surfaces held to the reading-surface half of the rule — #691 brought the
   * Git surfaces in as the first of them. Anything outside this set is unaudited,
   * not exempt; a surface joins in the commit that makes it pass.
   *
   * BY PREFIX RATHER THAN BY FILENAME, and that is the lesson of #692 landing on
   * top of this: that change extracted `EntryCard`, `ForgeFacts` and
   * `MergeFooter` out of one 1000-line surface, and a guard naming three exact
   * files would have gone on passing while the card it was written for moved to a
   * `github-detail-*.tsx` beside it and quietly lost its fill. Every
   * `github-*`/`diff-*` module under components/session is in, whether it existed
   * when this was written or not — which is the whole point of a lint over a
   * review note.
   */
  const READING_SURFACE_PREFIXES = ["github-", "diff-"] as const;

  const readingSurfaces = sources(["components/session"], /\.tsx?$/)
    .filter((file) => READING_SURFACE_PREFIXES.some((prefix) => path.basename(file).startsWith(prefix)))
    .map((file) => ({ file: path.relative(path.join(here, ".."), file), source: withoutProse(file) }));

  test("the reading-surface set is not empty, and holds the surfaces #691 brought in", () => {
    // Every assertion below iterates this set: an empty one would report a clean
    // sweep of nothing. The three named are the ones the issue starts from —
    // whatever #692's restructure renames around them.
    const names = readingSurfaces.map(({ file }) => path.basename(file));
    expect(names).toContain("diff-surface.tsx");
    expect(names).toContain("github-surface.tsx");
    expect(names.some((name) => name.startsWith("github-detail"))).toBe(true);
  });

  test("every <pre> on a reading surface carries a fill, and an opaque one", () => {
    // A `<pre>` is prose or code read line by line — the least arguable reading
    // surface there is. `bg-muted/40` is not a fill: it is 40% of one over
    // whatever is behind, which was the panel's `bg-sidebar` right up until the
    // slider thinned it to --sidebar-wash.
    let found = 0;
    const offenders: string[] = [];
    for (const { file, source } of readingSurfaces) {
      for (const tag of source.matchAll(/<pre\b[^>]*>/g)) {
        found += 1;
        const value = [...tag[0].matchAll(/"([^"]*)"/g)].map(([, quoted]) => quoted).join(" ");
        const fill = classes(value).find((name) => name.startsWith("bg-"));
        if (fill === undefined) offenders.push(`${file}: a <pre> with no fill — ${value.slice(0, 60)}`);
        else if (fill.includes("/")) offenders.push(`${file}: ${fill} is an alpha, not a fill`);
      }
    }
    // A regex that matched nothing would make this vacuous rather than failing.
    expect(found, "the Git surfaces render more than one <pre>").toBeGreaterThan(1);
    expect(offenders).toEqual([]);
  });

  test("a semantic tint on a reading surface goes through the floor, not through an alpha", () => {
    // `bg-success/10` is 10% of the theme's green and 90% of the scene, with no
    // floor under it anywhere — the gap #434 closed for --muted-foreground and
    // left open here. `.tint-success` / `.tint-destructive` mix the same colour
    // INTO the card instead; globals.css carries the argument and the number.
    const alpha = /\bbg-(success|destructive|warning|info|verify)\/\d+\b/g;
    const offenders: string[] = [];
    for (const { file, source } of readingSurfaces) {
      for (const hit of source.matchAll(alpha)) offenders.push(`${file}: ${hit[0]} → tint-${hit[1]}`);
    }
    expect(offenders).toEqual([]);
  });

  test("the tints mix against the card, and the floor is one number", () => {
    // Mixing against `transparent` is the defect itself, written out: it is what
    // `bg-x/NN` compiles to. The second colour has to be a surface.
    //
    // READ OFF THE STYLESHEET rather than from a list of two, so a third tone
    // added next year is held to the same shape in the commit that adds it — the
    // discipline the text-scale guard uses on the named steps. Each block is
    // pulled out and asserted on its own, so a failure prints the one
    // declaration that is wrong instead of the whole file.
    const tints = [...code.matchAll(/\.tint-([a-z]+)\s*\{([^}]*)\}/g)].map(([, tone, body]) => ({ tone, body: body.trim() }));
    // The two #691 introduced; a regex matching nothing would make this vacuous.
    expect(tints.length).toBeGreaterThanOrEqual(2);
    for (const { tone, body } of tints) {
      // The tone has to BE one of the five state colours. `.tint-lavender` would
      // be a sixth ramp by another route — see "the state vocabulary" below.
      expect(["success", "destructive", "warning", "info", "verify"], `.tint-${tone} is not on the state vocabulary`).toContain(tone);
      expect(body, `.tint-${tone} must mix the token into --card at the floor`).toBe(
        `background-color: color-mix(in oklab, var(--${tone}) var(--tint-floor), var(--card));`,
      );
    }
    // One declaration, so a re-tune cannot leave the two tints disagreeing.
    const declarations = [...code.matchAll(/([^\n{]*)\{[^{}]*--tint-floor\s*:/g)].map(([, selector]) => selector.trim());
    expect(declarations).toHaveLength(1);
    expect(rootTokens.has("--tint-floor")).toBe(true);
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
