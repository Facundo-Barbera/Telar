import { expect, test } from "bun:test";
import { createClaudeDriver, run } from "../../../test/claude-harness";
import type { DriverRequest } from "../contract";
import { gateFor } from "./permission-gate";

// ── AskUserQuestion ──────────────────────────────────────────────────────────

const COLOR_QUESTION = {
  questions: [
    {
      question: "Which color do you prefer?",
      header: "Color",
      options: [
        { label: "Red", description: "warm" },
        { label: "Blue", description: "cool" },
      ],
      multiSelect: false,
    },
  ],
};

const TOPPING_QUESTION = {
  questions: [
    {
      question: "Which toppings?",
      header: "Toppings",
      options: [
        { label: "Olives", description: "briny" },
        { label: "Basil", description: "fresh" },
        { label: "Chili", description: "hot" },
      ],
      multiSelect: true,
    },
  ],
};

function sdkAskingQuestion(seen: { permission?: unknown }, question: object = COLOR_QUESTION) {
  return async () => ({
    async *query(input: {
      options: {
        canUseTool?: (name: string, args: Record<string, unknown>, opts: { signal: AbortSignal; toolUseID: string }) => Promise<unknown>;
      };
    }) {
      seen.permission = await input.options.canUseTool!("AskUserQuestion", structuredClone(question) as Record<string, unknown>, {
        signal: new AbortController().signal,
        toolUseID: "toolu_q1",
      });
      yield { type: "result", subtype: "success" };
    },
  });
}

test("AskUserQuestion parks as a user_input request and the answers ride back in updatedInput", async () => {
  const asked: Array<{ kind: string; detail: unknown }> = [];
  const seen: { permission?: unknown } = {};
  await run(createClaudeDriver(sdkAskingQuestion(seen)), {
    onRequest: async (request: { kind: string; detail: unknown }) => {
      asked.push(request);
      return { decision: "accept", answers: { "Which color do you prefer?": "Blue" } };
    },
  }).result;
  // Parked as user_input, keyed by the QUESTION TEXT — that is
  // AskUserQuestionOutput's own answer key.
  expect(asked).toHaveLength(1);
  expect(asked[0]!.kind).toBe("user_input");
  const detail = asked[0]!.detail as { kind: string; fields: Array<{ key: string; choices: string[] }> };
  expect(detail.kind).toBe("user_input");
  expect(detail.fields[0]!.key).toBe("Which color do you prefer?");
  expect(detail.fields[0]!.choices).toEqual(["Red", "Blue"]);
  expect(seen.permission).toEqual({
    behavior: "allow",
    updatedInput: { ...COLOR_QUESTION, answers: { "Which color do you prefer?": "Blue" } },
  });
});

test("a multiSelect question asks for SEVERAL answers, and the picks ride back joined", async () => {
  const asked: Array<{ detail: unknown }> = [];
  const seen: { permission?: unknown } = {};
  await run(createClaudeDriver(sdkAskingQuestion(seen, TOPPING_QUESTION)), {
    onRequest: async (request: { kind: string; detail: unknown }) => {
      asked.push(request);
      return { decision: "accept", answers: { "Which toppings?": ["Olives", "Chili"] } };
    },
  }).result;
  const detail = asked[0]!.detail as { fields: Array<{ key: string; choices: string[]; multiple?: boolean }> };
  expect(detail.fields[0]!.multiple).toBe(true);
  expect(detail.fields[0]!.choices).toEqual(["Olives", "Basil", "Chili"]);
  expect(seen.permission).toEqual({
    behavior: "allow",
    updatedInput: { ...TOPPING_QUESTION, answers: { "Which toppings?": "Olives, Chili" } },
  });
});

test("a single-select field says nothing about multiple, and an array answer to one takes the FIRST pick", async () => {
  // Absent, not `false`: a field that never offered several must look exactly
  // as it did before this flag existed.
  const asked: Array<{ detail: unknown }> = [];
  const seen: { permission?: unknown } = {};
  await run(createClaudeDriver(sdkAskingQuestion(seen)), {
    onRequest: async (request: { kind: string; detail: unknown }) => {
      asked.push(request);
      // A client that sends an array here made a mistake. Joining it would
      // invent a two-colour answer to a one-colour question and the model
      // would act on it; the first pick is the honest reading.
      return { decision: "accept", answers: { "Which color do you prefer?": ["Blue", "Red"] } };
    },
  }).result;
  const detail = asked[0]!.detail as { fields: Array<{ multiple?: boolean }> };
  expect(detail.fields[0]!.multiple).toBeUndefined();
  expect(seen.permission).toEqual({
    behavior: "allow",
    updatedInput: { ...COLOR_QUESTION, answers: { "Which color do you prefer?": "Blue" } },
  });
});

test("a DECLINED question lets the tool dismiss itself rather than inventing an answer", async () => {
  // A deny reads to the model as a broken tool; a bare allow lands on the
  // tool's own graceful "the user did not answer" arm. Cancel still withdraws
  // the whole turn.
  const seen: { permission?: unknown } = {};
  await run(createClaudeDriver(sdkAskingQuestion(seen)), { onRequest: async () => "decline" }).result;
  expect(seen.permission).toEqual({ behavior: "allow" });

  const cancelled: { permission?: unknown } = {};
  await run(createClaudeDriver(sdkAskingQuestion(cancelled)), { onRequest: async () => "cancel" }).result;
  expect(cancelled.permission).toEqual({ behavior: "deny", message: "The human cancelled this turn.", interrupt: true });
});

test("the gate hands the SDK's abort signal to the request, so a withdrawn prompt can be cancelled", async () => {
  const withdraw = new AbortController();
  let asked: DriverRequest | undefined;
  const gate = gateFor(async (request) => {
    asked = request;
    return "accept";
  });
  await gate("Bash", { command: "ls" }, { signal: withdraw.signal, toolUseID: "toolu_b1" });
  expect(asked?.signal).toBe(withdraw.signal);
});
