// @ts-expect-error bun:test has no types in this app's tsconfig
import { afterEach, describe, expect, jest, test } from "bun:test";
import { act } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { installTestDom, mount } from "@/test/dom";
import { ComposerQuestionDrawer } from "./composer-question-drawer";
import type { QuestionDraft, QuestionField } from "../question-drawer";

installTestDom();
afterEach(() => jest.useRealTimers());

const toppings = (multiple: boolean): QuestionField => ({
  key: "q",
  label: "Which toppings?",
  choices: ["Olive", "Caper", "Anchovy"],
  multiple,
});

const render = (field: QuestionField, selected: string[] = [], custom = "") =>
  renderToStaticMarkup(
    <ComposerQuestionDrawer
      fields={[field]}
      draft={{ index: 0, selected: { q: selected }, custom: { q: custom } } satisfies QuestionDraft}
      onDraft={() => {}}
      onCancelTurn={() => {}}
      sending={false}
    />,
  );

describe("a multi question", () => {
  test("every row carries a box, empty ones included — the affordance is legible before the first pick", () => {
    const html = render(toppings(true));
    expect(html.match(/lucide-square /g) ?? []).toHaveLength(3);
    expect(html).not.toContain("lucide-square-check");
  });

  test("a picked row fills its box and presses; the others stay empty", () => {
    const html = render(toppings(true), ["Caper"]);
    expect(html.match(/lucide-square-check/g) ?? []).toHaveLength(1);
    expect(html.match(/lucide-square /g) ?? []).toHaveLength(2);
    expect(html).toContain('aria-pressed="true"');
    expect(html.match(/aria-pressed="false"/g) ?? []).toHaveLength(2);
  });

  test("the digits stay on every row, picked or not — 1-9 still toggle", () => {
    const html = render(toppings(true), ["Olive"]);
    for (const digit of [">1<", ">2<", ">3<"]) expect(html).toContain(digit);
  });

  test('the hint keeps saying "Pick any" after a pick, so nothing reads as "that was the answer"', () => {
    expect(render(toppings(true))).toContain("Pick any, or type your own");
    expect(render(toppings(true), ["Olive"])).toContain("Pick any, Enter submits");
  });

  test("two questions deep, the hint offers to continue rather than submit", () => {
    const html = renderToStaticMarkup(
      <ComposerQuestionDrawer
        fields={[toppings(true), { key: "size", label: "Which size?", choices: ["S", "L"], multiple: false }]}
        draft={{ index: 0, selected: { q: ["Olive"] }, custom: {} }}
        onDraft={() => {}}
        onCancelTurn={() => {}}
        sending={false}
      />,
    );
    expect(html).toContain("Pick any, Enter continues");
  });
});

describe("a single question is untouched", () => {
  test("no box, no pressed state, and the round check on the one chosen row", () => {
    const html = render(toppings(false), ["Caper"]);
    expect(html).not.toContain("lucide-square");
    expect(html).not.toContain("aria-pressed");
    expect(html).toContain("lucide-check");
  });

  test('the hint still reads "Pick one"', () => {
    expect(render(toppings(false))).toContain("Pick one, or type your own");
    expect(render(toppings(false), ["Caper"])).toContain("Enter submits");
    expect(render(toppings(false), ["Caper"])).not.toContain("Pick any");
  });
});

describe("the auto-advance hop", () => {
  const size: QuestionField = { key: "size", label: "Which size?", choices: ["S", "L"], multiple: false };

  async function pickFirstOf(field: QuestionField) {
    jest.useFakeTimers();
    const drafts: QuestionDraft[] = [];
    await mount(
      <ComposerQuestionDrawer
        fields={[field, size]}
        draft={{ index: 0, selected: {}, custom: {} }}
        onDraft={(next) => drafts.push(next)}
        onCancelTurn={() => {}}
        sending={false}
      />,
    );
    const olive = [...document.querySelectorAll("button")].find((button) => button.textContent?.startsWith("Olive"))!;
    await act(async () => olive.click());
    await act(async () => jest.advanceTimersByTime(1_000));
    return drafts.map((draft) => draft.index);
  }

  test("a pick on a single question moves on to the next one", async () => {
    expect(await pickFirstOf(toppings(false))).toEqual([0, 1]);
  });

  test("a pick on a multi stays on the question — the person may pick more", async () => {
    expect(await pickFirstOf(toppings(true))).toEqual([0]);
  });
});
