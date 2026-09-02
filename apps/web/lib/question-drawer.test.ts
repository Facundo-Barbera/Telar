/**
 * The drawer's judgement calls, pinned: which answer wins, when Next unlocks,
 * and that a partial form can never build a wire payload.
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
} from "./question-drawer";

const fields = [
  { key: "Which color?", label: "Which color?", choices: ["Red", "Blue"] },
  { key: "Which size?", label: "Which size?", choices: ["S", "M", "L"] },
];

describe("mutual exclusion", () => {
  test("typing a custom answer evicts the selection, and picking an option clears the text", () => {
    let draft = selectOption(emptyQuestionDraft(), "q", "Red");
    expect(answerFor(draft, "q")).toBe("Red");
    draft = setCustomAnswer(draft, "q", "actually teal");
    expect(answerFor(draft, "q")).toBe("actually teal");
    expect(draft.selected["q"]).toBeUndefined();
    draft = selectOption(draft, "q", "Blue");
    expect(answerFor(draft, "q")).toBe("Blue");
    expect(draft.custom["q"]).toBe("");
  });

  test("deleting the text back to empty does not forget an option picked before typing", () => {
    let draft = selectOption(emptyQuestionDraft(), "q", "Red");
    draft = setCustomAnswer(draft, "q", "");
    expect(answerFor(draft, "q")).toBe("Red");
  });

  test("picking the selected option again unpicks it", () => {
    let draft = selectOption(emptyQuestionDraft(), "q", "Red");
    draft = selectOption(draft, "q", "Red");
    expect(answerFor(draft, "q")).toBeUndefined();
  });
});

describe("navigation", () => {
  test("Next unlocks only when the question on screen is answered", () => {
    let draft = emptyQuestionDraft();
    expect(canAdvance(fields, draft)).toBe(false);
    draft = selectOption(draft, "Which color?", "Blue");
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
    let draft = selectOption(emptyQuestionDraft(), "Which color?", "Blue");
    expect(buildAnswers(fields, draft)).toBeUndefined();
    draft = setCustomAnswer(draft, "Which size?", "XXL, if you have it");
    expect(buildAnswers(fields, draft)).toEqual({
      "Which color?": "Blue",
      "Which size?": "XXL, if you have it",
    });
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
});
