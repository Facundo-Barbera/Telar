/**
 * THE REASONING PILL ALWAYS NAMES A LEVEL — the one the next turn runs at.
 *
 * A pick names itself. With no pick it names the model's default, as the engine
 * read it from the provider, marked as a default rather than a choice. Only a
 * model whose default is unknown reads "Auto", and a model with nothing to set
 * has no pill at all.
 */
// @ts-expect-error bun:test has no types in this app's tsconfig
import { afterAll, afterEach, beforeEach, describe, expect, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import type { ModelCatalogue, ProviderModel } from "@telar/engine-client";
import { ReasoningControl, reasoningPillLabel } from "./composer-controls";
import { forgetModelCatalogues } from "@/lib/model-catalogue-cache";

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

const MODELS = [
  model("opus", { isDefault: true, efforts: ["low", "medium", "high"], defaultEffort: "high" }),
  model("sonnet", { efforts: ["low", "medium", "high"] }),
  model("haiku"),
];

let host: HTMLDivElement;
let root: Root;

beforeEach(() => {
  forgetModelCatalogues();
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    if (url.startsWith("/api/models")) {
      const catalogue: ModelCatalogue = { driver: "claude", instanceId: "claude", models: MODELS, source: "provider", readAt: 0 };
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

async function mount(choice: { model?: string; effort?: string }): Promise<HTMLButtonElement | null> {
  await act(async () => {
    root.render(<ReasoningControl driver="claude" choice={choice} onChange={() => undefined} />);
  });
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
  return host.querySelector<HTMLButtonElement>('button[aria-label^="Reasoning effort:"]');
}

describe("the reasoning pill", () => {
  test("with no pick, it shows the model's default level, quieter than a pick", async () => {
    const pill = await mount({ model: "opus" });
    expect(pill?.textContent).toContain("High");
    expect(pill?.textContent).not.toContain("Reasoning");
    expect(pill?.getAttribute("aria-label")).toBe("Reasoning effort: High (default)");
    expect(pill?.querySelector(".text-muted-foreground")?.textContent).toBe("High");
  });

  test("a pick shows the pick, drawn as one", async () => {
    const pill = await mount({ model: "opus", effort: "low" });
    expect(pill?.textContent).toContain("Low");
    expect(pill?.getAttribute("aria-label")).toBe("Reasoning effort: Low");
    expect(pill?.querySelector(".text-foreground")?.textContent).toBe("Low");
  });

  test("a model whose default is unknown says Auto, never a guessed level", async () => {
    const pill = await mount({ model: "sonnet" });
    expect(pill?.textContent).toContain("Auto");
  });

  test("a model with no levels has no pill", async () => {
    expect(await mount({ model: "haiku" })).toBeNull();
  });
});

describe("the words", () => {
  test("a pick beats the default, and the window rides along", () => {
    expect(reasoningPillLabel("low", "high")).toEqual({ label: "Low", isDefault: false });
    expect(reasoningPillLabel(undefined, "high", "1M")).toEqual({ label: "High · 1M", isDefault: true });
    expect(reasoningPillLabel(undefined, undefined)).toEqual({ label: "Auto", isDefault: true });
    // Ultracode is a pick, and names itself.
    expect(reasoningPillLabel(undefined, "high", undefined, true)).toEqual({ label: "Ultracode", isDefault: false });
  });
});
