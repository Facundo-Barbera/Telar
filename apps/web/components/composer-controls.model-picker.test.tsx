/**
 * THE MODEL PICKER'S ROW AND ITS SEARCH SCOPE (#657).
 *
 * Facundo asked for exactly two things after preferring T3 Code's picker to
 * ours — the row's organisation, and the rail collapsing in search mode.
 *
 * ── WHAT THIS FILE CAN AND CANNOT REACH ─────────────────────────────────────
 * THE SEARCH FIELD CANNOT BE TYPED INTO HERE, and that is a property of the
 * environment rather than of the picker. React 19 raises `onChange` for a
 * controlled text input through its own change plugin, and under Happy DOM that
 * plugin never fires: `onInput` on the same node fires, the value tracker shows
 * a genuine mismatch (`""` against the written value), and `onChange` still
 * does not run — for a plain `Event`, an `InputEvent`, a `change` event, a
 * direct assignment, and a prototype-setter write alike. No other test in this
 * app types into a controlled input either.
 *
 * So the SCOPE RULE — which catalogues a live query reads, the half of the
 * collapse that is a decision rather than a layout — is exported as
 * `searchScope` and checked directly below. What is left uncovered is the line
 * that hides the rail (`{!searching && …}`) and the empty state's wording; both
 * are named in the PR as needing an eye rather than quietly assumed.
 *
 * ── THE REAL COMPONENT AGAINST A STUBBED `fetch` ────────────────────────────
 * `mock.module` would replace `lib/model-catalogue-cache` for the whole run,
 * and the composer, the settings Models tab and the `/` menu all reach through
 * it — the same argument is written out in settings/agent-section.test.tsx.
 * Stubbing the two routes costs a few lines more and exercises the real hooks,
 * the real caching and the real family/generation/connection libs.
 */
// @ts-expect-error bun:test has no types in this app's tsconfig
import { afterAll, afterEach, beforeEach, describe, expect, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import type { ModelCatalogue, ProviderDriverKind, ProviderModel } from "@telar/engine-client";
import { AgentControl, searchScope } from "./composer-controls";
import { forgetModelCatalogues } from "@/lib/model-catalogue-cache";

/** Registered here and released in `afterAll` — Happy DOM throws on a second
 *  `register`, so a file that takes a DOM and never gives it back fails
 *  whichever file runs next. */
GlobalRegistrator.register({ url: "http://localhost/" });
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
const realFetch = globalThis.fetch;
afterAll(async () => {
  globalThis.fetch = realFetch;
  await GlobalRegistrator.unregister();
});

function model(id: string, label: string, over: Partial<ProviderModel> = {}): ProviderModel {
  return { id, label, isDefault: false, hidden: false, efforts: [], fastMode: false, hiddenByUser: false, source: "provider", ...over } as ProviderModel;
}

/**
 * ONE NAME ON TWO OPENCODE CONNECTIONS, which is the case the second line
 * exists for: `openai/gpt-5.6-luna` and `opencode-go/gpt-5.6-luna` are two
 * routes to one model, billed and rate-limited differently, and both rows read
 * "GPT-5.6 Luna" on their first line.
 *
 * Nothing is marked `isDefault`, so `splitGenerations` files everything as
 * current and no Legacy fold stands between these tests and the rows.
 */
const CATALOGUES: Record<ProviderDriverKind, ProviderModel[]> = {
  claude: [model("claude-opus-5", "Opus 5"), model("claude-haiku-4-5", "Haiku 4.5")],
  codex: [model("gpt-6-astra", "GPT-6 Astra")],
  opencode: [model("opencode-go/gpt-5.6-luna", "gpt-5.6-luna"), model("openai/gpt-5.6-luna", "gpt-5.6-luna")],
};

/** Which drivers the engine was asked for, so "it did not ask" is testable
 *  rather than inferred from an empty list. */
let asked: ProviderDriverKind[] = [];

let host: HTMLDivElement;
let root: Root;

beforeEach(() => {
  asked = [];
  // The catalogue cache is module-scoped and page-lived by design, so without
  // this the first test's answers would serve every later one.
  forgetModelCatalogues();
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    if (url.startsWith("/api/models")) {
      const driver = new URL(url, "http://localhost").searchParams.get("driver") as ProviderDriverKind;
      asked.push(driver);
      const catalogue: ModelCatalogue = { driver, models: CATALOGUES[driver], source: "provider", readAt: 0 };
      return Response.json({ catalogue });
    }
    if (url.includes("/models")) return Response.json({ overlay: { instanceId: "x", favorites: [], hidden: [], order: [], custom: [] } });
    throw new Error(`unexpected fetch: ${url}`);
  }) as typeof fetch;
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
});

/**
 * UNMOUNTED, NEVER SWEPT. Clearing `document.body` between tests is the habit
 * elsewhere in this app and it cannot be used here: the popover renders into a
 * PORTAL container of its own under `body`, so wiping the body removes nodes
 * React still believes it owns and the next unmount dies in `removeChild`.
 * Letting React take its own tree down leaves nothing to sweep, and it is also
 * what stops a catalogue read landing after its test finished.
 */
