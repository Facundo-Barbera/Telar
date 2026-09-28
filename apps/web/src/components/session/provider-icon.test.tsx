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

import { ConnectionIcon, connectionMark, ModelRowIcon, OPENCODE_MARK } from "./connection-icon";
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

/**
 * A PROVIDER'S MARK AND AN ACCOUNT'S MARK ARE DIFFERENT THINGS — issue #655.
 *
 * models.dev's `opencode` entry is OPENCODE ZEN, one account type under the
 * OpenCode provider: a blocky Z, beside `opencode-go`'s blocky G. Telar drew
 * that Z for the provider itself, so every OpenCode row — Bedrock-routed,
 * Copilot-routed — answered "who serves this?" with "Zen". The fix is the
 * distinction; the asset is a consequence of it.
 */
describe("OpenCode's provider mark is not Zen's account mark", () => {
  test("the provider draws OpenCode's own mark, and the Zen connection keeps the Z", () => {
    const zen = connectionMark("opencode")!;
    expect(zen.d).not.toBe(OPENCODE_MARK.d);

    const provider = renderToStaticMarkup(<ProviderIcon provider="opencode" />);
    expect(provider).toContain(OPENCODE_MARK.d);
    expect(provider).not.toContain(zen.d);

    // And Zen, ASKED FOR BY NAME, still gets its own mark — this was never a
    // wrong asset, only a wrongly borrowed one.
    expect(renderToStaticMarkup(<ConnectionIcon connection="opencode" />)).toContain(zen.d);
  });

  test("a Bedrock-routed OpenCode row wears Bedrock's mark, not Zen's and not OpenCode's", () => {
    const markup = renderToStaticMarkup(<ModelRowIcon driver="opencode" modelId="amazon-bedrock/anthropic.claude-fable-5" />);
    expect(markup).toContain(connectionMark("amazon-bedrock")!.d);
    expect(markup).not.toContain(connectionMark("opencode")!.d);
    expect(markup).not.toContain(OPENCODE_MARK.d);
  });

  test("OpenCode Go wears its own G rather than borrowing Zen's Z", () => {
    // `opencode-go` used to be ALIASED to `opencode`. models.dev publishes Go
    // its own mark, and the one it was borrowing was not even the right one.
    const go = connectionMark("opencode-go")!;
    expect(go.d).not.toBe(connectionMark("opencode")!.d);
    expect(renderToStaticMarkup(<ConnectionIcon connection="opencode-go" />)).toContain(go.d);
  });

  test("an unrouted OpenCode id falls back to the provider, which says nothing about an account", () => {
    const markup = renderToStaticMarkup(<ModelRowIcon driver="opencode" modelId="some-manually-added-id" />);
    expect(markup).toContain(OPENCODE_MARK.d);
    expect(markup).not.toContain(connectionMark("opencode")!.d);
  });

  test("the two-tone mark keeps both tones, dimmer block first", () => {
    // Drawn in two fills upstream; flattening it to one shape would be the
    // redrawing this directory's provenance rule forbids.
    expect(OPENCODE_MARK.dim).toBeString();
    const markup = renderToStaticMarkup(<ProviderIcon provider="opencode" size={14} />);
    expect(markup.indexOf(OPENCODE_MARK.dim!)).toBeLessThan(markup.indexOf(OPENCODE_MARK.d));
    expect(markup).toContain('opacity="0.45"');
  });
});
