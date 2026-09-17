/**
 * THE AGENT COMPOSER'S THREE PILLS (#539).
 *
 * The Agent's model, effort and access were set in Settings only, because the
 * composer's own pickers are gated on a `session` this screen does not have.
 * These are its own, over its own sources — and the thing that must NOT differ
 * is how they look, which is why they are built from the session composer's
 * exported furniture rather than redrawn.
 *
 * What must not drift:
 *
 *   - ABSENT IS NOT A VALUE, twice over and differently. An unset effort means
 *     `reasoning_effort` is not sent at all, so its row is "Auto"; an unset
 *     access means `ask`, which is a real default with a name;
 *   - the access pill SAYS which mode is active, on the pill, because that is
 *     the setting a person most wants to confirm before pressing send;
 *   - a model the list does not carry is still shown, so the pill never reads
 *     as running something it is not;
 *   - `auto` is described as changing who ANSWERS, never what is allowed.
 */
// @ts-expect-error bun:test has no types in this app's tsconfig
import { describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import type { AgentModel, AgentModelCatalogue, AgentState } from "@telar/engine-client";
import {
  AGENT_ACCESS_HELP,
  AGENT_ACCESS_LABEL,
  AGENT_EFFORT_LABEL,
  AgentAccessControl,
  AgentComposerControls,
  AgentEffortControl,
  AgentModelControl,
} from "./agent-composer-controls";

/** A described row, shaped like the engine's — see `agent-model-picker.test.tsx`
 *  for the list's own cases; these are about the PILL. */
const model = (id: string, name: string): AgentModel =>
  ({ id, name, label: name, family: "Kimi", route: "chat", supported: true, described: true, efforts: [], isDefault: false }) as unknown as AgentModel;
const catalogue: AgentModelCatalogue = {
  models: [model("kimi-k3", "Kimi K3"), model("gpt-5.5", "GPT-5.5")],
  source: { go: 1, modelsDev: 1 },
};
const empty: AgentModelCatalogue = { models: [], source: { go: null, modelsDev: null } };
const on: AgentState = { enabled: true, running: false, queued: 0 };

describe("the model pill", () => {
  test("names the model, and the service's default when nobody picked one", () => {
    // THE NAME, NOT THE ID (#551): "Kimi K3" is what the row said when it was
    // picked; `kimi-k3` is still what goes on the wire.
    expect(renderToStaticMarkup(<AgentModelControl model="kimi-k3" catalogue={catalogue} />)).toContain("Kimi K3");
    // Not blank, and not a guessed id: the pill names the QUESTION until the
    // question is answered.
    const unset = renderToStaticMarkup(<AgentModelControl catalogue={catalogue} />);
    expect(unset).toContain("Model");
    expect(unset).toContain("the service default");
  });

  test("a model the catalogue does not carry is still what the pill says", () => {
    // Set in Settings, or withdrawn upstream since. The pill must never read as
    // running something it is not, and it has no name to fall back on — so the
    // raw id is what it shows.
    expect(renderToStaticMarkup(<AgentModelControl model="some-newer-model" catalogue={catalogue} />)).toContain("some-newer-model");
  });
});

describe("the effort pill", () => {
  test("an unset effort names the question rather than a level", () => {
    const markup = renderToStaticMarkup(<AgentEffortControl />);
    expect(markup).toContain("Reasoning");
    // NOT "Auto" on the pill: the access pill beside it would then read "Ask"
    // and "Auto" would be ambiguous between the two questions.
    // The aria-label carries what is actually set, for a reader who cannot see
    // the stand-in noun. (Rendered markup escapes the apostrophe.)
    expect(markup).toContain("own default");
  });

  test("a chosen level names itself", () => {
    expect(renderToStaticMarkup(<AgentEffortControl effort="high" />)).toContain(AGENT_EFFORT_LABEL.high);
    expect(renderToStaticMarkup(<AgentEffortControl effort="low" />)).toContain("Low");
  });
});

describe("the access pill", () => {
  test("shows which mode is active, including the default nobody set", () => {
    // The issue asks for this by name: which is active is on the PILL, not only
    // inside the menu.
    expect(renderToStaticMarkup(<AgentAccessControl />)).toContain(AGENT_ACCESS_LABEL.ask);
    expect(renderToStaticMarkup(<AgentAccessControl access="auto" />)).toContain(AGENT_ACCESS_LABEL.auto);
  });

  test("auto is described as changing who answers, not what is allowed", () => {
    // THE GATED LIST DOES NOT WIDEN, and the words a person decides on have to
    // say so — this is the load-bearing half of the setting.
    expect(AGENT_ACCESS_HELP.auto).toContain("still gated");
    expect(AGENT_ACCESS_HELP.auto).toContain("nothing new is allowed");
    expect(AGENT_ACCESS_HELP.ask).toContain("approve");
  });
});

describe("the row", () => {
  test("all three, with the composer's hairlines between them", () => {
    const markup = renderToStaticMarkup(<AgentComposerControls state={{ ...on, model: "kimi-k3", effort: "medium", access: "auto" }} catalogue={catalogue} />);
    expect(markup).toContain("Kimi K3");
    expect(markup).toContain("Medium");
    expect(markup).toContain("Auto");
    // Two dividers between three pills — the same borderless grammar the
    // session composer uses, rather than three bordered chips.
    expect(markup.split("h-4 w-px").length - 1).toBe(2);
  });

  test("an Agent nobody has configured still draws three pills", () => {
    const markup = renderToStaticMarkup(<AgentComposerControls state={on} catalogue={empty} />);
    expect(markup).toContain("Model");
    expect(markup).toContain("Reasoning");
    expect(markup).toContain(AGENT_ACCESS_LABEL.ask);
  });
});
