/**
 * THE SMALL BRAND MARKS, DRAWN AT THE SIZE THEY WERE ASKED FOR — issue #398.
 *
 * The bug this pins is not cosmetic taste, it is a cascade fact: `width` and
 * `height` on an `<svg>` are PRESENTATION ATTRIBUTES, and every button and menu
 * row in this app carries `[&_svg:not([class*='size-'])]:size-4`, which is a
 * class and therefore wins. A `<ProviderIcon size={11} />` in a session row was
 * being drawn at 16px — not only the wrong size, but a 24-unit path landing on
 * edges the device grid has no pixel for. An inline style is the one thing that
 * class cannot override.
 */
// @ts-expect-error bun:test has no types in this app's tsconfig
import { describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";

import { ConnectionIcon, ModelRowIcon } from "./connection-icon";
import { ProviderIcon } from "./provider-icon";

const SIZES = [11, 13, 14, 16, 20];

describe("a provider mark", () => {
  for (const provider of ["claude", "codex", "opencode"] as const) {
    test(`${provider} honours every size it is given, in a style a container cannot override`, () => {
      for (const size of SIZES) {
        const markup = renderToStaticMarkup(<ProviderIcon provider={provider} size={size} />);
        expect(markup).toContain(`width:${size}px`);
        expect(markup).toContain(`height:${size}px`);
        expect(markup).toContain(`width="${size}"`);
      }
    });

    test(`${provider} keeps its curves rather than snapping them to the grid`, () => {
      expect(renderToStaticMarkup(<ProviderIcon provider={provider} size={13} />)).toContain('shape-rendering="geometricPrecision"');
    });
  }

  test("Claude keeps its brand colour; the other two take the surface's", () => {
    expect(renderToStaticMarkup(<ProviderIcon provider="claude" />)).toContain("text-[#d97757]");
    expect(renderToStaticMarkup(<ProviderIcon provider="codex" />)).toContain("text-foreground/80");
  });
});

describe("a connection mark", () => {
  test("a known connection is sized by style and drawn precisely", () => {
    const markup = renderToStaticMarkup(<ConnectionIcon connection="openai" size={13} />);
    expect(markup).toContain("width:13px");
    expect(markup).toContain('shape-rendering="geometricPrecision"');
  });

  test("an unknown one is still a neutral monogram, never a borrowed logo", () => {
    const markup = renderToStaticMarkup(<ConnectionIcon connection="zz-unknown" size={14} />);
    expect(markup).not.toContain("<path");
    expect(markup).toContain("zz");
  });

  test("a model row inherits the same sizing through whichever mark it resolves to", () => {
    const markup = renderToStaticMarkup(<ModelRowIcon driver="claude" modelId="sonnet" size={16} />);
    expect(markup).toContain("width:16px");
  });
});
