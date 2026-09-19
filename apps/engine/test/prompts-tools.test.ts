/**
 * The `prompt` toolkit — the wall an agent uses to hand a prepared message to
 * the person instead of acting on it.
 *
 * What is under test is the set of judgements the wall makes on top of the
 * store, which `prompt-shelf.test.ts` covers:
 *   · a draft defaults to THIS session, because the handoff case is the common
 *     one and a project-wide default would scatter every follow-up;
 *   · the wall declares the hand — nothing an agent writes is ever marked as
 *     the person's;
 *   · `prompt_drop` removes only what an agent wrote, and refuses the person's
 *     in a sentence they can act on;
 *   · nothing here lands anything: four read/write verbs and no send.
 */
import { describe, expect, test } from "bun:test";
import { assertTelarToolNames, type PreparedPrompt } from "@telar/engine-client";
import { promptsTools, type PromptsCapability } from "../src/prompts-tools/tools";

type Registered = {
  name: string;
  run: (args: Record<string, unknown>) => Promise<{ content: unknown[]; isError?: boolean }>;
};

const stamp = { label: "Thu 10:00", at: 1 };
const prompt = (extra: Partial<PreparedPrompt> = {}): PreparedPrompt =>
  ({
    id: "q-1",
    projectId: "p1",
    title: "Ship it",
    text: "run the release",
    created: stamp,
    updated: stamp,
    author: "session",
    schemaVersion: 1,
    ...extra,
  }) as PreparedPrompt;

function build(capability: Partial<PromptsCapability> = {}) {
  const registered: Registered[] = [];
  const factory = (_name: string, _description: string, _shape: Record<string, unknown>, run: Registered["run"]) => {
    registered.push({ name: _name, run });
    return { name: _name };
  };
  const full: PromptsCapability = {
    self: capability.self ?? { projectId: "p1", sessionId: "s1" },
    list: capability.list ?? (async () => [prompt()]),
    create: capability.create ?? (async (input) => prompt({ ...input, author: "session" })),
    remove: capability.remove ?? (async () => true),
  };
  promptsTools(factory as never, full);
  const call = async (name: string, args: Record<string, unknown> = {}) => {
    const tool = registered.find((entry) => entry.name === name);
    if (!tool) throw new Error(`no tool named ${name}`);
    const result = await tool.run(args);
    return { isError: result.isError === true, text: (result.content[0] as { text: string }).text };
  };
  return { names: registered.map((entry) => entry.name), call };
}

describe("the wall", () => {
  test("is exactly four tools — no rename, no reorder, no fifth slipped in", () => {
    expect([...build().names].sort()).toEqual(["prompt_draft", "prompt_drop", "prompt_list", "prompt_read"]);
  });

  test("every tool declares the prompt capability in its name", () => {
    // Without the prefix these land in the generic `mcp__` bucket and lose
    // their row type — the failure `tool-names.test.ts` exists to prevent.
    expect(() => assertTelarToolNames(build().names)).not.toThrow();
  });

  test("carries nothing accept-shaped: no verb sends, queues or answers", () => {
    // INV-1. The whole point of drafting is that a person presses it, so a wall
    // that could send its own draft would be the feature defeating itself.
    const names = build().names.join(" ");
    expect(names).not.toMatch(/send|queue|run|answer|accept/);
  });
});

