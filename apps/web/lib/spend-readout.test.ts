// Story 4.1 / AC6 — the cost language is a property of the PROJECTION, and the
// record carries no unit SELECTOR.
//
// Not "no unit at all", which is what this header said until the story-4.1 code
// review (SF-9): a row carries a `costUsd` number and token counts side by side,
// and carries nothing that CHOOSES between them. That is the whole reason a
// projection has to decide.
//
// Two claims, and they are proved in two different places on purpose:
//   · "a property of the projection" — driven here, both providers, pure.
//   · "not the record" — the `UsageEntry` field-set assertion, which needs to see
//     the zod schema. It lives in `packages/core/test/usage-ledger.test.ts`,
//     because that is where the schema is in scope; §2 AC6 proof 1 permits
//     either home and asks that the choice be stated. This is the statement.
//     Its title, quoted so a grep for it resolves: "4.1 AC6 proof 1 — the ledger
//     RECORD carries no unit SELECTOR, so the language is the projection's".
//     (The title cited here originally — "AC6 the ledger record carries no
//     currency or unit field" — existed nowhere in the tree but this line.)
//
// No DOM, no disk, no core import. bun provides "bun:test" at runtime;
// @types/bun isn't a dependency of this Next app, so the web tsconfig can't
// resolve it — suppress just the import, exactly as store.test.ts does.
// @ts-expect-error no @types/bun in this workspace
import { describe, expect, test } from "bun:test";
import { fmtCost, fmtTokens } from "./format";
import { spendReadout, type SpendReadout } from "./spend-readout";

describe("spend readout — the session's cost language (AC6)", () => {
  test("a Claude session reads in USD", () => {
    const r = spendReadout("claude", { usd: 1.2345, tokens: 987_654 });
    expect(r.unit).toBe("usd");
    // Derived from the shared formatter, never restated — a test that hardcoded
    // "$1.2345" would keep passing if fmtCost's precision changed under it.
    expect(r.text).toBe(fmtCost(1.2345));
    if (r.unit !== "usd") throw new Error("unreachable");
    expect(r.usd).toBe(1.2345);
  });

  test("a Codex session reads in tokens — the substitute for a figure that is always $0.00", () => {
    const r = spendReadout("codex", { usd: 0, tokens: 12_345 });
    expect(r.unit).toBe("tokens");
    expect(r.text).toBe(`${fmtTokens(12_345)} tok`);
    if (r.unit !== "tokens") throw new Error("unreachable");
    expect(r.tokens).toBe(12_345);
    // The negative that matters: no dollar sign anywhere in what a Codex
    // session renders. The pre-4.1 tree hid the pill for exactly this reason.
    expect(r.text).not.toContain("$");
  });

  test("the two providers DISCRIMINATE on the same input — the unit is the projection's, not the record's", () => {
    // Same figures, two languages. Without this, a function that ignored
    // `provider` entirely would satisfy both tests above.
    const spend = { usd: 3.5, tokens: 2_000 };
    const claude = spendReadout("claude", spend);
    const codex = spendReadout("codex", spend);
    expect(claude.unit).not.toBe(codex.unit);
    expect(claude.text).not.toBe(codex.text);
    expect(claude.text).toContain("$");
    expect(codex.text).toContain("tok");
  });

  test("zero is rendered, not hidden — an honest $0.00 and an honest 0 tok", () => {
    expect(spendReadout("claude", { usd: 0, tokens: 0 }).text).toBe(fmtCost(0));
    expect(spendReadout("codex", { usd: 0, tokens: 0 }).text).toBe(`${fmtTokens(0)} tok`);
  });

  test("a negative token count cannot render — it clamps rather than printing nonsense", () => {
    // Not reachable from the ledger (every count is a sum of non-negative
    // fields), so this pins the guard rather than a behaviour anyone relies on.
    const r = spendReadout("codex", { usd: 0, tokens: -5 });
    if (r.unit !== "tokens") throw new Error("unreachable");
    expect(r.tokens).toBe(0);
  });

  test("NFR-UW-7 — a readout is not a budget: no ceiling, no percentage, no headroom", () => {
    const forms: SpendReadout[] = [
      spendReadout("claude", { usd: 12.5, tokens: 100 }),
      spendReadout("codex", { usd: 0, tokens: 100 }),
    ];
    for (const r of forms) {
      expect(r.text).not.toContain("%");
      expect(r.text).not.toContain("/");
      expect(r.text.toLowerCase()).not.toContain("left");
      expect(r.text.toLowerCase()).not.toContain("of");
    }
  });
});
