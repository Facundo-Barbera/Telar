/**
 * The drawer's judgement calls, pinned: which answer wins, when Next unlocks,
 * that a partial form can never build a wire payload — and that a MULTI field
 * answers in the shape it promised, whatever the human did to fill it.
 */
// @ts-expect-error bun:test has no types in this app's tsconfig
import { describe, expect, test } from "bun:test";
import type { EngineRequest } from "@telar/engine-client";
import {
  advance,
  answerFor,
  back,
  buildAnswers,
  canAdvance,
  emptyQuestionDraft,
  isLastQuestion,
  questionFields,
  selectOption,
  setCustomAnswer,
  type QuestionField,
} from "./question-drawer";

const one = (key: string, choices: string[]): QuestionField => ({ key, label: key, choices, multiple: false });
const any = (key: string, choices: string[]): QuestionField => ({ key, label: key, choices, multiple: true });

const fields = [one("Which color?", ["Red", "Blue"]), one("Which size?", ["S", "M", "L"])];
const color = fields[0]!;

describe("mutual exclusion", () => {
  const q = one("q", ["Red", "Blue"]);

  test("typing a custom answer evicts the selection, and picking an option clears the text", () => {
    let draft = selectOption(emptyQuestionDraft(), q, "Red");
    expect(answerFor(draft, q)).toBe("Red");
    draft = setCustomAnswer(draft, "q", "actually teal");
    expect(answerFor(draft, q)).toBe("actually teal");
    expect(draft.selected["q"]).toEqual([]);
    draft = selectOption(draft, q, "Blue");
    expect(answerFor(draft, q)).toBe("Blue");
    expect(draft.custom["q"]).toBe("");
  });

  test("deleting the text back to empty does not forget an option picked before typing", () => {
    let draft = selectOption(emptyQuestionDraft(), q, "Red");
    draft = setCustomAnswer(draft, "q", "");
    expect(answerFor(draft, q)).toBe("Red");
  });

  test("picking the selected option again unpicks it", () => {
    let draft = selectOption(emptyQuestionDraft(), q, "Red");
    draft = selectOption(draft, q, "Red");
    expect(answerFor(draft, q)).toBeUndefined();
  });

  test("a single question never holds two — picking replaces", () => {
    let draft = selectOption(emptyQuestionDraft(), q, "Red");
    draft = selectOption(draft, q, "Blue");
    expect(draft.selected["q"]).toEqual(["Blue"]);
    expect(answerFor(draft, q)).toBe("Blue");
  });
});

describe("a multi question", () => {
  const q = any("q", ["Red", "Blue", "Green"]);

  test("picks accumulate, and picking a chosen one again takes it back out", () => {
    let draft = selectOption(emptyQuestionDraft(), q, "Red");
    draft = selectOption(draft, q, "Green");
    expect(answerFor(draft, q)).toEqual(["Red", "Green"]);
    draft = selectOption(draft, q, "Red");
    expect(answerFor(draft, q)).toEqual(["Green"]);
    // …and back out of the last one is unanswered, not an empty array.
    draft = selectOption(draft, q, "Green");
    expect(answerFor(draft, q)).toBeUndefined();
    expect(canAdvance([q], draft)).toBe(false);
  });

  test("custom text evicts the WHOLE list, and answers as a one-element list", () => {
    let draft = selectOption(emptyQuestionDraft(), q, "Red");
    draft = selectOption(draft, q, "Blue");
    draft = setCustomAnswer(draft, "q", "actually teal");
    expect(draft.selected["q"]).toEqual([]);
    // The shape follows the FIELD, not what the human typed: a multi field
    // always answers with an array or the driver reads a different type.
    expect(answerFor(draft, q)).toEqual(["actually teal"]);
  });

  test("picking after typing clears the text, leaving one chosen label", () => {
    let draft = setCustomAnswer(emptyQuestionDraft(), "q", "actually teal");
    draft = selectOption(draft, q, "Blue");
    expect(draft.custom["q"]).toBe("");
    expect(answerFor(draft, q)).toEqual(["Blue"]);
  });

  test("an empty list blocks the submit — it is unanswered, not an answer of none", () => {
    const draft = { ...emptyQuestionDraft(), selected: { q: [] } };
    expect(canAdvance([q], draft)).toBe(false);
    expect(buildAnswers([q], draft)).toBeUndefined();
  });
});

