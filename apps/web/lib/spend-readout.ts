// Story 4.1 / AC6 — a session's spend rendered in ITS OWN cost language.
//
// WHY THIS IS A MODULE AND NOT A TERNARY IN THE PILL. AD-18's rule is that the
// ledger record carries no currency and no unit (`UsageEntry` has neither field,
// and `packages/core/src/usage-ledger.ts`'s header says so in prose) — so the
// unit is a property of the PROJECTION, decided at render time from the
// session's provider. Putting that decision in one pure function is what lets
// the heartbeat pill and, later, the per-run anchor reach the same answer
// without either of them re-deriving it.
//
// PURE AND DEPENDENCY-FREE, in the shape of `apps/web/lib/escalation-kickoff.ts`:
// no React, no `@telar/core` (not even a type import), no fetch. Its only import
// is `@/lib/format`, which is itself importless — A1 requires reusing `fmtCost`
// and `fmtTokens` rather than minting a third formatter, and that reuse is what
// keeps a cost figure here byte-identical to one anywhere else in the app.
//
// WHAT IS MEASURED, and it is why the Codex arm exists at all. At `9a94632` the
// only provider-conditioned cost logic in the tree was
// `{provider !== "codex" && <CostPill total={sessionCost} />}` — a HIDE, whose
// own comment reasons that "a ChatGPT-subscription account has no per-token
// billing, so the figure is always $0.00 — a dead pill, not real spend." That
// reasoning is right about USD and is exactly why tokens are the correct
// substitute rather than nothing. Grepped across `components/session`,
// `components/dock` and `components/conversation`: there was NO token-denominated
// spend readout anywhere, and `fmtTokens` was used only for context occupancy.
// This function is the tokens half of AD-18's promise, built here for the first
// time.
//
// NOT A BUDGET (NFR-UW-7): a readout has no ceiling, no percentage and no
// reserved headroom. It states what was spent and stops.
import { fmtCost, fmtTokens } from "@/lib/format";

// The two providers this app runs sessions on. Spelled locally rather than
// imported as core's `ProviderId` so this module stays reachable from a
// "use client" file with no module edge into server-only code at all — the
// CLIENT-BUNDLE RULE (AD-3) is easiest to keep when there is nothing to erase.
export type SpendProvider = "claude" | "codex";

// A DISCRIMINATED readout, never a bare string: a caller that wants to style the
// two forms differently (or assert on them) reads `unit`, and a caller that just
// wants to print reads `text`. The numeric field travels with it so nothing
// downstream has to re-derive the figure from the formatted string.
export type SpendReadout =
  | { unit: "usd"; usd: number; text: string; title: string }
  | { unit: "tokens"; tokens: number; text: string; title: string };

// The projection. `usd` is the session's ledger-folded spend; `tokens` is the
// session's lifetime billable token count (input + output).
//
// WHY input + output AND NOT the cache fields: cache reads and cache writes are
// re-presentations of content the session already sent, so folding them in
// would make an idle session's figure climb every turn purely from re-sending
// the same transcript. Input + output is the work actually done, and it is the
// same pair `UsageEntry` carries per row — so story 4.2's per-run anchor can
// compute the identical figure from `ultraCostByMessage`'s sibling rows without
// consulting this file. Whatever the anchor chooses, it must be able to choose
// THIS.
export function spendReadout(
  provider: SpendProvider,
  spend: { usd: number; tokens: number },
): SpendReadout {
  if (provider === "codex") {
    const tokens = Math.max(0, spend.tokens);
    return {
      unit: "tokens",
      tokens,
      text: `${fmtTokens(tokens)} tok`,
      // Stated, not implied: the session really has no dollar figure, rather
      // than having one this surface declined to show.
      title: "Tokens spent this session — a ChatGPT-subscription account has no per-token billing",
    };
  }
  const usd = spend.usd;
  return { unit: "usd", usd, text: fmtCost(usd), title: "Spend this session, projected over the usage ledger" };
}
