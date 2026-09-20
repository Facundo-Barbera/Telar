/**
 * THE MODEL PICKER'S ROW AND ITS SEARCH SCOPE (#657).
 *
 * Facundo asked for exactly two things after preferring T3 Code's picker to
 * ours — the row's organisation, and the rail collapsing in search mode.
 *
 * ── THE SEARCH FIELD IS DRIVEN HERE (#732) ──────────────────────────────────
 * It could not be when this file was written. The note that stood here said
 * typing into a controlled input was impossible in this app's environment and
 * that the rail's collapse and the empty state's wording were therefore left to
 * a manual eye. That was true of the environment and false of the cause: React
 * freezes `isInputEventSupported` from `canUseDOM` at import, and a test file's
 * static `import` of `react-dom/client` is hoisted above its own
 * `GlobalRegistrator.register()`, so React was routing controlled inputs down
 * an IE polyfill. `scripts/test-dom.mjs` imports react-dom while the preload's
 * DOM is up and the path works; `lib/testing/type-into.ts` is the helper.
 *
 * So the residue #732 recorded is paid off below: a query really is typed, and
 * the rail going away, the scope the query then reads, and the words the empty
 * state chooses are all read off the mounted picker. `searchScope` stays
 * exported and unit-checked — three drivers against two answers is cheaper
 * stated directly than mounted six times — but it is no longer standing in for
 * the wiring.
 *
 * ── IF THIS FILE IS HANGING, READ THIS FIRST ────────────────────────────────
 * The typing tests below depend on that preload import, and they do not fail
 * without it — THEY HANG. A process at 96% of a core, no output, no test name,
 * nothing naming this file or that import. Measured once at about eight
 * minutes before it was killed, on a machine also running the cockpit.
 *
 * So if the suite is spinning and you are bisecting to find out where: check
 * whether `await import("react-dom/client")` is still in
 * `scripts/test-dom.mjs` before you suspect anything here. That is the only
 * condition in which this has been seen, and it is not a state the repo ships
 * in — it happens when somebody removes that line to find out what it was for.
 *
 * The honest limit of this note: the hang was observed once and deliberately
 * not reproduced, because re-running it costs another eight minutes of a
 * pegged core to confirm something already written down. The cause is unknown.
 * What IS known is that it is specific to this file — `lib/testing/
 * type-into.test.tsx` depends on the same import and fails cleanly in under a
 * second — so a hang here is not evidence that the #732 fix is wrong, and not
 * something every test built on it inherits.
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
import { typeInto } from "@/lib/testing/type-into";

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

/** The search field. Portalled with the rest of the popover. */
const search = (): HTMLInputElement => {
  const found = document.body.querySelector<HTMLInputElement>('input[aria-label="Search models by name or connection"]');
  if (!found) throw new Error("no search field");
  return found;
};

/** Type a query and let the catalogue reads it triggers land — the first
 *  keystroke of a cross-provider search is when the other providers are asked
 *  for, and those reads are deferred like every other in this app. */
async function type(text: string): Promise<void> {
  await typeInto(search(), text);
  await settle();
}

/** The empty state's sentence, which is the only place a hidden scope is
 *  stated in words. */
const emptyState = (): string | undefined =>
  [...document.body.querySelectorAll("p")].map((p) => p.textContent?.replace(/\s+/g, " ").trim()).find((text) => text?.startsWith("Nothing matches"));

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
 * THE COLLAPSE, DRIVEN (#657's other half, and #732's residue).
 *
 * Every assertion here needs a real keystroke, which is why none of them
 * existed until #732 was fixed. The rail going away and the scope widening are
 * ONE rule — hiding the rail while its filter stayed applied would leave a
 * filter in force with nothing on screen to show it or change it — so they are
 * checked together, through the field, rather than argued about separately.
 */
describe("a live query replaces the rail", () => {
  test("the rail is gone while a query stands, and back when it is cleared", async () => {
    await open();
    expect(rail()).not.toBeNull();
    await type("opus");
    expect(rail()).toBeNull();
    // `clear` is the control beside the field; the rail is what it restores.
    await press(document.body.querySelector<HTMLButtonElement>('button[aria-label="Clear search"]')!);
    expect(rail()).not.toBeNull();
    expect(search().value).toBe("");
  });

  test("it collapses even where the provider is fixed — one live entry is not a control", async () => {
    await open({ onDriverChange: undefined });
    expect(rail()).not.toBeNull();
    await type("luna");
    expect(rail()).toBeNull();
  });

  test("the query reads every provider while the provider can still change", async () => {
    await open();
    // Only the session's own catalogue was read at rest...
    expect(asked).toEqual(["opencode"]);
    await type("opus");
    // ...and the first keystroke is what asks for the rest of the scope.
    expect([...asked].sort()).toEqual(["claude", "codex", "opencode"]);
    // A match on another harness is reachable, which is the whole point of
    // widening: "Opus 5" is Claude's and this session is on OpenCode.
    expect(rowText()).toEqual(["Opus 5 | Claude"]);
  });

  test("a fixed session's query stays home — no other catalogue is even asked for", async () => {
    await open({ onDriverChange: undefined });
    await type("opus");
    expect(asked).toEqual(["opencode"]);
    expect(rowText()).toEqual([]);
  });
});

/**
 * THE WORDS, which are load-bearing exactly because the rail is gone: on the
 * one screen where the scope is invisible and the list is empty, "nothing
 * matches" and "nothing matches HERE" are different answers and only one of
 * them is true.
 */
describe("the empty state says which scope came up empty", () => {
  test("a cross-provider query that finds nothing says so of every provider", async () => {
    await open();
    await type("zzz");
    expect(emptyState()).toBe("Nothing matches “zzz” on any provider — names, ids and connections are searched.");
  });

  test("a fixed session's names the provider it was bounded to, and why", async () => {
    await open({ onDriverChange: undefined });
    await type("opus");
    // Opus 5 exists — on Claude. Saying only "nothing matches" here would be
    // false, and is the case this sentence exists for.
    expect(emptyState()).toBe("Nothing matches “opus” in OpenCode, the provider this session is fixed to — names, ids and connections are searched.");
  });

  test("it quotes the query as typed, trimmed", async () => {
    await open();
    await type("  zzz  ");
    expect(emptyState()).toBe("Nothing matches “zzz” on any provider — names, ids and connections are searched.");
  });
});

/**
 * THE SAME RULE STATED DIRECTLY: three drivers against two answers, which is
 * cheaper here than six mounts. It is no longer the only cover for the scope —
 * see the driven tests above — but it is the one that says the rule in full.
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
