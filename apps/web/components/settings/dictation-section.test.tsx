/**
 * THE DICTATION PANE (#544) — its own tab, off by default.
 *
 * Three claims, and each of them is one somebody would otherwise find out the
 * hard way:
 *
 *   - THE PANE EXISTS AS A DESTINATION. It is in `SECTIONS` under Runtime and
 *     the page renders it for `active === "dictation"`, so the nav and the body
 *     agree. A section id in one and not the other is a nav button that opens
 *     an empty pane, which is the exact decay `settings-nav.test.ts` exists for
 *     on the route side.
 *   - SEARCH FINDS IT BY THE WORDS SOMEBODY ACTUALLY TYPES. It ships OFF, so
 *     the commonest question is "why is there no mic button" — asked as
 *     "dictation", "microphone", or "voice" — and all three have to land on the
 *     row that turns it on rather than on a key row for a provider nobody has
 *     chosen.
 *   - THE KEY ROW IS NOT THERE WHILE IT IS OFF, because asking for a credential
 *     nothing will spend is asking "which key" before "whose".
 *
 * AND SINCE #560, THE LANGUAGE ROW — Automatic by default, under the provider
 * and absent with it, drawn from the names the engine sends rather than from a
 * table copied into this app.
 */
// @ts-expect-error bun:test has no types in this app's tsconfig
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { searchSettings } from "@/lib/settings-search";
import { SETTINGS_SEARCH_INDEX } from "./settings-registry";

const nav = readFileSync(new URL("./settings-page.tsx", import.meta.url), "utf8");

describe("the Dictation pane is a destination of its own", () => {
  test("it is in the nav, under Runtime rather than inside General", () => {
    expect(nav).toContain('{ id: "dictation", label: "Dictation", icon: MicIcon, group: "Runtime" }');
  });

  test("and the page renders it there rather than stacking it in General", () => {
    expect(nav).toContain('{active === "dictation" && <DictationSection />}');
    // The old home. A pane in the nav whose section still renders inside
    // General would draw it twice.
    expect(nav).not.toContain("<AgentSection />\n          {/* AFTER THE AGENT");
  });
});

describe("search lands on it", () => {
  const first = (query: string) => searchSettings(SETTINGS_SEARCH_INDEX, query)[0];

  test("the questions somebody types when there is no mic button", () => {
    // THE ROW THAT TURNS IT ON, not the key row underneath it: with dictation
    // off the key row is not even rendered, so a result pointing at it would
    // scroll to nothing.
    for (const query of ["dictation", "dictate", "voice"]) {
      expect(first(query)?.pageId).toBe("dictation");
      expect(first(query)?.title).toBe("Provider");
    }
  });

  test("'microphone' finds it too, alongside the browser's own mic permission", () => {
    // NOT ASSERTED AS FIRST, and that is the honest reading: the Browser pane's
    // site-permission row is about a microphone as well, and somebody typing
    // this word could mean either. What must be true is that the dictation
    // switch is on the page at all rather than buried under one match.
    const found = searchSettings(SETTINGS_SEARCH_INDEX, "microphone").slice(0, 3);
    expect(found.some((entry) => entry.pageId === "dictation" && entry.title === "Provider")).toBe(true);
  });

  test("and looking for the vendor still finds its key", () => {
    expect(first("deepgram")?.pageId).toBe("dictation");
  });

  test("nothing in the index still points at General for dictation", () => {
    // The group moved panes; an entry left behind would navigate somebody to a
    // pane the rows are no longer on.
    const strays = SETTINGS_SEARCH_INDEX.entries.filter((entry) => entry.group === "Dictation" && entry.pageId !== "dictation");
    expect(strays).toEqual([]);
  });
});

describe("what the pane shows before anybody has chosen", () => {
  beforeAll(() => {
    GlobalRegistrator.register({ url: "http://localhost/" });
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  });

  afterAll(async () => {
    await act(async () => {
      await new Promise((settle) => setTimeout(settle, 0));
    });
    await GlobalRegistrator.unregister();
  });

  /** One render of the pane against a fixed engine answer. */
  async function pane(dictation: Record<string, unknown>): Promise<{ host: HTMLElement; unmount: () => Promise<void> }> {
    globalThis.fetch = (async () => Response.json({ dictation })) as typeof fetch;
    const { DictationSection } = await import("./dictation-section");
    const host = document.createElement("div");
    document.body.appendChild(host);
    const root = createRoot(host);
    await act(async () => {
      root.render(<DictationSection />);
    });
    // A SECOND `act`, NOT A LONGER FIRST ONE. The hook defers its load a tick
    // (setting state from an effect body is the cascade this app's lint
    // forbids) and then waits on a fetch, so the engine's answer arrives after
    // the render's own act has closed — and the re-render it causes is only
    // flushed by being inside one.
    await act(async () => {
      for (let turn = 0; turn < 5; turn += 1) await new Promise((settle) => setTimeout(settle, 0));
    });
    return {
      host,
      unmount: async () => {
        await act(() => root.unmount());
        host.remove();
      },
    };
  }

  test("the provider row, and no key field under it", async () => {
    // The engine has not answered, which is the same state as `off` — see
    // `useDictationSettings`, where that is deliberate rather than incidental.
    const { host, unmount } = await pane({ provider: "off", configured: false, language: "multi", languages: [] });

    expect(host.textContent).toContain("Provider");
    // No credential is asked for until somebody says whose it would be.
    expect(host.querySelector('input[aria-label="Deepgram key"]')).toBeNull();
    // And the pane says what off actually means, rather than only naming it.
    expect(host.textContent).toContain("No mic button anywhere");
    // NOR A LANGUAGE, for the key row's reason: narrowing what nothing will
    // transcribe is a setting with nowhere to land.
    expect(host.textContent).not.toContain("Language");

    await unmount();
  });

  /* ---------------------------------------------------------------- *
   * WHICH LANGUAGE — issue #560.
   * ---------------------------------------------------------------- */

  test("with a provider chosen, the language row says Automatic and explains what that means", async () => {
    const { host, unmount } = await pane({
      provider: "deepgram",
      configured: true,
      language: "multi",
      languages: [
        { code: "multi", label: "Automatic (any supported language)" },
        { code: "es", label: "Spanish" },
      ],
    });

    expect(host.textContent).toContain("Language");
    expect(host.textContent).toContain("Automatic (any supported language)");
    // THE POINT OF `multi` IN WORDS, not just its name: switching languages
    // inside one sentence is the thing picking `es` would break.
    expect(host.textContent).toContain("inside one sentence");

    await unmount();
  });

  test("a narrowed language shows its own name and says what narrowing costs", async () => {
    const { host, unmount } = await pane({
      provider: "deepgram",
      configured: true,
      language: "es",
      languages: [
        { code: "multi", label: "Automatic (any supported language)" },
        { code: "es", label: "Spanish" },
      ],
    });

    expect(host.textContent).toContain("Spanish");
    // The honest half: more accurate inside that language, wrong outside it.
    expect(host.textContent).toContain("sounded closest to");

    await unmount();
  });
});
