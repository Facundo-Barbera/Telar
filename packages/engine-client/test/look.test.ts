import { expect, test } from "bun:test";
import {
  parseLook,
  parseLookBackdrop,
  parsePublishedAppearance,
  parseThemeHalf,
  TELAR_DARK,
  TELAR_LIGHT,
  THEME_TOKENS,
  type PublishedAppearance,
} from "../src/look";

/** The smallest thing that is still a Look, so each test can say what it is
 *  actually about instead of restating twelve members. */
function look(patch: Record<string, unknown> = {}): Record<string, unknown> {
  return { version: 1, id: "l1", label: "A look", theme: { light: {}, dark: {} }, backdrop: { kind: "none" }, ...patch };
}

test("a half is filled from the Telar base, and unsafe colours never land in it", () => {
  // The contract the whole format rests on: a PARTIAL half paints a complete
  // app, because a half-styled window is worse than an unfashionable one.
  const half = parseThemeHalf({ background: "oklch(0.5 0 0)" }, "light");
  expect(half.background).toBe("oklch(0.5 0 0)");
  expect(half.foreground).toBe(TELAR_LIGHT.foreground);
  expect(Object.keys(half).sort()).toEqual([...THEME_TOKENS].sort());

  // These values are joined with `;` and wrapped in `{}` to become a
  // stylesheet, so a value carrying either could close the block and open a
  // rule. Every escape shape falls back to the base rather than being escaped.
  const hostile = parseThemeHalf(
    { background: "red; } html { display: none", card: "red}", popover: "<script>", muted: "x".repeat(129), border: "" },
    "dark",
  );
  expect(hostile.background).toBe(TELAR_DARK.background);
  expect(hostile.card).toBe(TELAR_DARK.card);
  expect(hostile.popover).toBe(TELAR_DARK.popover);
  expect(hostile.muted).toBe(TELAR_DARK.muted);
  expect(hostile.border).toBe(TELAR_DARK.border);

  // Not a record at all is still a whole half.
  expect(parseThemeHalf(null, "dark")).toEqual(TELAR_DARK);
  expect(parseThemeHalf("telar", "light")).toEqual(TELAR_LIGHT);
});

test("a backdrop that cannot be painted degrades to none, never to a wash over nothing", () => {
  // A `data-backdrop` with no layers behind it is a frosted pane hanging over
  // a bare canvas — worse than no backdrop, so every gate failure is "none".
  expect(parseLookBackdrop({ kind: "gradient", id: "aurora" })).toEqual({ kind: "none" });
  expect(parseLookBackdrop({ kind: "gradient", id: "aurora", resolved: { light: "not a gradient" } })).toEqual({ kind: "none" });
  // A url() in a gradient would make the page fetch something.
  expect(parseLookBackdrop({ kind: "gradient", id: "aurora", resolved: { light: 'linear-gradient(url(http://x/a.png), red)' } })).toEqual({ kind: "none" });
  // An image choice with no pixels is a promise the look cannot keep.
  expect(parseLookBackdrop({ kind: "image", fit: "cover", blur: 0, dim: 0 })).toEqual({ kind: "none" });
  expect(parseLookBackdrop({ kind: "image", fit: "cover", blur: 0, dim: 0, image: "https://example.com/a.png" })).toEqual({ kind: "none" });

  const gradient = parseLookBackdrop({ kind: "gradient", id: "aurora", dim: 900, resolved: { light: "linear-gradient(red, blue)" } });
  expect(gradient).toEqual({
    kind: "gradient",
    id: "aurora",
    dim: 80, // clamped, not refused
    // The dark half falls back to the light one rather than to nothing.
    resolved: { light: "linear-gradient(red, blue)", dark: "linear-gradient(red, blue)" },
  });

  // Absent dim STAYS absent — it must not round-trip into `dim: 0`.
  const noDim = parseLookBackdrop({ kind: "gradient", id: "aurora", resolved: { light: "linear-gradient(red, blue)" } });
  expect("dim" in noDim).toBe(false);

  // A scene's own images are filtered to real data URLs; its layers clamp.
  const scene = parseLookBackdrop({
    kind: "scene",
    // The semicolon in `image/webp;base64` is written as the CSS escape the
    // composer emits — isSceneValue refuses a literal one, because a `;` is
    // how a value gets out of its declaration.
    resolved: { light: 'url("data:image/webp\\00003Bbase64,AA")' },
    scene: { layers: [{ id: "l1", x: -50, y: 900, scale: 3, opacity: 50, tiled: true }] },
    images: { l1: "data:image/webp;base64,AA", evil: "javascript:alert(1)" },
  });
  expect(scene).toMatchObject({
    kind: "scene",
    scene: { layers: [{ type: "image", id: "l1", x: 0, y: 100, scale: 10, opacity: 50, tiled: true }] },
    images: { l1: "data:image/webp;base64,AA" },
  });
});

