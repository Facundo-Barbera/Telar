/**
 * THE MARK AN OPENER ROW WEARS — issue #398.
 *
 * Two claims, and neither of them is about how pretty the result is. The first
 * is precedence: when macOS gave us the app's own icon, that is what is drawn,
 * and the vendored silhouette is never reached for. The second is provenance —
 * this file used to carry a Finder face drawn by hand, which is a drawing OF a
 * logo rather than the logo, and the guard at the bottom is what stops another
 * one arriving unaudited.
 *
 * RENDERED RATHER THAN REASONED ABOUT. Which element comes out, and what it is
 * sized in, is exactly the kind of thing that reads correct in the source and
 * is wrong in the markup — a container's `[&_svg]:size-4` silently rescaling a
 * 14px mark to 16 is the original bug in this issue.
 */
// @ts-expect-error bun:test has no types in this app's tsconfig
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { renderToStaticMarkup } from "react-dom/server";

import { OpenerIcon } from "./opener-icon";

const PNG = "data:image/png;base64,iVBORw==";
const draw = (props: Parameters<typeof OpenerIcon>[0]) => renderToStaticMarkup(<OpenerIcon {...props} />);

describe("the app's own icon comes first", () => {
  test("a bitmap is drawn as an image, and no vector is drawn at all", () => {
    const markup = draw({ iconDataUrl: PNG });
    expect(markup).toContain(`src="${PNG}"`);
    expect(markup).not.toContain("<svg");
  });

  test("the bitmap WINS over the vendored mark for the same app", () => {
    const markup = draw({ icon: "xcode", iconDataUrl: PNG });
    expect(markup).toContain("<img");
    expect(markup).not.toContain("<path");
  });

  test("it is decorative: the row beside it carries the name", () => {
    const markup = draw({ iconDataUrl: PNG });
    expect(markup).toContain('alt=""');
    expect(markup).toContain("aria-hidden");
  });

  test("a 1px-inset rounded mask, so a squircle and a full-bleed icon share one silhouette", () => {
    expect(draw({ iconDataUrl: PNG })).toContain("clip-path:inset(1px round 3px)");
    expect(draw({ iconDataUrl: PNG, size: 20 })).toContain("clip-path:inset(1px round 4px)");
  });

  test("the browser's own smooth downscale is asked for by name", () => {
    // These are 32px PNGs shown at 14–20px. `pixelated` — which a global
    // `image-rendering` rule could otherwise impose — would staircase every
    // diagonal in a Dock icon.
    expect(draw({ iconDataUrl: PNG })).toContain("image-rendering:auto");
  });
});

describe("sizing is the icon's own, in whole pixels", () => {
  test("every size lands as an attribute AND an inline style, at 14/16/20", () => {
    for (const size of [14, 16, 20]) {
      for (const props of [{ iconDataUrl: PNG, size }, { icon: "zed", size }]) {
        const markup = draw(props);
        expect(markup).toContain(`width="${size}"`);
        expect(markup).toContain(`height="${size}"`);
        // The inline style is what beats a container's `[&_svg]:size-4`, which
        // is how a 14px mark used to end up scaled onto half-pixel edges.
        expect(markup).toContain(`width:${size}px`);
        expect(markup).toContain(`height:${size}px`);
      }
    }
  });

  test("14px is what a row gets without asking", () => {
    expect(draw({ icon: "zed" })).toContain('width="14"');
  });
});

describe("the vector fallback, for a browser tab and a remote Mac", () => {
  test("a known id draws its mark, told to keep the curve rather than snap it", () => {
    const markup = draw({ icon: "xcode" });
    expect(markup).toContain("<path");
    expect(markup).toContain('shape-rendering="geometricPrecision"');
  });

  test("an app we carry no mark for draws the neutral glyph, never a neighbour's logo", () => {
    const neutral = draw({ icon: undefined });
    expect(draw({ icon: "nova" })).toBe(neutral);
    expect(draw({ icon: "ghostty" })).toBe(neutral);
    expect(neutral).not.toContain("M23.15 2.587"); // vscode's mark, the first in the table
  });

  test("`reveal` no longer names a mark: the hand-drawn Finder face is gone", () => {
    expect(draw({ icon: "reveal" })).toBe(draw({ icon: undefined }));
  });
});

/**
 * THE PROVENANCE GUARD. Every mark in this file is either the owner's own
 * published artwork or a CC0 simple-icons entry, verified byte-for-byte
 * against upstream; the one that was neither — a Finder face drawn from
 * memory — is deleted. A new key arriving here without a source comment above
 * it is how that comes back, so the ids are pinned.
 */
describe("every mark has a published source behind it", () => {
  const source = readFileSync(new URL("./opener-icon.tsx", import.meta.url), "utf8");
  const keys = [...source.matchAll(/^ {2}(\w+):\s*$|^ {2}(\w+): "/gm)].map((match) => match[1] ?? match[2]);

  test("the table is exactly the audited set — no Finder, no unsourced additions", () => {
    expect(keys).toEqual(["vscode", "cursor", "windsurf", "zed", "sublime", "webstorm", "intellij", "pycharm", "xcode", "iterm"]);
  });

  test("each one names the upstream slug and version it was taken at", () => {
    for (const key of keys) {
      // The contiguous comment block above the key — one line for most, several
      // where the entry needed defending. The `slug@major` lives somewhere in
      // it; a mark with nothing to cite has no such line and fails here.
      const lines = source.slice(0, source.indexOf(`\n  ${key}:`)).split("\n");
      const block: string[] = [];
      while (lines.length > 0 && lines[lines.length - 1]!.trim().startsWith("//")) block.unshift(lines.pop()!);
      expect(block.join("\n")).toMatch(/\/\/ [a-z0-9]+@\d+/);
    }
  });
});
