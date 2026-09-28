/**
 * THE MODEL-OPTIONS MENU, PER PROVIDER — one popover, a section per thing the
 * chosen model supports, the provider's own default marked "Default".
 *
 * - Claude: reasoning (plus Ultracode and Ultrathink), context window, fast mode.
 * - Codex: reasoning and service tier.
 * - OpenCode: reasoning only.
 */
// @ts-expect-error bun:test has no types in this app's tsconfig
import { afterAll, afterEach, beforeEach, describe, expect, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import type { ModelCatalogue, ProviderDriverKind, ProviderModel } from "@telar/engine-client";
import { hasUltrathink, modelOptionSections, ReasoningControl, toggleUltrathink, type ModelOptionSection } from "./composer-controls";
import { forgetModelCatalogues } from "@/lib/model-catalogue-cache";
import type { ModelChoice } from "@/lib/models";

GlobalRegistrator.register({ url: "http://localhost/" });
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
const realFetch = globalThis.fetch;
afterAll(async () => {
  globalThis.fetch = realFetch;
  await GlobalRegistrator.unregister();
});

function model(id: string, over: Partial<ProviderModel> = {}): ProviderModel {
  return { id, label: id, isDefault: false, hidden: false, efforts: [], fastMode: false, hiddenByUser: false, legacy: false, source: "provider", ...over } as ProviderModel;
}

const LEVELS = ["low", "medium", "high", "xhigh", "max"];
/** Opus in both windows again — the 200k row beside the default 1M one. */
const CLAUDE = [
  model("opus", { label: "Opus", resolves: "claude-opus-5-5", efforts: LEVELS, defaultEffort: "medium", fastMode: true }),
  model("opus[1m]", { label: "Opus", resolves: "claude-opus-5-5[1m]", efforts: LEVELS, defaultEffort: "medium", fastMode: true, defaultWindow: true, isDefault: true }),
  model("haiku", { label: "Haiku" }),
];
const CODEX = [
  model("gpt-6-astra", {
    isDefault: true,
    efforts: ["low", "medium", "high"],
    defaultEffort: "medium",
    serviceTiers: [
      { id: "default", name: "Standard" },
      { id: "priority", name: "Fast", description: "Faster, at a higher rate" },
    ],
    defaultServiceTier: "default",
  }),
];
const OPENCODE = [model("openai/gpt-5.6-luna", { isDefault: true, efforts: ["low", "high"] })];

const ids = (sections: ModelOptionSection[]) => sections.map((section) => section.id);
const rowsOf = (sections: ModelOptionSection[], id: string) => sections.find((section) => section.id === id)?.rows ?? [];

describe("sections per provider", () => {
  test("Claude: reasoning with Ultracode and Ultrathink, context window, fast mode", () => {
    const sections = modelOptionSections("claude", CLAUDE, { model: "opus[1m]" }, { ultrathink: { active: false } });
    expect(ids(sections)).toEqual(["reasoning", "window", "fast"]);
    expect(rowsOf(sections, "reasoning").map((row) => row.label)).toEqual(["Low", "Medium", "High", "Extra high", "Max", "Ultracode", "Ultrathink"]);
    expect(rowsOf(sections, "window").map((row) => row.label)).toEqual(["200k", "1M"]);
    expect(rowsOf(sections, "fast").map((row) => row.label)).toEqual(["On", "Off"]);
  });

  test("Ultrathink needs a draft to edit, so a project default does not offer it", () => {
    expect(rowsOf(modelOptionSections("claude", CLAUDE, { model: "opus[1m]" }), "reasoning").some((row) => row.key === "ultrathink")).toBe(false);
  });

  test("Codex: reasoning and service tier, nothing Claude-only", () => {
    const sections = modelOptionSections("codex", CODEX, {}, { ultrathink: { active: false } });
    expect(ids(sections)).toEqual(["reasoning", "tier"]);
    expect(rowsOf(sections, "reasoning").map((row) => row.label)).toEqual(["Low", "Medium", "High"]);
    expect(rowsOf(sections, "tier").map((row) => row.label)).toEqual(["Standard", "Fast"]);
  });

  test("OpenCode: reasoning levels only", () => {
    expect(ids(modelOptionSections("opencode", OPENCODE, {}))).toEqual(["reasoning"]);
  });

  test("a model with nothing to set has no sections", () => {
    expect(modelOptionSections("claude", CLAUDE, { model: "haiku" })).toEqual([]);
  });
});

describe("defaults are marked, and picking one follows the provider", () => {
  test("the default level, window, fast-mode Off and service tier each carry Default", () => {
    const claude = modelOptionSections("claude", CLAUDE, { model: "opus[1m]" });
    const defaults = (id: string) => rowsOf(claude, id).filter((row) => row.isDefault).map((row) => row.label);
    expect(defaults("reasoning")).toEqual(["Medium"]);
    expect(defaults("window")).toEqual(["1M"]);
    expect(defaults("fast")).toEqual(["Off"]);
    expect(rowsOf(modelOptionSections("codex", CODEX, {}), "tier").filter((row) => row.isDefault).map((row) => row.label)).toEqual(["Standard"]);
  });

  test("with no pick the default rows are the ticked ones", () => {
    const claude = modelOptionSections("claude", CLAUDE, { model: "opus[1m]" });
    expect(rowsOf(claude, "reasoning").filter((row) => row.selected).map((row) => row.label)).toEqual(["Medium"]);
  });

  test("picking the default clears the pick; picking another stores it", () => {
    const reasoning = rowsOf(modelOptionSections("claude", CLAUDE, { model: "opus[1m]", effort: "high" }), "reasoning");
    expect(reasoning.find((row) => row.label === "Medium")!.apply!({ model: "opus[1m]", effort: "high" })).toEqual({ model: "opus[1m]", effort: undefined, ultracode: undefined });
    expect(reasoning.find((row) => row.label === "Max")!.apply!({ model: "opus[1m]" })).toMatchObject({ effort: "max" });
    const tier = rowsOf(modelOptionSections("codex", CODEX, {}), "tier");
    expect(tier.find((row) => row.label === "Fast")!.apply!({})).toEqual({ serviceTier: "priority" });
    expect(tier.find((row) => row.label === "Standard")!.apply!({ serviceTier: "priority" })).toEqual({ serviceTier: undefined });
  });

  test("an unknown default keeps an Auto row", () => {
    const sections = modelOptionSections("opencode", OPENCODE, {});
    expect(rowsOf(sections, "reasoning")[0]).toMatchObject({ label: "Auto", isDefault: true, selected: true });
  });
});

test("200k is selectable again, and picking it picks the standard-window row", () => {
  const window = rowsOf(modelOptionSections("claude", CLAUDE, { model: "opus[1m]", effort: "high" }), "window");
  const standard = window.find((row) => row.label === "200k")!;
  expect(standard.disabled).toBeFalsy();
  expect(standard.apply!({ model: "opus[1m]", effort: "high" })).toMatchObject({ model: "opus", effort: "high" });
});

test("Ultracode replaces the level, and a level replaces Ultracode", () => {
  const reasoning = rowsOf(modelOptionSections("claude", CLAUDE, { model: "opus[1m]", effort: "high" }), "reasoning");
  expect(reasoning.find((row) => row.key === "ultracode")!.apply!({ model: "opus[1m]", effort: "high" })).toEqual({ model: "opus[1m]", effort: undefined, ultracode: true });
  const on = rowsOf(modelOptionSections("claude", CLAUDE, { model: "opus[1m]", ultracode: true }), "reasoning");
  expect(on.filter((row) => row.selected).map((row) => row.label)).toEqual(["Ultracode"]);
  expect(on.find((row) => row.label === "Low")!.apply!({ model: "opus[1m]", ultracode: true })).toEqual({ model: "opus[1m]", effort: "low", ultracode: undefined });
});

test("Ultrathink is the word in the draft, added and removed where it can be seen", () => {
  expect(toggleUltrathink("fix the parser")).toBe("fix the parser ultrathink");
  expect(toggleUltrathink("")).toBe("ultrathink");
  expect(toggleUltrathink("fix the parser ultrathink")).toBe("fix the parser");
  expect(hasUltrathink("please UltraThink about it")).toBe(true);
  expect(hasUltrathink("ultrathinking")).toBe(false);
});

describe("the popover", () => {
  let host: HTMLDivElement;
  let root: Root;
  const CATALOGUES: Record<ProviderDriverKind, ProviderModel[]> = { claude: CLAUDE, codex: CODEX, opencode: OPENCODE };

  beforeEach(() => {
    forgetModelCatalogues();
    globalThis.fetch = (async (input: RequestInfo | URL) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
      if (url.startsWith("/api/models")) {
        const driver = new URL(url, "http://localhost").searchParams.get("driver") as ProviderDriverKind;
        const catalogue: ModelCatalogue = { driver, instanceId: driver, models: CATALOGUES[driver], source: "provider", readAt: 0 };
        return Response.json({ catalogue });
      }
      throw new Error(`unexpected fetch: ${url}`);
    }) as typeof fetch;
    host = document.createElement("div");
    document.body.append(host);
    root = createRoot(host);
  });

  afterEach(() => {
    act(() => root.unmount());
    host.remove();
    // The catalogue cache is module-scoped; a later file must not read this one's rows.
    forgetModelCatalogues();
  });

  async function settle() {
    for (let pass = 0; pass < 3; pass += 1) {
      await act(async () => {
        await new Promise((resolve) => setTimeout(resolve, 0));
      });
    }
  }

  async function open(driver: ProviderDriverKind, choice: ModelChoice, onChange: (next: ModelChoice) => void = () => undefined) {
    await act(async () => {
      root.render(<ReasoningControl driver={driver} choice={choice} onChange={onChange} ultrathink={{ active: false, toggle: () => undefined }} />);
    });
    await settle();
    await act(async () => host.querySelector<HTMLButtonElement>('button[aria-label^="Reasoning effort:"]')!.click());
    await settle();
  }

  const rows = () => [...document.body.querySelectorAll<HTMLButtonElement>("[data-option-row]")];

  test("one popover with a heading per section and Default badges", async () => {
    await open("claude", { model: "opus[1m]" });
    const text = document.body.textContent ?? "";
    for (const heading of ["Reasoning", "Context window", "Fast mode"]) expect(text).toContain(heading);
    expect(text).toContain("Ultracode");
    expect(rows().filter((row) => row.textContent?.includes("Default")).length).toBe(3);
  });

  test("Codex shows its service tier and no fast mode", async () => {
    await open("codex", {});
    expect(document.body.textContent).toContain("Service tier");
    expect(document.body.textContent).not.toContain("Fast mode");
  });

  test("keyboard: focus starts on the selected row and the arrows move between rows", async () => {
    await open("claude", { model: "opus[1m]", effort: "high" });
    expect(document.activeElement?.textContent).toContain("High");
    const target = (document.activeElement as HTMLElement).closest("[role='group'][aria-label='Model options']")!;
    await act(async () => target.dispatchEvent(new window.KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true })));
    expect(document.activeElement?.textContent).toContain("Extra high");
    await act(async () => target.dispatchEvent(new window.KeyboardEvent("keydown", { key: "End", bubbles: true })));
    expect(document.activeElement?.textContent).toContain("Off");
  });

  test("picking a row sends the whole next choice", async () => {
    const picks: ModelChoice[] = [];
    await open("claude", { model: "opus[1m]" }, (next) => picks.push(next));
    await act(async () => rows().find((row) => row.textContent?.startsWith("200k"))!.click());
    expect(picks.at(-1)).toMatchObject({ model: "opus" });
  });
});