test("a look reads what it can and defaults the rest, and needs only an id and a label", () => {
  expect(parseLook(look({ id: "" }))).toBeUndefined();
  expect(parseLook(look({ label: 7 }))).toBeUndefined();
  expect(parseLook(null)).toBeUndefined();
  expect(parseLook([look()])).toBeUndefined();

  // Every scalar out of range or off the list falls back rather than refusing:
  // a stale value from another build should move a slider, not lose a look.
  expect(parseLook(look({ accent: "chartreuse", fontSans: "comic", fontSize: 900, translucencyLevel: -5 }))).toMatchObject({
    accent: "indigo",
    fontSans: "geist",
    fontMono: "geist",
    fontSize: 18,
    translucencyLevel: 0,
    fontSansCustom: "",
  });

  // A FUTURE version is still read on a best effort — every member already
  // falls back on its own, so refusing outright would lose a readable look.
  expect(parseLook(look({ version: 99, accent: "sea" }))).toMatchObject({ version: 1, accent: "sea" });
});

test("a published appearance is total, gated, and fatal only in its look", () => {
  const blob: PublishedAppearance = {
    version: 2,
    updatedAtHint: 42,
    scheme: "light",
    translucent: true,
    frost: "clear",
    resolved: {
      accent: { name: "sea", light: { primary: "oklch(0.5 0 0)", primaryForeground: "oklch(1 0 0)" }, dark: { primary: "oklch(0.7 0 0)", primaryForeground: "oklch(0.2 0 0)" } },
      fontStacks: { sans: '"Geist", sans-serif', mono: '"Geist Mono", monospace' },
    },
    look: parseLook(look())!,
  };
  expect(parsePublishedAppearance(blob)).toEqual(blob);

  // No readable look is the one fatal case: there is nothing here to wear.
  expect(parsePublishedAppearance({ ...blob, look: { id: "" } })).toBeUndefined();
  expect(parsePublishedAppearance("telar")).toBeUndefined();

  // The window facts default rather than refuse.
  expect(parsePublishedAppearance({ look: look() })).toMatchObject({ scheme: "system", translucent: false, frost: "blur", updatedAtHint: 0 });

  // `resolved` is ALL OR NOTHING: a foreground that never matched its
  // background would let a client paint an unreadable button.
  const halfResolved = parsePublishedAppearance({ ...blob, resolved: { ...blob.resolved, accent: { name: "sea", light: blob.resolved!.accent.light } } });
  expect(halfResolved?.resolved).toBeUndefined();
  expect(halfResolved?.look.label).toBe("A look");

  // …and the same declaration-escape gate applies to it, because this blob
  // crossed a trust boundary: any paired device can PUT one.
  const hostile = parsePublishedAppearance({
    ...blob,
    resolved: { ...blob.resolved, fontStacks: { sans: "Geist; } html { display: none", mono: "monospace" } },
  });
  expect(hostile?.resolved).toBeUndefined();
});
