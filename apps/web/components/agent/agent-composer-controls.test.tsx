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
import type { AgentState, ProviderModel } from "@telar/engine-client";
import {
  AGENT_ACCESS_HELP,
  AGENT_ACCESS_LABEL,
  AGENT_EFFORT_LABEL,
  AgentAccessControl,
  AgentComposerControls,
  AgentEffortControl,
  AgentModelControl,
} from "./agent-composer-controls";

const model = (id: string): ProviderModel => ({ id, label: id, efforts: [] }) as unknown as ProviderModel;
const models = [model("kimi-k3"), model("gpt-5.5")];
const on: AgentState = { enabled: true, running: false, queued: 0 };

describe("the model pill", () => {
  test("names the model, and the service's default when nobody picked one", () => {
    expect(renderToStaticMarkup(<AgentModelControl model="kimi-k3" models={models} />)).toContain("kimi-k3");
    // Not blank, and not a guessed id: the pill names the QUESTION until the
    // question is answered.
    const unset = renderToStaticMarkup(<AgentModelControl models={models} />);
    expect(unset).toContain("Model");
    expect(unset).toContain("the service default");
  });

  test("a model the list does not carry is still what the pill says", () => {
    // Set in Settings, or added upstream since. The pill must never read as
    // running something it is not.
    expect(renderToStaticMarkup(<AgentModelControl model="some-newer-model" models={models} />)).toContain("some-newer-model");
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
    const markup = renderToStaticMarkup(<AgentComposerControls state={{ ...on, model: "kimi-k3", effort: "medium", access: "auto" }} models={models} />);
    expect(markup).toContain("kimi-k3");
    expect(markup).toContain("Medium");
    expect(markup).toContain("Auto");
    // Two dividers between three pills — the same borderless grammar the
    // session composer uses, rather than three bordered chips.
    expect(markup.split("h-4 w-px").length - 1).toBe(2);
  });

  test("an Agent nobody has configured still draws three pills", () => {
    const markup = renderToStaticMarkup(<AgentComposerControls state={on} models={[]} />);
    expect(markup).toContain("Model");
    expect(markup).toContain("Reasoning");
    expect(markup).toContain(AGENT_ACCESS_LABEL.ask);
  });
});
