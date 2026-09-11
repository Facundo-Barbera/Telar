/**
 * WHAT A MULTI QUESTION LOOKS LIKE, and that a single one still looks the way
 * it did.
 *
 * These render the real drawer, the way `session/steering-boundary.test.tsx`
 * renders the real turn: the claims are about what reaches the screen, and a
 * checkbox that is only in the props is not one a person can act on.
 *
 * The one claim rendering cannot decide — that a pick on a multi does NOT
 * schedule the auto-advance hop — is asserted against the source, the same
 * reasoning `composer.test.ts` gives for its ordering claims. Its violation is
 * silent: the drawer would look right and simply walk off the question 200ms
 * after the first of several picks.
 */
// @ts-expect-error bun:test has no types in this app's tsconfig
import { describe, expect, test } from "bun:test";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { renderToStaticMarkup } from "react-dom/server";
import { ComposerQuestionDrawer } from "./composer-question-drawer";
import type { QuestionDraft, QuestionField } from "@/lib/question-drawer";

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
    // Three rows, three empty boxes: nothing is chosen and the question still
    // says "several are allowed".
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
  test("is guarded on the field being single — a multi must never walk off mid-answer", () => {
    const source = fs
      .readFileSync(path.join(fileURLToPath(new URL(".", import.meta.url)), "composer-question-drawer.tsx"), "utf8")
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .replace(/^\s*\/\/.*$/gm, "");
    const hop = source.indexOf("setTimeout");
    expect(hop).toBeGreaterThan(-1);
    // The guard is on the SAME condition that reaches the timeout, not merely
    // somewhere in the file.
    const guard = source.lastIndexOf("!field.multiple", hop);
    expect(guard).toBeGreaterThan(-1);
    expect(source.slice(guard, hop)).not.toContain("}");
  });
});
