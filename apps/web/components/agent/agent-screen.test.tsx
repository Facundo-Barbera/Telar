/**
 * WHAT `/agent` DECIDES BEFORE IT DRAWS ANYTHING (#531).
 *
 * THREE STATES AND THE ORDER THEY RESOLVE IN, which is the part a render test
 * cannot reach and a later refactor most easily breaks. The one that matters is
 * LOADING WINNING OVER OFF: the default is off, so answering "off" before the
 * engine has spoken tells somebody whose Agent is on that it is off — for the
 * length of one fetch, on the screen they opened precisely to use it.
 *
 * AND THE KEY NOTICE'S THIRD STATE. An engine too old to report a credential
 * answers `undefined`, which must NOT read as "no key": the difference is a
 * quiet screen versus one demanding setup from somebody whose Agent works fine.
 */
// @ts-expect-error bun:test has no types in this app's tsconfig
import { describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import type { AgentRequest } from "@telar/engine-client";
import { LOCAL_HOST_ID } from "@/lib/hosts/book";
import { AgentApproval, approvalArgument } from "./agent-approval";
import { agentSettingsHref, agentView } from "./agent-screen";
import { AgentTranscript, wakeLabel } from "./agent-transcript";
import type { AgentItem } from "@/lib/agent/thread";

const on = { enabled: true, running: false, queued: 0 };

describe("which screen the Agent draws", () => {
  test("nothing is decided until the engine has answered once", () => {
    expect(agentView({ state: undefined, credential: undefined, loading: true })).toEqual({ kind: "loading" });
    // Answered `loading: false` but with no state yet is the same situation and
    // must not fall through to "off".
    expect(agentView({ state: undefined, credential: undefined, loading: false })).toEqual({ kind: "loading" });
  });

  test("off reads as off, which is every install's case out of the box", () => {
    expect(agentView({ state: { enabled: false, running: false, queued: 0 }, credential: {}, loading: false })).toEqual({ kind: "off" });
  });

  test("on with a key is a quiet conversation", () => {
    expect(agentView({ state: on, credential: { source: "setting" }, loading: false })).toEqual({ kind: "thread" });
    expect(agentView({ state: on, credential: { source: "cli" }, loading: false })).toEqual({ kind: "thread" });
  });

  test("on with no key anywhere says so, and an engine that cannot say does not", () => {
    expect(agentView({ state: on, credential: {}, loading: false })).toEqual({ kind: "thread", notice: "missing" });
    // THE THIRD STATE. `undefined` is an engine too old to report a credential,
    // and reading it as "no key" would demand setup from somebody whose Agent
    // is working.
    expect(agentView({ state: on, credential: undefined, loading: false })).toEqual({ kind: "thread" });
  });
});

describe("whose settings to send somebody to", () => {
  test("this Mac's, and nowhere at all for another's", () => {
    expect(agentSettingsHref()).toBe("/settings");
    expect(agentSettingsHref(LOCAL_HOST_ID)).toBe("/settings");
    // There is no `/hosts/<id>/settings` route. Composing one would be a 404
    // dressed as a fix — a remote Agent gets a sentence instead of a button.
    expect(agentSettingsHref("host_other")).toBeUndefined();
  });
});

describe("the transcript", () => {
  const item = (over: Partial<AgentItem> = {}): AgentItem =>
    ({ kind: "user", id: 1, at: 1, runId: "run_one", text: "hello", ...over }) as AgentItem;

  test("no project chrome — no breadcrumb, no checkout, no run, no open", () => {
    const markup = renderToStaticMarkup(
      <AgentTranscript
        items={[
          item(),
          item({ kind: "assistant", id: 2, text: "hi" } as Partial<AgentItem>),
          item({ kind: "tool", id: 3, name: "sessions_list", input: {}, output: "rows", status: "completed" } as Partial<AgentItem>),
        ]}
      />,
    );
    expect(markup).toContain("hello");
    expect(markup).toContain("sessions_list");
    for (const absent of ["breadcrumb", "Checkout", "Open workspace", "Run "]) {
      expect(markup).not.toContain(absent);
    }
  });

  test("a wake is labelled rather than attributed to the reader", () => {
    // A turn with no human behind it must say so: the Agent subscribes to what
    // it delegates, and drawing that notice as an ordinary user message would
    // attribute somebody else's machine to the person reading.
    expect(wakeLabel({ kind: "user", id: 1, at: 1, runId: "r", text: "" })).toBeUndefined();
    expect(wakeLabel({ kind: "user", id: 1, at: 1, runId: "r", text: "", origin: "user" })).toBeUndefined();
    expect(wakeLabel({ kind: "user", id: 1, at: 1, runId: "r", text: "", origin: "wake" })).toBe("Woken by Telar");
    expect(wakeLabel({ kind: "user", id: 1, at: 1, runId: "r", text: "", origin: "wake", wakeReason: "turn_completed" })).toBe("Woken — turn_completed");
  });

  test("a failed turn says why and a stopped one does not", () => {
    const failed = renderToStaticMarkup(
      <AgentTranscript items={[{ kind: "failure", id: 1, at: 1, runId: "r", status: "failed", message: "the model refused" }]} />,
    );
    expect(failed).toContain("the model refused");
    const stopped = renderToStaticMarkup(<AgentTranscript items={[{ kind: "failure", id: 1, at: 1, runId: "r", status: "stopped" }]} />);
    expect(stopped).toContain("Stopped.");
  });

  test("a tool row is one line until it is opened", () => {
    const markup = renderToStaticMarkup(
      <AgentTranscript items={[{ kind: "tool", id: 1, at: 1, runId: "r", name: "sessions_read", input: { sessionId: "s" }, output: "a long answer", status: "completed" }]} />,
    );
    expect(markup).toContain("sessions_read");
    expect(markup).toContain('aria-expanded="false"');
    // The Agent's tools answer in paragraphs; a conversation that printed every
    // one in full would be unreadable.
    expect(markup).not.toContain("a long answer");
  });
});

describe("the approval", () => {
  const request: AgentRequest = {
    type: "approval",
    id: "req_1",
    runId: "run_one",
    tool: "sessions_send",
    args: { sessionId: "session_x", intent: "task" },
    toolCallId: "call_1",
    reason: "This hands work to another session.",
    openedAt: 1,
  };

  test("two choices, because there is no third the engine could honour", () => {
    const markup = renderToStaticMarkup(<AgentApproval request={request} sending={false} onDecide={() => {}} />);
    expect(markup).toContain("Allow");
    expect(markup).toContain("Deny");
    // `acceptForSession` is exactly what its name says and there is no session
    // here to scope it to. A button that lies about how much rope was handed
    // over is the worst thing to put on this particular screen.
    expect(markup).not.toContain("Always allow");
  });

  test("it says which call, in the engine's own words", () => {
    const markup = renderToStaticMarkup(<AgentApproval request={request} sending={false} onDecide={() => {}} />);
    expect(markup).toContain("sessions_send");
    expect(markup).toContain("This hands work to another session.");
    // THE ARGUMENTS ARE SHOWN IN FULL, because the whole point of an
    // argument-aware gate is that WHICH call it is matters.
    expect(markup).toContain("session_x");
  });

  test("arguments that will not serialise do not take the card down", () => {
    expect(approvalArgument({})).toBeUndefined();
    const cyclic: Record<string, unknown> = {};
    cyclic.self = cyclic;
    expect(approvalArgument(cyclic)).toBeUndefined();
    expect(approvalArgument({ a: 1 })).toContain('"a": 1');
  });
});
