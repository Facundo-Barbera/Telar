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
import { describe, expect, test } from "bun:test";
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

describe("only the audited marks are drawn", () => {
  const AUDITED = ["vscode", "cursor", "windsurf", "zed", "sublime", "webstorm", "intellij", "pycharm", "xcode", "iterm"];
  const folder = draw({});

  test("each audited app draws its own mark", () => {
    for (const icon of AUDITED) expect({ icon, own: draw({ icon }) !== folder }).toEqual({ icon, own: true });
  });

  test("Finder and anything unaudited fall back to the folder", () => {
    for (const icon of ["finder", "terminal", "unknown-app"]) expect(draw({ icon })).toBe(folder);
  });
});
