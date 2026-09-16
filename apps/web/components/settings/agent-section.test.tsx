/**
 * THE AGENT'S SETTINGS GROUP, ROUND-TRIPPED against a scripted engine (#531).
 *
 * A DOM AND A REAL MOUNT, because every claim here is about what a CONTROL
 * sends and what the pane does with the answer — and both halves are effects.
 * A static render could assert the switch's initial position and nothing else,
 * which is the half that has never broken.
 *
 * ── THE THREE THINGS WORTH PINNING ──────────────────────────────────────────
 * THE ENGINE'S ANSWER IS THE STATE. Every control writes, then redraws from
 * what came BACK — never from what it sent. A pane that echoed the request
 * would show a switch as on after the engine refused to turn it on, which is
 * the failure mode that makes a settings page untrustworthy.
 *
 * THE PATCH IS BY PRESENCE. Typing a model must not also re-decide the switch,
 * and `reset` must never ride along: a patch that carried `reset: false` by
 * default would be one refactor away from carrying `true`, and the thing it
 * archives is the conversation.
 *
 * AN EMPTY KEY IS AN EXPLICIT CLEAR. This is the one place that departs from
 * the provider registry's "blank never clears" rule, so it is the one that has
 * to be stated somewhere a change would trip over.
 */
// @ts-expect-error bun:test has no types in this app's tsconfig
import { afterAll, afterEach, beforeEach, describe, expect, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { act } from "react";
import { createRoot } from "react-dom/client";
import type { AgentAnswer, AgentState, ProviderModel } from "@telar/engine-client";
import { AgentSection } from "./agent-section";

/**
 * REGISTERED HERE AND UNREGISTERED IN `afterAll` — the pairing every DOM test
 * on this pane keeps, and the one this file cannot skip.
 *
 * Happy DOM THROWS on a second `register` rather than no-oping, and a file that
 * registers without releasing leaves the next one in the run unable to. The
 * failure then lands on whichever file happened to be next, which is why it is
 * worth stating rather than leaving to be rediscovered from a confusing
 * traceback in somebody else's test.
 */
GlobalRegistrator.register({ url: "http://localhost/" });
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

/**
 * THE ENGINE IS STUBBED AT `fetch`, NOT AT A MODULE.
 *
 * `mock.module` would have been shorter and is wrong here: it replaces a module
 * for the WHOLE RUN, and `@/lib/engine/client` is the one module nearly every
 * other test in this app reaches through. Stubbing it here silently handed a
 * two-method fake to files that ran afterwards — their reads returned nothing
 * and their assertions failed a long way from the cause.
 *
 * Stubbing `fetch` costs one line more and is strictly better: the real hook,
 * the real client and the real route paths are all exercised, so a patch sent
 * to the wrong URL is caught here rather than in production.
 */
const realFetch = globalThis.fetch;
/** Every patch the pane sent, in order — the write half of the round trip. */
const sent: Array<Record<string, unknown>> = [];
/** What the engine answers next. Set per test, so "the answer is the state"
 *  can be shown by answering something the pane did not ask for. */
let answer: AgentAnswer = { agent: { enabled: false, running: false, queued: 0 }, credential: { set: false } };
/** What `GET /api/agent/models` answers next. */
let models: { models: ProviderModel[]; message?: string } = { models: [], message: "OpenCode Go did not answer its model list." };

let container: HTMLDivElement;
let root: ReturnType<typeof createRoot>;

/** Mount and let the deferred first read land — the loader is on a timeout,
 *  like every other one on this pane. */
async function mount(): Promise<void> {
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  await act(async () => {
    root.render(<AgentSection />);
  });
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
}

const find = <T extends Element>(selector: string): T => {
  const found = container.querySelector<T>(selector);
  if (!found) throw new Error(`no ${selector} in the rendered pane`);
  return found;
};

const button = (label: string): HTMLButtonElement => {
  const found = [...container.querySelectorAll("button")].find((each) => each.textContent?.trim() === label);
  if (!found) throw new Error(`no "${label}" button — saw ${[...container.querySelectorAll("button")].map((each) => each.textContent?.trim()).join(", ")}`);
  return found as HTMLButtonElement;
};

const click = async (element: HTMLElement): Promise<void> => {
  await act(async () => {
    element.click();
  });
  await act(async () => {
    await Promise.resolve();
  });
};

const state = (over: Partial<AgentState> = {}): AgentState => ({ enabled: false, running: false, queued: 0, ...over });

beforeEach(() => {
  sent.length = 0;
  answer = { agent: state(), credential: { set: false } };
  models = { models: [], message: "OpenCode Go did not answer its model list." };
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    // THE PATH IS ASSERTED BY BEING THE ONLY ONE ANSWERED. A patch sent
    // anywhere else falls through to the throw below and names the URL.
    // THE LIST FAILS SOFT BY DESIGN, so the default fixture is the state
    // somebody setting the Agent up is actually in: no key yet, so Go has
    // nothing to list, and the model row is a text field.
    if (url.startsWith("/api/agent/models")) return Response.json(models);
    if (url.startsWith("/api/agent")) {
      if (init?.method === "PATCH") sent.push(JSON.parse(String(init.body)) as Record<string, unknown>);
      return Response.json(answer);
    }
    throw new Error(`the pane asked for ${url}, which this test does not serve`);
  }) as typeof fetch;
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  globalThis.fetch = realFetch;
});

afterAll(() => {
  GlobalRegistrator.unregister();
});

