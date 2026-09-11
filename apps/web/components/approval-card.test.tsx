/**
 * THE FORM CARD'S FIELD KINDS, pinned at the markup.
 *
 * The card is what renders a `user_input` request the composer's drawer will
 * not take — anything that is not all-choice. A `multiple` choice field there
 * used to be a `Select`, which can hold exactly one value: the human would
 * tick four things, watch three vanish, and send an answer they did not give.
 *
 * The boolean case is here for a reason that is easy to lose: the OpenCode
 * driver has long shipped multi-select by EXPLODING each option into its own
 * `kind: "boolean"` field, and those must keep rendering as switches. A change
 * to the choice branch that swept booleans up with it would silently break a
 * driver nobody was editing.
 */
// @ts-expect-error bun:test has no types in this app's tsconfig
import { describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import type { EngineRequest, UserInputField } from "@telar/engine-client";
import { ApprovalCard } from "./approval-card";

const render = (fields: unknown[]) =>
  renderToStaticMarkup(
    <ApprovalCard
      request={
        {
          id: "req_1",
          detail: { kind: "user_input", prompt: "Which toppings?", fields: fields as UserInputField[] },
        } as EngineRequest
      }
      sending={false}
      onDecide={() => {}}
    />,
  );

const choice = (extra: Record<string, unknown> = {}) => ({
  key: "toppings",
  label: "Which toppings?",
  kind: "choice",
  choices: ["Olive", "Caper", "Anchovy"],
  ...extra,
});

describe("a multiple choice field", () => {
  test("is a checkbox per option, not a dropdown that can only keep one", () => {
    const html = render([choice({ multiple: true })]);
    expect(html.match(/type="checkbox"/g) ?? []).toHaveLength(3);
    for (const option of ["Olive", "Caper", "Anchovy"]) expect(html).toContain(option);
    expect(html).not.toContain("Choose…");
  });

  test("names itself for the group rather than through a label it may not contain", () => {
    const html = render([choice({ multiple: true })]);
    // Per-option labels cannot nest inside a field label, so the group points
    // at its own title instead.
    expect(html).toContain('role="group"');
    expect(html).toContain('aria-labelledby="request-field-toppings-label"');
  });

  test("required and untouched, the submit is locked — an empty list is unanswered", () => {
    const html = render([choice({ multiple: true, required: true })]);
    expect(html).toContain('type="submit" data-disabled=""');
    // Nothing is pre-ticked; the lock is real rather than cosmetic.
    expect(html).not.toContain('type="checkbox" checked');
  });
});

describe("the kinds it must not disturb", () => {
  test("a single choice field is still the dropdown", () => {
    const html = render([choice()]);
    expect(html).not.toContain('type="checkbox"');
    expect(html).toContain("Choose…");
  });

  test("`multiple: false` is the same field as no flag at all", () => {
    expect(render([choice({ multiple: false })])).toBe(render([choice()]));
  });

  test("boolean fields stay switches — OpenCode ships multi-select as one field per option", () => {
    const html = render([
      { key: "0:Olive", label: "Olive", kind: "boolean" },
      { key: "1:Caper", label: "Caper", kind: "boolean" },
    ]);
    // Asserted on the GROUP, not on `type="checkbox"`: the switch renders its
    // own visually-hidden checkbox, so that string proves nothing here. What
    // must not happen is a boolean taking the multi-choice branch.
    expect(html).not.toContain('role="group"');
    expect(html.match(/role="switch"/g) ?? []).toHaveLength(2);
  });
});
