// Adversarial cross-check: distill.ts's output must always satisfy spec-lint.ts's
// rules by construction. This file wires the two modules together — neither
// unit-test file (distill.test.ts / spec-lint.test.ts) exercises them jointly.
import { describe, expect, test } from "bun:test";
import { distillSpec, type DistillFeature } from "../src/distill";
import { lintSpec } from "../src/spec-lint";
import { CriterionResult, VerifierReport } from "../src/schemas";

const BANNED = /\.locator\(|\.nth\(|page\.\$|xpath=|css=/;

const feature: DistillFeature = { name: "Checkout Flow", tags: ["@smoke", "@checkout"] };

function criterion(over: Partial<CriterionResult>): CriterionResult {
  return CriterionResult.parse({
    criterion: "does the thing",
    verdict: "pass",
    observed: "it did the thing",
    ...over,
  });
}

describe("distill -> lint — zero violations by construction", () => {
  test("repro-driven report: distilled spec is lint-clean", () => {
    const report = VerifierReport.parse({
      feature: "Checkout Flow",
      url: "https://shop.example.com/checkout",
      ok: true,
      summary: "all good",
      criteria: [
        criterion({
          criterion: "user can complete checkout with a valid card",
          observed: "order confirmation shown",
          repro: [
            { action: "navigate", target: "checkout page", value: "https://shop.example.com/checkout" },
            {
              action: "fill",
              target: "textbox labeled 'Card number'",
              value: "4242424242424242",
              locator: "getByLabel('Card number')",
            },
            { action: "click", target: "button 'Pay now'" },
            { action: "assert", target: "text 'Order confirmed'" },
          ],
        }),
        // a failing criterion must be excluded entirely from the distilled spec
        criterion({ criterion: "shows a validation error for an expired card", verdict: "fail" }),
      ],
    });
    const out = distillSpec(feature, report);
    expect(lintSpec(out)).toEqual([]);
  });

  test("locator-only report: distilled spec is lint-clean", () => {
    const report = VerifierReport.parse({
      feature: "Checkout Flow",
      url: "https://shop.example.com/cart",
      ok: true,
      summary: "ok",
      criteria: [
        criterion({
          criterion: "cart page shows totals and checkout button",
          observed: "totals visible",
          locators: [
            "getByRole('heading', { name: 'Your Cart' })",
            "page.getByRole('button', { name: 'Checkout' })",
            "getByTestId('cart-total')",
          ],
        }),
      ],
    });
    const out = distillSpec(feature, report);
    expect(lintSpec(out)).toEqual([]);
  });
});

describe("distill — getBy-only enforcement", () => {
  test("output matches none of the banned patterns and every locator token starts with page.getBy", () => {
    const report = VerifierReport.parse({
      feature: "Checkout Flow",
      url: "https://shop.example.com/checkout",
      ok: true,
      summary: "ok",
      criteria: [
        criterion({
          criterion: "shows totals",
          repro: [
            { action: "navigate", target: "cart page", value: "/cart" },
            { action: "click", target: "button 'Checkout'" },
            { action: "assert", target: "heading 'Order summary'" },
          ],
          locators: ["getByTestId('summary')"],
        }),
      ],
    });
    const out = distillSpec(feature, report);
    expect(BANNED.test(out)).toBe(false);

    // Every getBy* invocation in the emitted body must be reached via `page.`.
    const getByCalls = out.match(/\bgetBy\w+\(/g) ?? [];
    expect(getByCalls.length).toBeGreaterThan(0);
    for (const call of getByCalls) {
      const idx = out.indexOf(call);
      expect(out.slice(Math.max(0, idx - 5), idx)).toContain("page.");
    }
  });

  test("unsafe locator entries (raw CSS) are discarded, never emitted", () => {
    const report = VerifierReport.parse({
      feature: "Checkout Flow",
      url: "https://shop.example.com/checkout",
      ok: true,
      summary: "ok",
      criteria: [
        criterion({
          criterion: "shows the promo card",
          // task's own examples of unsafe raw selectors, mixed with one safe entry
          locators: ["div.card", ".foo > span", "getByRole('button', { name: 'Apply' })"],
        }),
      ],
    });
    const out = distillSpec(feature, report);
    expect(out).not.toContain("div.card");
    expect(out).not.toContain(".foo > span");
    expect(lintSpec(out)).toEqual([]);
    expect(out).toContain("await expect(page.getByRole('button', { name: 'Apply' })).toBeVisible();");
  });

  test("unsafe stored repro locator falls back to target-derived getBy, never emitted raw", () => {
    const report = VerifierReport.parse({
      feature: "Checkout Flow",
      url: "https://shop.example.com/checkout",
      ok: true,
      summary: "ok",
      criteria: [
        criterion({
          criterion: "applies the promo code",
          repro: [{ action: "click", target: "button 'Apply'", locator: "xpath=//button[1]" }],
        }),
      ],
    });
    const out = distillSpec(feature, report);
    expect(out).not.toContain("xpath=");
    expect(lintSpec(out)).toEqual([]);
  });
});

describe("lint enforcement — the gate actually catches what distill refuses to emit", () => {
  test("hand-injecting a `.locator()` call into a distilled spec trips no-locator at the right line", () => {
    const report = VerifierReport.parse({
      feature: "Checkout Flow",
      url: "https://shop.example.com/checkout",
      ok: true,
      summary: "ok",
      criteria: [
        criterion({
          criterion: "shows totals",
          locators: ["getByTestId('summary')"],
        }),
      ],
    });
    const clean = distillSpec(feature, report);
    expect(lintSpec(clean)).toEqual([]); // sanity: clean before injection

    const lines = clean.split("\n");
    const injectAt = lines.findIndex((l) => l.includes("test('shows totals'")) + 1;
    lines.splice(injectAt, 0, "    await page.locator('.foo').click();");
    const tampered = lines.join("\n");

    const violations = lintSpec(tampered);
    expect(violations).toContainEqual({
      line: injectAt + 1,
      rule: "no-locator",
      text: "await page.locator('.foo').click();",
    });
  });
});

describe("lint false positives — agent-authored criterion prose is not code", () => {
  test("criterion text mentioning a banned API as prose does not trip the lint gate", () => {
    const report = VerifierReport.parse({
      feature: "Checkout Flow",
      url: "https://shop.example.com/checkout",
      ok: true,
      summary: "ok",
      criteria: [
        criterion({
          criterion: "the page.locator('.foo') api still renders the button",
          locators: ["getByRole('button', { name: 'Apply' })"],
        }),
      ],
    });
    const out = distillSpec(feature, report);
    expect(lintSpec(out)).toEqual([]);
  });
});

describe("locator safety — chained brittle suffixes on an otherwise-safe locator", () => {
  test("getByRole(...).locator('.foo') is discarded rather than emitted verbatim", () => {
    const report = VerifierReport.parse({
      feature: "Checkout Flow",
      url: "https://shop.example.com/checkout",
      ok: true,
      summary: "ok",
      criteria: [
        criterion({
          criterion: "shows the promo card",
          locators: ["getByRole(\"button\", { name: \"X\" }).locator(\".foo\")"],
        }),
      ],
    });
    const out = distillSpec(feature, report);
    expect(lintSpec(out)).toEqual([]);
    expect(out).not.toContain(".locator(");
  });
});

describe("escaping — apostrophes in criterion text never break the string literal", () => {
  test("apostrophe-laden criterion produces a balanced, evaluable single-quoted title", () => {
    const report = VerifierReport.parse({
      feature: "Checkout Flow",
      url: "https://shop.example.com/checkout",
      ok: true,
      summary: "ok",
      criteria: [
        criterion({
          criterion: "the user's cart shows 'Free shipping' when it's eligible",
          locators: ["getByText('Free shipping')"],
        }),
      ],
    });
    const out = distillSpec(feature, report);
    expect(lintSpec(out)).toEqual([]);

    const titleLine = out.split("\n").find((l) => l.trimStart().startsWith("test('the user"));
    expect(titleLine).toBeDefined();
    const literal = titleLine!.match(/test\((.*'), \{/)![1];
    // must be a syntactically valid single-quoted JS string literal
    expect(eval(literal)).toBe("the user's cart shows 'Free shipping' when it's eligible");
  });
});