describe("the switch", () => {
  test("reads the engine's answer, and writes only `enabled`", async () => {
    answer = { agent: state({ enabled: true, threadId: "thread_one" }), credential: { source: "setting", set: true } };
    await mount();
    expect(find('[role="switch"]').getAttribute("aria-checked")).toBe("true");

    await click(find<HTMLElement>('[role="switch"]'));
    // BY PRESENCE: turning the switch must not also re-send a model, and above
    // all must not carry `reset`.
    expect(sent).toEqual([{ enabled: false }]);
  });

  test("off until the engine says otherwise, never a hopeful on", async () => {
    // The default is off, so a first paint showing it on would read as "Telar
    // did this without asking" for the length of one fetch.
    await mount();
    expect(find('[role="switch"]').getAttribute("aria-checked")).toBe("false");
  });
});

describe("the key", () => {
  test("shows whether one is set, and never the key itself", async () => {
    answer = { agent: state({ enabled: true }), credential: { source: "setting", set: true } };
    await mount();
    const field = find<HTMLInputElement>('input[aria-label="OpenCode Go key"]');
    expect(field.getAttribute("type")).toBe("password");
    expect(field.getAttribute("placeholder")).toBe("A key is saved");
    expect(field.value).toBe("");
    // The row says "set" beside the label for a reader scanning the pane.
    expect(container.textContent).toContain("set");
    // …and a key that is set offers Remove rather than Save.
    expect(button("Remove")).toBeTruthy();
  });

  test("a fallback rung is named, and is not mistaken for a saved key", async () => {
    answer = { agent: state({ enabled: true }), credential: { source: "environment", set: false } };
    await mount();
    expect(container.textContent).toContain("OPENCODE_API_KEY");
    expect(find<HTMLInputElement>('input[aria-label="OpenCode Go key"]').getAttribute("placeholder")).toBe("sk-…");
  });

  test("an engine that cannot report one is not read as having none", async () => {
    // THE THIRD STATE. `undefined` must not demand setup from somebody whose
    // Agent is working fine.
    answer = { agent: state({ enabled: true }), credential: undefined };
    await mount();
    expect(container.textContent).toContain("does not report where its key comes from");
    expect(container.textContent).not.toContain("No key anywhere");
  });

  test("Remove sends an explicit empty string", async () => {
    answer = { agent: state({ enabled: true }), credential: { source: "setting", set: true } };
    await mount();
    await click(button("Remove"));
    // THE DEPARTURE FROM THE REGISTRY'S RULE, stated. Blank never clears on a
    // shared provider form because it means "I did not retype it"; here this
    // field is the only writer of the secret and Remove has to mean it.
    expect(sent).toEqual([{ apiKey: "" }]);
  });
});

describe("the model row", () => {
  const model = (id: string): ProviderModel =>
    ({ id, label: id, efforts: [], isDefault: false, hidden: false, fastMode: false, hiddenByUser: false, source: "provider" }) as ProviderModel;

  test("a text field when Go could not be listed, and it says why", async () => {
    // NOT AN EDGE CASE. Opening this pane before pasting a key is at least as
    // common as after, and it is exactly the state somebody setting the Agent
    // up is in — an empty dropdown would look broken where a field looks open.
    answer = { agent: state({ enabled: true }), credential: { set: false } };
    await mount();
    expect(find('input[aria-label="Agent model"]')).toBeTruthy();
    expect(container.textContent).toContain("OpenCode Go did not answer its model list.");
  });

  test("a picker when Go answered, with the default as a real option", async () => {
    answer = { agent: state({ enabled: true }), credential: { source: "setting", set: true } };
    models = { models: [model("kimi-k3"), model("qwen-3")] };
    await mount();
    // The field is gone — the list is what the row offers now. The options
    // themselves live in a portal that opens on a click, so what is asserted
    // here is the CONTROL: a dropdown rather than a text input, showing the
    // default as a real choice somebody can come back to.
    expect(container.querySelector('input[aria-label="Agent model"]')).toBeNull();
    expect(container.querySelector('[aria-label="Agent model"]')).toBeTruthy();
    expect(container.textContent).toContain("Default (kimi-k3)");
    // …and the row no longer apologises for a list it could not read.
    expect(container.textContent).not.toContain("did not answer its model list");
  });
});

describe("reset", () => {
  test("there is nothing to reset before there is a thread", async () => {
    answer = { agent: state({ enabled: true }), credential: { set: false } };
    await mount();
    expect(button("Reset conversation").disabled).toBe(true);
  });

  test("it asks first, and Cancel sends nothing", async () => {
    answer = { agent: state({ enabled: true, threadId: "thread_one" }), credential: { set: false } };
    await mount();
    await click(button("Reset conversation"));
    expect(container.textContent).toContain("archived beside it");
    await click(button("Cancel"));
    expect(sent).toEqual([]);
    // And the row goes back to offering the first press.
    expect(button("Reset conversation")).toBeTruthy();
  });

  test("confirmed, it sends `reset` and nothing else", async () => {
    answer = { agent: state({ enabled: true, threadId: "thread_one" }), credential: { set: false } };
    await mount();
    await click(button("Reset conversation"));
    await click(button("Reset"));
    expect(sent).toEqual([{ reset: true }]);
  });
});

describe("the engine's answer is the state", () => {
  test("a refused change leaves the pane showing what is stored", async () => {
    answer = { agent: state({ enabled: true, threadId: "thread_one" }), credential: { set: false } };
    await mount();
    // The engine keeps answering `enabled: true` — it did not accept the change.
    await click(find<HTMLElement>('[role="switch"]'));
    expect(sent).toEqual([{ enabled: false }]);
    // A pane that echoed its own request would now read off. It reads the
    // ANSWER, so it still reads on.
    expect(find('[role="switch"]').getAttribute("aria-checked")).toBe("true");
  });
});