describe("navigation", () => {
  test("Next unlocks only when the question on screen is answered", () => {
    let draft = emptyQuestionDraft();
    expect(canAdvance(fields, draft)).toBe(false);
    draft = selectOption(draft, color, "Blue");
    expect(canAdvance(fields, draft)).toBe(true);
    expect(isLastQuestion(fields, draft)).toBe(false);
    draft = advance(draft);
    expect(isLastQuestion(fields, draft)).toBe(true);
    expect(canAdvance(fields, draft)).toBe(false);
    expect(back(back(draft)).index).toBe(0);
  });
});

describe("the wire payload", () => {
  test("a partial form builds NOTHING — the driver must never hear half a form", () => {
    let draft = selectOption(emptyQuestionDraft(), color, "Blue");
    expect(buildAnswers(fields, draft)).toBeUndefined();
    draft = setCustomAnswer(draft, "Which size?", "XXL, if you have it");
    expect(buildAnswers(fields, draft)).toEqual({
      "Which color?": "Blue",
      "Which size?": "XXL, if you have it",
    });
  });

  test("one shape per kind in the same payload: a string for single, an array for multi", () => {
    const mixed = [one("Which color?", ["Red", "Blue"]), any("Which toppings?", ["Olive", "Caper", "Anchovy"])];
    let draft = selectOption(emptyQuestionDraft(), mixed[0]!, "Blue");
    draft = selectOption(draft, mixed[1]!, "Olive");
    draft = selectOption(draft, mixed[1]!, "Anchovy");
    expect(buildAnswers(mixed, draft)).toEqual({
      "Which color?": "Blue",
      "Which toppings?": ["Olive", "Anchovy"],
    });
  });

  test("a multi field picked exactly once still sends an array, not the bare label", () => {
    const only = [any("Which toppings?", ["Olive", "Caper"])];
    const draft = selectOption(emptyQuestionDraft(), only[0]!, "Caper");
    expect(buildAnswers(only, draft)).toEqual({ "Which toppings?": ["Caper"] });
  });
});

describe("which requests the drawer takes", () => {
  const request = (detail: unknown) => ({ detail }) as Pick<EngineRequest, "detail">;
  test("all-choice user_input only; anything with a text/secret/boolean field keeps the card", () => {
    expect(
      questionFields(
        request({ kind: "user_input", prompt: "p", fields: [{ key: "q", label: "q", kind: "choice", choices: ["a"], required: true }] }),
      ),
    ).toHaveLength(1);
    expect(
      questionFields(request({ kind: "user_input", prompt: "p", fields: [{ key: "q", label: "q", kind: "text", required: true }] })),
    ).toHaveLength(0);
    expect(questionFields(request({ kind: "command_execution", command: { command: "ls" } }))).toHaveLength(0);
    // A choice field with NO choices has nothing to draw as buttons.
    expect(
      questionFields(request({ kind: "user_input", prompt: "p", fields: [{ key: "q", label: "q", kind: "choice", choices: [], required: true }] })),
    ).toHaveLength(0);
  });

  test("`multiple` is read off the request, and absent reads as single", () => {
    const read = (multiple?: boolean) =>
      questionFields(
        request({
          kind: "user_input",
          prompt: "p",
          fields: [{ key: "q", label: "q", kind: "choice", choices: ["a", "b"], ...(multiple === undefined ? {} : { multiple }) }],
        }),
      )[0]?.multiple;
    expect(read(true)).toBe(true);
    // Absent and false are the same question, per the contract.
    expect(read(false)).toBe(false);
    expect(read()).toBe(false);
  });
});
