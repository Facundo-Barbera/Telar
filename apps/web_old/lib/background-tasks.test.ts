// THE ROSTER'S RULES, EXECUTABLE. Everything here is a decision the pinned
// environment and the composer's aggregate line now depend on — which bucket an
// opaque `task_type` falls in, what a malformed wire entry costs, and what the
// one-line summary says — and none of it is testable through the components
// themselves (no DOM harness in this repo; story 3.1's hard rule 9). So the
// decisions live in `background-tasks.ts` and are pinned here, the same shape
// `ultra-runs.ts` / `ultra-runs.test.ts` use.
// @ts-expect-error -- bun:test has no types in this app's tsconfig
import { describe, expect, test } from "bun:test";
import {
  backgroundTaskKind,
  backgroundTaskLabel,
  backgroundWorkPhrase,
  normalizeBackgroundTasks,
  type BackgroundTask,
} from "@/lib/background-tasks";

const task = (type: string, id = `t-${type}`): BackgroundTask => ({
  id,
  type,
  description: `${type} work`,
});

describe("backgroundTaskKind — an opaque wire string, bucketed without inventing a union", () => {
  test("shell work is a command, whatever the harness calls it", () => {
    expect(backgroundTaskKind("bash")).toBe("command");
    expect(backgroundTaskKind("bash_command")).toBe("command");
    expect(backgroundTaskKind("Shell")).toBe("command");
  });

  test("subagents and Task-tool work are agents", () => {
    expect(backgroundTaskKind("agent")).toBe("agent");
    expect(backgroundTaskKind("subagent")).toBe("agent");
    expect(backgroundTaskKind("task")).toBe("agent");
  });

  test("`local_workflow` — the one value the SDK documents — is its own bucket", () => {
    expect(backgroundTaskKind("local_workflow")).toBe("workflow");
  });

  test("an unrecognised type is called a task, not guessed at", () => {
    // The failure mode this protects against is a row that LIES about what is
    // running. A future harness type lands as "task" — visible, described by
    // its own text, and claiming nothing it cannot back up.
    expect(backgroundTaskKind("something_new_in_0_4")).toBe("task");
    expect(backgroundTaskKind("")).toBe("task");
  });
});

describe("normalizeBackgroundTasks — tolerant of the wire, never of a lie", () => {
  test("the SDK's shape maps field for field", () => {
    expect(
      normalizeBackgroundTasks([
        { task_id: "a", task_type: "bash", description: "bun run test:web" },
      ]),
    ).toEqual([{ id: "a", type: "bash", description: "bun run test:web" }]);
  });

  test("round-tripping its own output is idempotent (server → done payload → client)", () => {
    const once = normalizeBackgroundTasks([
      { task_id: "a", task_type: "agent", description: "explore lib" },
    ]);
    expect(normalizeBackgroundTasks(once)).toEqual(once);
  });

  test("an entry with no id is dropped; the rest of the roster survives", () => {
    // An un-keyable row cannot be rendered or reconciled — but one bad entry
    // must cost that entry, not the roster, because this runs inside the
    // runtime's message pump where a throw wedges the session.
    const out = normalizeBackgroundTasks([
      { task_type: "bash", description: "no id" },
      null,
      "nonsense",
      { task_id: "b", task_type: "agent", description: "kept" },
    ]);
    expect(out).toEqual([{ id: "b", type: "agent", description: "kept" }]);
  });

  test("missing type/description degrade to empty strings, not to invented text", () => {
    expect(normalizeBackgroundTasks([{ task_id: "c" }])).toEqual([
      { id: "c", type: "", description: "" },
    ]);
  });

  test("a non-array payload is an empty roster", () => {
    expect(normalizeBackgroundTasks(undefined)).toEqual([]);
    expect(normalizeBackgroundTasks({ tasks: [] })).toEqual([]);
  });
});

describe("backgroundWorkPhrase — the composer line stops calling everything an agent", () => {
  test("the mixed case the line was rewritten for", () => {
    expect(backgroundWorkPhrase([task("bash"), task("agent")])).toBe(
      "1 command · 1 agent still working",
    );
  });

  test("one kind alone reads as one clause, pluralized", () => {
    expect(backgroundWorkPhrase([task("agent", "1")])).toBe("1 agent still working");
    expect(backgroundWorkPhrase([task("agent", "1"), task("agent", "2")])).toBe(
      "2 agents still working",
    );
  });

  test("clause order is FIXED, so the sentence never reshuffles under a live roster", () => {
    // Membership changes constantly; a line that reorders itself on each change
    // reads as a new message rather than the same one still being true.
    expect(backgroundWorkPhrase([task("agent"), task("bash")])).toBe(
      "1 command · 1 agent still working",
    );
    expect(
      backgroundWorkPhrase([task("mystery"), task("local_workflow"), task("bash")]),
    ).toBe("1 command · 1 workflow · 1 task still working");
  });

  test("an empty roster produces NO sentence (rule 20: true for exactly as long as it is true)", () => {
    expect(backgroundWorkPhrase([])).toBe("");
  });
});

describe("backgroundTaskLabel — the pinned row's one-word kind", () => {
  test("capitalized, beside the description that says which one", () => {
    expect(backgroundTaskLabel(task("bash"))).toBe("Command");
    expect(backgroundTaskLabel(task("subagent"))).toBe("Agent");
    expect(backgroundTaskLabel(task("local_workflow"))).toBe("Workflow");
    expect(backgroundTaskLabel(task("who_knows"))).toBe("Task");
  });
});
