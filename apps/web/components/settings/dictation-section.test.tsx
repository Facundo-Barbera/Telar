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

  test("the words somebody types after a name came back wrong (#581)", () => {
    // "glossary" and "keyterms" are what the issue and the headset call it;
    // "vocabulary" is what the row is called. None of the three is a word the
    // provider or key rows use, so all three have exactly one place to land.
    for (const query of ["vocabulary", "glossary", "keyterms"]) {
      expect(first(query)?.pageId).toBe("dictation");
      expect(first(query)?.title).toBe("Vocabulary");
    }
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

  /**
   * The sentences behind each row's ⓘ, joined. The tooltip portals out of
   * the row on hover, so `textContent` never sees them; the trigger carries
   * its sentence as `data-info` for exactly this read.
   */
  function infos(host: HTMLElement): string {
    return [...host.querySelectorAll("[data-info]")].map((node) => node.getAttribute("data-info") ?? "").join("\n");
  }

  /** One render of the pane against a fixed engine answer. */
  async function pane(
    dictation: Record<string, unknown>,
  ): Promise<{ host: HTMLElement; settled: (until: () => boolean) => Promise<void>; unmount: () => Promise<void> }> {
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
      /**
       * WAIT FOR WHAT THIS TEST IS ABOUT, rather than for a number of turns.
       *
       * The five turns above are enough on this machine and were not on CI, and
       * a count that has to be right is a count that is wrong on a slower box:
       * the microphone section mounts only once the ENGINE has answered with a
       * provider, so its own asynchronous work — `enumerateDevices` — starts an
       * unknown number of turns into that window. Polling for the state the
       * assertions need is bounded, deterministic, and fails with the real
       * assertion message rather than a timeout when the state genuinely never
       * arrives.
       */
      settled: async (until: () => boolean) => {
        for (let turn = 0; turn < 50 && !until(); turn += 1) {
          await act(async () => {
            await new Promise((settle) => setTimeout(settle, 0));
          });
        }
      },
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
    // And Off explains itself: no hint under it, no ⓘ beside it.
    expect(host.textContent).not.toContain("mic button");
    expect(infos(host)).toBe("");
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
    // The control's own label carries the meaning; Automatic needs no ⓘ.
    expect(infos(host)).not.toContain("Only this language");

    await unmount();
  });

  /* ---------------------------------------------------------------- *
   * THE VOCABULARY BOX — issue #581.
   * ---------------------------------------------------------------- */

  test("the vocabulary box shows the stored terms, one per line", async () => {
    const { host, unmount } = await pane({
      provider: "deepgram",
      configured: true,
      language: "multi",
      languages: [{ code: "multi", label: "Automatic (any supported language)" }],
      vocabulary: ["Kubernetes", "Zarigüeya"],
    });

    const box = host.querySelector('textarea[aria-label="Dictation vocabulary"]') as HTMLTextAreaElement | null;
    expect(box).not.toBeNull();
    expect(box?.value).toBe("Kubernetes\nZarigüeya");
    // AND IT SAYS WHAT IT DOES NOT NEED TO BE TOLD. Somebody who types their
    // own project names in here is doing work the engine already did.
    expect(infos(host)).toContain("sent automatically");

    await unmount();
  });

  test("and it is not there while dictation is off, like every other row under the provider", async () => {
    const { host, unmount } = await pane({ provider: "off", configured: false, language: "multi", languages: [], vocabulary: [] });
    expect(host.querySelector('textarea[aria-label="Dictation vocabulary"]')).toBeNull();
    await unmount();
  });

  /* ---------------------------------------------------------------- *
   * THE COPY CUT, AND THE DEMO THAT PAID FOR IT — issue #643.
   * ---------------------------------------------------------------- */

  test("the 'How it works' paragraph is gone, and the group's caption with it", async () => {
    const { host, unmount } = await pane({
      provider: "deepgram",
      configured: true,
      language: "multi",
      languages: [{ code: "multi", label: "Automatic (any supported language)" }],
    });

    // ~300 CHARACTERS OF MANUAL ON A ROW WITH NOTHING TO CHANGE. The live
    // transcript below shows the half worth knowing, which is what earned the
    // deletion rather than a shortening.
    expect(host.textContent).not.toContain("How it works");
    expect(host.textContent).not.toContain("it is a toggle, not a hold");
    expect(host.textContent).not.toContain("rewritten in place until Deepgram settles them");
    // THE CAPTION SAID WHAT THE PROVIDER ROW'S HINT SAYS, live, of whichever
    // value is chosen — the doubling #357 is about.
    expect(host.textContent).not.toContain("Off by default: this Mac");
    // AND THE HINT THAT TOLD YOU TO USE THE CONTROL IT SAT UNDER.
    expect(host.textContent).not.toContain("Narrow it below");

    await unmount();
  });

  test("what survived is what a control cannot say about itself", async () => {
    const { host, unmount } = await pane({
      provider: "deepgram",
      configured: true,
      language: "multi",
      languages: [{ code: "multi", label: "Automatic (any supported language)" }],
      vocabulary: [],
    });

    // Where the audio goes, which no control on this pane states — behind
    // the ⓘ, not under the row: the label and the control say the rest.
    expect(infos(host)).toContain("does not pass through this Mac");
    // What the key is actually spent on.
    expect(infos(host)).toContain("five-minute token");
    // What the vocabulary box does not need to be told.
    expect(infos(host)).toContain("sent automatically");
    // AND NO HINT UNDER ANY OF THEM: the rows explain themselves.
    expect(host.textContent).not.toContain("Deepgram;");
    expect(host.textContent).not.toContain("five-minute");

    await unmount();
  });

  test("the microphone section is under the provider, like every other row", async () => {
    const { host, unmount } = await pane({ provider: "off", configured: false, language: "multi", languages: [] });
    // A picker for a dictation that does not exist is a setting with nowhere to
    // land, and a demo with no provider has nothing to demonstrate.
    expect(host.textContent).not.toContain("Live transcript");
    expect(host.querySelector('[role="meter"]')).toBeNull();
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
    expect(infos(host)).toContain("wrong for anything else");

    await unmount();
  });

  /* ---------------------------------------------------------------- *
   * PICK, TEST, WATCH — the microphone section, issue #643.
   *
   * WHAT A RENDER CAN CHECK IS THE SHAPE AND THE SENTENCES: which rows exist in
   * which state, that the picker offers the system default and names a device
   * that is no longer connected, and that a page the browser will not grant a
   * microphone to says so INSTEAD of drawing a meter. What it cannot check is
   * that the bar moves or that the words rewrite — those need a person at a
   * microphone, and the PR says so rather than implying a green suite covered it.
   * ---------------------------------------------------------------- */

  /**
   * The facts the section reasons about, all of them `window`'s — and it CLEARS
   * THE STORED CHOICE, which is not incidental. A test that set the key and
   * cleaned up afterwards leaks it to its neighbours the moment one of its own
   * assertions throws, and a picker test that passes because of what ran before
   * it is a picker kept working by luck. Every case states its own starting
   * point; the one that wants a stored choice writes it after this.
   */
  function browser(facts: { secure: boolean; inputs?: MediaDeviceInfo[] }): void {
    window.localStorage.clear();
    Object.defineProperty(window, "isSecureContext", { value: facts.secure, configurable: true });
    Object.defineProperty(globalThis, "MediaRecorder", { value: class {}, configurable: true, writable: true });
    Object.defineProperty(navigator, "mediaDevices", {
      configurable: true,
      writable: true,
      value: {
        getUserMedia: async () => {
          throw Object.assign(new Error("not in this test"), { name: "NotAllowedError" });
        },
        enumerateDevices: async () => facts.inputs ?? [],
        addEventListener: () => undefined,
        removeEventListener: () => undefined,
      },
    });
  }

  const input = (deviceId: string, label: string): MediaDeviceInfo =>
    ({ kind: "audioinput", deviceId, label, groupId: "" }) as MediaDeviceInfo;

  const configured = {
    provider: "deepgram",
    configured: true,
    language: "multi",
    languages: [{ code: "multi", label: "Automatic (any supported language)" }],
  };

  test("three rows: pick, test, watch", async () => {
    browser({ secure: true, inputs: [input("built-in", "MacBook Pro Microphone"), input("airpods", "AirPods Pro")] });
    const { host, settled, unmount } = await pane(configured);
    await settled(() => host.textContent?.includes("Live transcript") === true);

    expect(host.textContent).toContain("Microphone");
    expect(host.querySelector('[aria-label="Dictation microphone"]')).not.toBeNull();
    // THE METER IS ITS OWN ROW because "is it hearing me" has to be answerable
    // without a key and without a provider — the entire diagnostic value.
    expect(host.querySelector('[role="meter"]')).not.toBeNull();
    expect(infos(host)).toContain("nothing is sent anywhere");
    // AND THE DEMO SAYS IT COSTS MONEY BEFORE IT IS PRESSED.
    expect(host.textContent).toContain("Live transcript");
    expect(infos(host)).toContain("paid transcription");

    await unmount();
  });

  test("nothing starts on its own — no meter reading and no transcript box until pressed", async () => {
    browser({ secure: true, inputs: [input("built-in", "MacBook Pro Microphone")] });
    const { host, settled, unmount } = await pane(configured);
    await settled(() => host.querySelector('[role="meter"]') !== null);

    // A pane somebody opened to read must not raise a permission prompt or spend
    // provider credit. Both are a press.
    expect(host.querySelector('[role="meter"]')?.getAttribute("aria-valuenow")).toBe("0");
    expect(host.querySelector('[aria-label="Dictation demo transcript"]')).toBeNull();
    const buttons = [...host.querySelectorAll("button")].map((button) => button.textContent);
    expect(buttons).toContain("Test");
    expect(buttons).toContain("Start");

    await unmount();
  });

  test("the picker offers the system default first, and names the inputs the browser named", async () => {
    browser({ secure: true, inputs: [input("built-in", "MacBook Pro Microphone"), input("airpods", "AirPods Pro")] });
    const { host, settled, unmount } = await pane(configured);
    await settled(() => host.querySelector('[aria-label="Dictation microphone"]')?.textContent?.includes("System default") === true);

    // The trigger reads the LABEL, never the value — #318, which is why this
    // row goes through `Dropdown` rather than a hand-written Select.
    expect(host.querySelector('[aria-label="Dictation microphone"]')?.textContent).toContain("System default");
    expect(infos(host)).toContain("Kept in this browser only");

    await unmount();
  });

  test("a chosen microphone that is not connected is named, not shown as a hash", async () => {
    // AFTER `browser`, WHICH CLEARS THE STORE. The stored choice is this test's
    // own starting point rather than something left behind by another.
    browser({ secure: true, inputs: [input("built-in", "MacBook Pro Microphone")] });
    window.localStorage.setItem("telar:dictation-microphone:v1", JSON.stringify({ deviceId: "airpods-9f3c", label: "AirPods Pro" }));
    const { host, settled, unmount } = await pane(configured);
    await settled(() => host.textContent?.includes("Not connected") === true);

    expect(host.textContent).toContain("Not connected");
    expect(host.textContent).toContain("AirPods Pro is not connected");
    // The choice is KEPT rather than cleared — and the id never reaches the
    // screen.
    expect(host.textContent).toContain("using the system default until it is");
    expect(host.textContent).not.toContain("airpods-9f3c");

    await unmount();
  });

  test("before the first grant the list says why it is short instead of rendering blanks", async () => {
    // `enumerateDevices` reports one entry per input with an empty label until a
    // microphone has been allowed once.
    browser({ secure: true, inputs: [input("a", ""), input("b", "")] });
    const { host, settled, unmount } = await pane(configured);
    await settled(() => host.textContent?.includes("hides input names") === true);

    expect(host.textContent).toContain("Names appear once a microphone has been allowed");
    expect(infos(host)).toContain("Kept in this browser only");
    expect(host.querySelector('[aria-label="Dictation microphone"]')?.textContent).toContain("System default");

    await unmount();
  });

  test("over plain HTTP the section says so instead of drawing a meter that never moves (#639)", async () => {
    browser({ secure: false, inputs: [input("built-in", "MacBook Pro Microphone")] });
    const { host, settled, unmount } = await pane(configured);
    await settled(() => host.textContent?.includes("not a secure context") === true);

    expect(host.textContent).toContain("not a secure context");
    // The way out, which is not a certificate.
    expect(host.textContent).toContain("127.0.0.1");
    // AND NO CONTROLS AT ALL: a picker over inputs that can never open, above a
    // bar that can never move, reads as broken hardware.
    expect(host.querySelector('[role="meter"]')).toBeNull();
    expect(host.querySelector('[aria-label="Dictation microphone"]')).toBeNull();
    expect(host.textContent).not.toContain("Live transcript");

    await unmount();
  });

  /* ---------------------------------------------------------------- *
   * THE NUMBER — #603 and #607's rule, applied to copy.
   * ---------------------------------------------------------------- */

  test("the pane's prose stays under the budget the cut bought", async () => {
    browser({ secure: true, inputs: [input("built-in", "MacBook Pro Microphone")] });
    const { host, settled, unmount } = await pane(configured);
    await settled(() => host.textContent?.includes("Live transcript") === true);

    /**
     * WHAT A READER ACTUALLY SEES, on the pane's fullest ordinary state: a
     * provider chosen, a key saved, Automatic, and the microphone section open.
     *
     * 1,908 characters before this issue, with four fewer rows and no demo.
     * A CEILING RATHER THAN AN EQUALITY, because a test that broke on every
     * reworded sentence would be deleted by the third person who hit it — and
     * because what is being defended is the direction: adding a row must not be
     * an excuse to add a paragraph.
     */
    expect(host.textContent?.length ?? 0).toBeLessThan(2_000);

    await unmount();
  });
});