afterEach(() => {
  act(() => {
    root.unmount();
  });
  host.remove();
});

/** Mount, then let the deferred catalogue read land — `useModelCatalogues`
 *  defers its first fetch to a timeout, like every other read in this app. */
async function mount(node: React.ReactElement): Promise<void> {
  await act(async () => {
    root.render(node);
  });
  await settle();
}

async function settle(): Promise<void> {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
}

/** Base UI opens on pointerdown, not on a bare click. */
async function press(element: HTMLElement): Promise<void> {
  await act(async () => {
    element.dispatchEvent(new window.PointerEvent("pointerdown", { bubbles: true }));
    element.dispatchEvent(new window.MouseEvent("mousedown", { bubbles: true }));
    element.click();
  });
  await settle();
}

const trigger = (): HTMLButtonElement => {
  const found = host.querySelector<HTMLButtonElement>('button[aria-label^="Model:"]');
  if (!found) throw new Error("no model pill");
  return found;
};

/** The popover is portalled, so everything below reads `document.body`. */
const rows = (): HTMLButtonElement[] => [...document.body.querySelectorAll<HTMLButtonElement>("[data-model-row]")];

/** The rail, identified by an entry only it has. */
const rail = (): HTMLElement | null => document.body.querySelector('button[aria-label="Favourites"]');

/** Each row as the reader sees it: first line, then second. The two lines are
 *  the only direct children of the row's text column. */
const rowText = (): string[] =>
  rows().map((row) =>
    [...row.querySelectorAll(":scope > span:first-child > span")].map((line) => line.textContent?.trim()).filter(Boolean).join(" | "),
  );

async function open(props: Partial<React.ComponentProps<typeof AgentControl>> = {}): Promise<void> {
  await mount(<AgentControl driver="opencode" choice={{}} onChange={() => undefined} onDriverChange={() => undefined} {...props} />);
  await press(trigger());
}

describe("the row says who serves the model", () => {
  test("a second line carries the harness and the connection, under the name", async () => {
    await open();
    // Two rows share "GPT-5.6 Luna" and are told apart by the line beneath it,
    // which is the whole reason that line exists.
    expect(rowText().sort()).toEqual(["GPT-5.6 Luna | OpenCode · OpenAI", "GPT-5.6 Luna | OpenCode · OpenCode Go"]);
  });

  test("an unrouted model names its harness alone, with no dangling separator", async () => {
    await open({ driver: "claude" });
    expect(rowText()).toEqual(["Opus 5 | Claude", "Haiku 4.5 | Claude"]);
  });

  test("the mark rides on the second line rather than in a gutter of its own", async () => {
    await open();
    const second = rows()[0]?.querySelectorAll(":scope > span:first-child > span")[1];
    expect(second?.querySelector("svg")).not.toBeNull();
    // ...and the first line is text only, so the name has the full width.
    expect(rows()[0]?.querySelectorAll(":scope > span:first-child > span")[0]?.querySelector("svg")).toBeNull();
  });
});

describe("the rail is there until a query replaces it", () => {
  test("it is drawn at rest, with an entry per provider and one for favourites", async () => {
    await open();
    expect(rail()).not.toBeNull();
    for (const label of ["Claude", "Codex", "OpenCode"]) {
      expect(document.body.querySelector(`button[aria-label="${label}"]`)).not.toBeNull();
    }
  });

  test("the field names the scope a query will have, not the view it is leaving", async () => {
    await open();
    expect(document.body.querySelector("input")?.getAttribute("placeholder")).toBe("Search every provider…");
  });

  test("a fixed session's field says which catalogue it is limited to", async () => {
    await open({ onDriverChange: undefined });
    expect(document.body.querySelector("input")?.getAttribute("placeholder")).toBe("Search OpenCode models…");
    // And it asked for that one catalogue only — the other two are models this
    // session could not run, and each would cost a subprocess to list.
    expect(asked).toEqual(["opencode"]);
  });
});

/**
 * THE DECISION BEHIND THE COLLAPSE, checked where it can be: hiding the rail
 * while its scope stayed applied would leave a filter in force with nothing on
 * screen to show it or change it, so the collapse and the widening are one
 * rule, bounded by whether the provider is still yours to choose.
 */
describe("which catalogues a live query reads", () => {
  test("every harness while the provider can still change, the session's own first", () => {
    expect(searchScope("opencode", true)).toEqual(["opencode", "claude", "codex"]);
    expect(searchScope("claude", true)).toEqual(["claude", "codex", "opencode"]);
  });

  test("only its own once the session has fixed the provider", () => {
    expect(searchScope("opencode", false)).toEqual(["opencode"]);
    expect(searchScope("claude", false)).toEqual(["claude"]);
  });

  test("no provider is listed twice, whichever one you are on", () => {
    for (const driver of ["claude", "codex", "opencode"] as ProviderDriverKind[]) {
      const scope = searchScope(driver, true);
      expect(new Set(scope).size).toBe(scope.length);
      expect(scope).toHaveLength(3);
    }
  });
});
