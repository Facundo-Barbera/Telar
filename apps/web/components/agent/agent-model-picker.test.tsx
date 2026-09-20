/**
 * THE AGENT'S MODEL PICKER (#551).
 *
 * The complaint was "it's really hard to find them", plus a suspicion that Go
 * was withholding models. Both answers live in this list, so this is what must
 * not drift:
 *
 *   - rows GROUP into families and keep the engine's order, which is newest
 *     generation first — the browser does not get a second opinion about it;
 *   - SEARCH matches the display name AND the raw wire id, because a person who
 *     knows "k2.7" and a person who knows "Kimi" are both looking for the same
 *     row;
 *   - a row THE ENGINE MARKS UNSUPPORTED is SHOWN AND UNPICKABLE, never hidden
 *     — hiding it would make the withholding suspicion true, and offering it
 *     would sell somebody a 400 halfway through a turn. Since #571 the engine
 *     runs all three of Go's endpoints and marks nothing unsupported, so these
 *     rows are built with `supported: false` DIRECTLY rather than by naming a
 *     route: the behaviour under test is "what the picker does when the engine
 *     says no", and tying it to whichever routes happen to be unreachable today
 *     is what made this file need editing when that changed;
 *   - a Go id models.dev has never described still lists, named by its own id;
 *   - "Default" is a row that says which model it actually means.
 *
 * A REAL DOM for the interaction half: "not selectable" is a claim about what a
 * click does, and a string of markup cannot answer it.
 */
