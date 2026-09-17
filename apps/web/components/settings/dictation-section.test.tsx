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

  test("the provider row, and no key field under it", async () => {
    // The engine has not answered, which is the same state as `off` — see
    // `useDictationSettings`, where that is deliberate rather than incidental.
    globalThis.fetch = (async () => Response.json({ dictation: { provider: "off", configured: false } })) as typeof fetch;
    const { DictationSection } = await import("./dictation-section");
    const host = document.createElement("div");
    document.body.appendChild(host);
    const root = createRoot(host);
    await act(async () => {
      root.render(<DictationSection />);
      await new Promise((settle) => setTimeout(settle, 0));
    });

    expect(host.textContent).toContain("Provider");
    // No credential is asked for until somebody says whose it would be.
    expect(host.querySelector('input[aria-label="Deepgram key"]')).toBeNull();
    // And the pane says what off actually means, rather than only naming it.
    expect(host.textContent).toContain("No mic button anywhere");

    await act(() => root.unmount());
    host.remove();
  });
});