describe("who a draft is for", () => {
  test("defaults to THIS session — a follow-up belongs in the conversation that drafted it", async () => {
    const seen: Array<{ sessionId?: string }> = [];
    const wall = build({
      create: async (input) => {
        seen.push({ ...(input.sessionId ? { sessionId: input.sessionId } : {}) });
        return prompt({ ...input, sessionId: input.sessionId, author: "session" });
      },
    });

    const answer = await wall.call("prompt_draft", { title: "Next", text: "look at the flaky test" });
    expect(answer.isError).toBe(false);
    expect(seen).toEqual([{ sessionId: "s1" }]);
    expect(answer.text).toMatch(/this session's/);
  });

  test("`forThisSession: false` is the generation case — every composer on the project", async () => {
    const seen: Array<Record<string, unknown>> = [];
    const wall = build({
      create: async (input) => {
        seen.push({ ...input });
        return prompt({ ...input, author: "session" });
      },
    });

    const answer = await wall.call("prompt_draft", { title: "Kickoff", text: "write the spec", forThisSession: false });
    expect(answer.isError).toBe(false);
    expect(seen[0]!.sessionId).toBeUndefined();
    expect(answer.text).toMatch(/project's/);
  });

  test("a turn with no session of its own can still write a project-wide prompt", async () => {
    const seen: Array<Record<string, unknown>> = [];
    const wall = build({
      self: { projectId: "p1" },
      create: async (input) => {
        seen.push({ ...input });
        return prompt({ ...input, author: "session" });
      },
    });

    expect((await wall.call("prompt_draft", { title: "Kickoff", text: "x" })).isError).toBe(false);
    expect(seen[0]!.sessionId).toBeUndefined();
  });
});

describe("what a draft refuses", () => {
  test("a blank title or text is named, not stored", async () => {
    const wall = build();
    expect((await wall.call("prompt_draft", { title: "  ", text: "x" })).isError).toBe(true);
    expect((await wall.call("prompt_draft", { title: "Next", text: "   " })).isError).toBe(true);
  });

  test("the store's own refusal is carried out whole", async () => {
    const wall = build({
      create: async () => {
        throw new Error("A prepared prompt holds up to 256 KB of text; this one is larger.");
      },
    });
    const answer = await wall.call("prompt_draft", { title: "Huge", text: "x" });
    expect(answer.isError).toBe(true);
    expect(answer.text).toMatch(/256 KB/);
  });
});

describe("listing", () => {
  test("a preview rather than the whole message, and the hands are legible", async () => {
    const long = "x".repeat(400);
    const wall = build({ list: async () => [prompt({ text: long }), prompt({ id: "q-2", title: "Mine", author: "you" })] });
    const answer = await wall.call("prompt_list");

    expect(answer.isError).toBe(false);
    expect(answer.text).not.toContain(long);
    expect(answer.text).toContain("…");
    expect(answer.text).toContain('"author": "you"');
    expect(answer.text).toContain('"author": "session"');
  });

  test("an empty shelf says so rather than looking like a failure", async () => {
    const wall = build({ list: async () => [] });
    const answer = await wall.call("prompt_list");
    expect(answer.isError).toBe(false);
    expect(answer.text).toMatch(/Nothing is on this project's shelf/);
  });

  test("prompt_read gives the one whole message a listing withheld", async () => {
    const long = "x".repeat(400);
    const wall = build({ list: async () => [prompt({ text: long })] });
    expect((await wall.call("prompt_read", { promptId: "q-1" })).text).toContain(long);
    expect((await wall.call("prompt_read", { promptId: "nope" })).isError).toBe(true);
  });
});

describe("the fence on drop", () => {
  test("an agent may clean up after agents", async () => {
    const removed: string[] = [];
    const wall = build({ remove: async (id) => (removed.push(id), true) });
    const answer = await wall.call("prompt_drop", { promptId: "q-1" });

    expect(answer.isError).toBe(false);
    expect(removed).toEqual(["q-1"]);
  });

  test("a prompt the PERSON set aside is theirs, and the refusal says what to do instead", async () => {
    const removed: string[] = [];
    const wall = build({ list: async () => [prompt({ author: "you", title: "My own thought" })], remove: async (id) => (removed.push(id), true) });
    const answer = await wall.call("prompt_drop", { promptId: "q-1" });

    expect(answer.isError).toBe(true);
    expect(answer.text).toMatch(/theirs/);
    expect(answer.text).toMatch(/let them drop it/);
    expect(removed).toEqual([]);
  });

  test("dropping one that is not there is an error with a sentence, not a silent pass", async () => {
    const wall = build({ list: async () => [] });
    const answer = await wall.call("prompt_drop", { promptId: "q-9" });
    expect(answer.isError).toBe(true);
    expect(answer.text).toMatch(/No prepared prompt goes by/);
  });
});