// @ts-expect-error bun:test has no types in this app's tsconfig
import { afterAll, beforeEach, describe, expect, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { renderToStaticMarkup } from "react-dom/server";
import type { AgentModel, AgentModelCatalogue } from "@telar/engine-client";
import {
  AgentModelList,
  AgentModelRows,
  AGENT_ROUTE_UNSUPPORTED,
  agentModelTrouble,
  agentRouteObstacle,
  groupAgentFamilies,
  matchesAgentQuery,
  ROUTE_LABEL,
} from "./agent-model-picker";
import { typeInto } from "@/lib/testing/type-into";

/**
 * REGISTERED HERE AND RELEASED IN `afterAll` — the pairing every DOM test in
 * this app keeps, and one this file cannot skip: Happy DOM THROWS on a second
 * `register` rather than no-oping, so a file that takes a DOM and never gives
 * it back fails whichever file happens to run next (`settings/agent-section`,
 * as it turned out). The suite's preload hands its own DOM back for the same
 * reason — see scripts/test-dom.mjs.
 */
GlobalRegistrator.register({ url: "http://localhost/" });
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
afterAll(async () => {
  await GlobalRegistrator.unregister();
});

function row(over: Partial<AgentModel> & Pick<AgentModel, "id" | "name" | "family" | "route">): AgentModel {
  return {
    // THE ENGINE'S DEFAULT, WHICH IS NOW "yes" FOR EVERY ROUTE (#571). A row
    // that is unsupported says so explicitly at its call site, where the test
    // asking about it can be read without knowing the route table.
    supported: true,
    described: true,
    label: over.name,
    isDefault: false,
    hidden: false,
    efforts: [],
    fastMode: false,
    hiddenByUser: false,
    source: "provider",
    ...over,
  } as unknown as AgentModel;
}

/** The engine's own order — families by newest member, rows by release date. */
const MODELS: AgentModel[] = [
  row({ id: "kimi-k3", name: "Kimi K3", family: "Kimi", route: "chat", isDefault: true, context: 1_048_576, releaseDate: "2026-07-16" }),
  row({ id: "kimi-k2.7-code", name: "Kimi K2.7 Code", family: "Kimi", route: "chat", context: 262_144, releaseDate: "2026-06-12" }),
  row({ id: "glm-5.3", name: "GLM-5.3", family: "GLM", route: "chat", context: 1_000_000, releaseDate: "2026-08-14" }),
  row({ id: "qwen3.8-max", name: "Qwen3.8 Max", family: "Qwen", route: "messages", context: 1_000_000, releaseDate: "2026-08-03" }),
  row({ id: "grok-4.6", name: "Grok 4.6", family: "Grok", route: "responses", context: 500_000, releaseDate: "2026-08-12" }),
  row({ id: "deepseek-flash", name: "deepseek-flash", family: "DeepSeek", route: "chat", described: false }),
];

const catalogue: AgentModelCatalogue = { models: MODELS, source: { go: 1_000, modelsDev: 1_000 } };

let host: HTMLDivElement;
let root: Root;

beforeEach(() => {
  document.body.innerHTML = "";
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
});

function mount(node: React.ReactElement): void {
  act(() => {
    root.render(node);
  });
}

function rowsIn(): HTMLButtonElement[] {
  return [...host.querySelectorAll<HTMLButtonElement>("[data-agent-model-row]")];
}

/**
 * The search RULES are driven through `AgentModelRows`' `query` prop: one mount
 * per query, no field in the way, and the rows are really rendered against the
 * real filter. That is the cheap way to say what a query matches, and it stays.
 *
 * It used to carry an apology — that typing into the field was impossible here
 * because React's change plugin never fired under happy-dom, leaving the
 * field's own `setQuery` "taken on faith, and it is one line". That was #732;
 * the cause was import order in the test preload, not the DOM, and it is fixed.
 * The one line is no longer on faith — `the field feeds the list` below types
 * into the real shell.
 */
function search(query: string, over: AgentModelCatalogue = catalogue): void {
  mount(<AgentModelRows catalogue={over} query={query} onPick={() => undefined} />);
}

describe("grouping", () => {
  test("folds consecutive rows into families and keeps the engine's order", () => {
    expect(groupAgentFamilies(MODELS).map((group) => [group.family, group.models.map((model) => model.id)])).toEqual([
      ["Kimi", ["kimi-k3", "kimi-k2.7-code"]],
      ["GLM", ["glm-5.3"]],
      ["Qwen", ["qwen3.8-max"]],
      ["Grok", ["grok-4.6"]],
      ["DeepSeek", ["deepseek-flash"]],
    ]);
  });

  test("draws a heading per family", () => {
    const markup = renderToStaticMarkup(<AgentModelList catalogue={catalogue} onPick={() => undefined} />);
    for (const family of ["Kimi", "GLM", "Qwen", "Grok", "DeepSeek"]) expect(markup).toContain(family);
  });
});

describe("what a row says", () => {
  test("names the model and what it can hold", () => {
    mount(<AgentModelList catalogue={catalogue} onPick={() => undefined} />);
    const kimi = rowsIn().find((button) => button.dataset.modelId === "kimi-k3")!;
    expect(kimi.textContent).toContain("Kimi K3");
    expect(kimi.textContent).toContain("1.0M");
    // The wire id is on the title, for the reader who needs it — two rows can
    // read alike, their ids never do.
    expect(kimi.title).toBe("kimi-k3");
  });

  test("badges the route in Go's own words, and says nothing about an untranscribed one", () => {
    mount(<AgentModelList catalogue={catalogue} onPick={() => undefined} />);
    expect(rowsIn().find((button) => button.dataset.modelId === "qwen3.8-max")!.textContent).toContain(ROUTE_LABEL.messages!);
    expect(rowsIn().find((button) => button.dataset.modelId === "grok-4.6")!.textContent).toContain(ROUTE_LABEL.responses!);
    expect(ROUTE_LABEL.unknown).toBeUndefined();
  });

  /** GO IS NOT WITHHOLDING MODELS — models.dev simply has not described this
   *  one. It lists, under its own id, and it is pickable. */
  test("an undescribed Go id still lists and is still pickable", () => {
    mount(<AgentModelList catalogue={catalogue} onPick={() => undefined} />);
    const only = rowsIn().find((button) => button.dataset.modelId === "deepseek-flash")!;
    expect(only.textContent).toContain("deepseek-flash");
    expect(only.disabled).toBe(false);
  });
});

/**
 * THE SAME CATALOGUE WITH NAMED ROWS MARKED UNRUNNABLE — the engine's `no`, made
 * explicit. Every test below is about what the picker DOES with that answer,
 * which is a question worth asking in a build where the engine says it about
 * nothing.
 */
function onlyUnsupported(...ids: string[]): AgentModelCatalogue {
  return { ...catalogue, models: catalogue.models.map((model) => (ids.includes(model.id) ? { ...model, supported: false } : model)) };
}

describe("a row the engine will not run", () => {
  test("are shown, greyed, and refuse a click", () => {
    const picked: string[] = [];
    mount(<AgentModelList catalogue={onlyUnsupported("qwen3.8-max", "grok-4.6")} onPick={(id) => picked.push(id)} />);
    for (const id of ["qwen3.8-max", "grok-4.6"]) {
      const button = rowsIn().find((entry) => entry.dataset.modelId === id)!;
      // SHOWN — hiding them would make the "Go is withholding models"
      // suspicion true, and this picker exists to answer it.
      expect(button).toBeDefined();
      expect(button.disabled).toBe(true);
      expect(button.dataset.unsupported).toBe("");
      expect(button.className).toContain("opacity-45");
      act(() => button.click());
    }
    expect(picked).toEqual([]);
  });

  test("say why, even on a route with no wording of its own", () => {
    // NO ROUTE HAS ITS OWN SENTENCE TODAY — the Agent speaks all three, so
    // there is nothing route-specific left to explain.
    for (const route of ["chat", "messages", "responses", "unknown"] as const) {
      expect(agentRouteObstacle(route)).toBeUndefined();
    }
    // WHICH MUST NOT BECOME SILENCE. `supported: false` is the engine's answer
    // and the row has to say something; the fallback is what it says. A greyed
    // row with an empty tooltip is the failure this pins.
    const withOne = onlyUnsupported("qwen3.8-max");
    mount(<AgentModelList catalogue={withOne} onPick={() => undefined} />);
    const greyed = rowsIn().find((entry) => entry.dataset.modelId === "qwen3.8-max")!;
    expect(greyed.title).toContain("qwen3.8-max");
    expect(greyed.title).toContain(AGENT_ROUTE_UNSUPPORTED);
    // And a row the engine DOES run carries its id and no apology.
    expect(rowsIn().find((entry) => entry.dataset.modelId === "kimi-k3")!.title).toBe("kimi-k3");
  });

  test("a supported row does select", () => {
    const picked: string[] = [];
    mount(<AgentModelList catalogue={catalogue} onPick={(id) => picked.push(id)} />);
    act(() => rowsIn().find((entry) => entry.dataset.modelId === "glm-5.3")!.click());
    expect(picked).toEqual(["glm-5.3"]);
  });

  test("a read-only picker greys nothing extra — it just writes nothing", () => {
    const picked: string[] = [];
    mount(<AgentModelList catalogue={catalogue} readOnly onPick={(id) => picked.push(id)} />);
    const glm = rowsIn().find((entry) => entry.dataset.modelId === "glm-5.3")!;
    expect(glm.disabled).toBe(true);
    // The greying is the UNSUPPORTED signal and must not be borrowed, or a
    // pane still loading reads as thirty-eight broken models.
    expect(glm.className).not.toContain("opacity-45");
    act(() => glm.click());
    expect(picked).toEqual([]);
  });
});

describe("search", () => {
  test("matches the display name, the raw id, and the family", () => {
    const kimi = MODELS[1]!; // "Kimi K2.7 Code" / `kimi-k2.7-code` / Kimi
    expect(matchesAgentQuery(kimi, "Kimi K2.7")).toBe(true);
    // THE ID IS NOT THE NAME, and a person with an id in a config file types
    // the id: "k2.7-code" appears in one and not the other.
    expect(matchesAgentQuery(kimi, "k2.7-code")).toBe(true);
    expect(matchesAgentQuery(kimi, "KIMI")).toBe(true);
    expect(matchesAgentQuery(kimi, "llama")).toBe(false);
    // An empty query is not a filter.
    expect(matchesAgentQuery(kimi, "   ")).toBe(true);
  });

  test("narrows the rendered list to the family that matched", () => {
    search("kimi");
    expect(rowsIn().map((button) => button.dataset.modelId)).toEqual(["kimi-k3", "kimi-k2.7-code"]);
  });

  test("searches across families rather than within one", () => {
    search("5.3");
    expect(rowsIn().map((button) => button.dataset.modelId)).toEqual(["glm-5.3"]);
  });

  test("finds a row the engine will not run — and it is still unpickable", () => {
    // Searching must not quietly become a way past the greying. Marked
    // unsupported here rather than named by route: what is under test is the
    // engine's `no` surviving a filter, not which endpoints are reachable.
    search("grok", onlyUnsupported("grok-4.6"));
    expect(rowsIn().map((button) => button.dataset.modelId)).toEqual(["grok-4.6"]);
    expect(rowsIn()[0]!.disabled).toBe(true);

    // AND THE SAME ROW THE ENGINE DOES RUN IS PICKABLE THROUGH THE SAME FILTER.
    search("grok");
    expect(rowsIn()[0]!.disabled).toBe(false);
  });

  test("a query that matches nothing says which query", () => {
    search("llama");
    expect(rowsIn()).toHaveLength(0);
    expect(host.textContent).toContain("llama");
  });

  /** The Default row matches no query, and pinning it above a filtered list
   *  makes the first result look like the second. */
  test("the Default row steps aside while searching", () => {
    search("");
    expect(host.textContent).toContain("Default");
    search("glm");
    expect(host.textContent).not.toContain("Default");
  });
});

describe("the Default row", () => {
  test("names the model it actually means", () => {
    const markup = renderToStaticMarkup(<AgentModelList catalogue={catalogue} onPick={() => undefined} />);
    expect(markup).toContain("Default");
    // Not the word alone: the engine marks which row is the default, and the
    // hint says so rather than making somebody go and look it up.
    expect(markup).toContain("Kimi K3");
  });

  test("is selected when nothing is stored, and writes the empty string", () => {
    const picked: string[] = [];
    mount(<AgentModelList catalogue={catalogue} onPick={(id) => picked.push(id)} />);
    const button = [...host.querySelectorAll<HTMLButtonElement>("button")].find((entry) => entry.textContent?.startsWith("Default"))!;
    act(() => button.click());
    // `""` is what the engine's patch reads as "clear the setting".
    expect(picked).toEqual([""]);
  });
});

/**
 * THE MODEL ALREADY CHOSEN, which the picker cannot have caused: an id typed
 * into Settings before this picker existed, set from the phone, or moved to
 * another endpoint by Go since.
 */
describe("a stored model this client cannot speak to", () => {
  test("is flagged, with the reason and something to switch to", () => {
    const trouble = agentModelTrouble(onlyUnsupported("qwen3.8-max"), "qwen3.8-max")!;
    expect(trouble.running.id).toBe("qwen3.8-max");
    expect(trouble.obstacle).toBe(AGENT_ROUTE_UNSUPPORTED);
    // The marked default when it is usable — the nearest thing that WOULD run.
    expect(trouble.switchTo?.id).toBe("kimi-k3");
  });

  test("a supported one is not flagged, and neither is one nobody described", () => {
    expect(agentModelTrouble(catalogue, "kimi-k3")).toBeUndefined();
    expect(agentModelTrouble(catalogue, "deepseek-flash")).toBeUndefined();
    // A MODEL THE CATALOGUE DOES NOT CARRY IS NOT A PROBLEM: nothing here knows
    // its route, and a cockpit warning about what it cannot know is a cockpit
    // whose warnings get ignored.
    expect(agentModelTrouble(catalogue, "some-model-added-this-morning")).toBeUndefined();
    // Nor is an empty catalogue, which is a Go that did not answer.
    expect(agentModelTrouble({ models: [], source: { go: null, modelsDev: null } }, "qwen3.8-max")).toBeUndefined();
    // AND SINCE #571, NEITHER IS A MESSAGES OR RESPONSES MODEL. The engine runs
    // them; a cockpit that still warned would be warning about nothing.
    expect(agentModelTrouble(catalogue, "qwen3.8-max")).toBeUndefined();
    expect(agentModelTrouble(catalogue, "grok-4.6")).toBeUndefined();
  });

  /** Storing nothing means the ENGINE'S default runs, so that is what gets
   *  checked — and if it ever became unreachable the warning is as urgent. */
  test("an unset model checks the default rather than staying quiet", () => {
    expect(agentModelTrouble(catalogue)).toBeUndefined();
    const moved = MODELS.map((row) => (row.id === "kimi-k3" ? { ...row, route: "messages" as const, supported: false } : row));
    const trouble = agentModelTrouble({ models: moved, source: { go: 1, modelsDev: 1 } })!;
    expect(trouble.running.id).toBe("kimi-k3");
    // The marked default is the broken one, so the offer is the newest row that
    // does work — the catalogue already arrives newest-first.
    expect(trouble.switchTo?.id).toBe("kimi-k2.7-code");
  });

  test("nothing supported at all offers no switch rather than a wrong one", () => {
    const allBroken = MODELS.map((row) => ({ ...row, route: "responses" as const, supported: false }));
    const trouble = agentModelTrouble({ models: allBroken, source: { go: 1, modelsDev: 1 } }, "kimi-k3")!;
    expect(trouble.obstacle).toBeTruthy();
    expect(trouble.switchTo).toBeUndefined();
  });
});

describe("the two halves failing", () => {
  test("no ids at all shows the service's own words", () => {
    const markup = renderToStaticMarkup(
      <AgentModelList catalogue={{ models: [], source: { go: null, modelsDev: null }, message: "OpenCode Go answered 502." }} onPick={() => undefined} />,
    );
    expect(markup).toContain("OpenCode Go answered 502.");
  });

  /** A full list of raw ids looks exactly like the picker this replaces, so it
   *  has to say that this is a degraded state rather than the feature. */
  test("names missing is said out loud, not left to look like the old picker", () => {
    const undescribed = MODELS.map((model) => ({ ...model, name: model.id, described: false }));
    const markup = renderToStaticMarkup(
      <AgentModelList catalogue={{ models: undescribed, source: { go: 1_000, modelsDev: null } }} onPick={() => undefined} />,
    );
    expect(markup).toContain("models.dev");
    // And it is silent when the descriptions did arrive.
    expect(renderToStaticMarkup(<AgentModelList catalogue={catalogue} onPick={() => undefined} />)).not.toContain("models.dev");
  });

  test("a stored model the catalogue does not carry is still shown", () => {
    const markup = renderToStaticMarkup(<AgentModelList model="some-withdrawn-model" catalogue={catalogue} onPick={() => undefined} />);
    expect(markup).toContain("some-withdrawn-model");
    expect(markup).toContain("external");
  });
});

/**
 * THE FIELD FEEDS THE LIST (#732).
 *
 * Everything above drives `AgentModelRows` with a `query` prop, which says what
 * a query matches and says nothing about whether the field ever produces one.
 * That line was the gap this file named and could not close. It can now, so it
 * does: the real shell, mounted, typed into, and the rows read off the result.
 */
describe("the field feeds the list", () => {
  const listed = () => rowsIn().map((node) => node.dataset.modelId);
  const field = () => host.querySelector<HTMLInputElement>('input[aria-label="Search models by name or id"]')!;

  test("typing narrows the rows — the shell's own `setQuery`, driven", async () => {
    mount(<AgentModelList catalogue={catalogue} onPick={() => undefined} />);
    expect(listed()).toEqual(MODELS.map((model) => model.id));
    await typeInto(field(), "kimi");
    expect(listed()).toEqual(["kimi-k3", "kimi-k2.7-code"]);
  });

  test("and it matches the raw wire id as well as the name, through the field", async () => {
    mount(<AgentModelList catalogue={catalogue} onPick={() => undefined} />);
    // "k2.7" is in the id and not in the family heading — the case #551 asked
    // for, now reachable the way a person reaches it.
    await typeInto(field(), "k2.7");
    expect(listed()).toEqual(["kimi-k2.7-code"]);
  });
});
