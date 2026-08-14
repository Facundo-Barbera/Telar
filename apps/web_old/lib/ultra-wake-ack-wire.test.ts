// THE ACK FOLLOWS THE APPENDIX, NOT THE PROVIDER — pinned by source scan
// (this app has no DOM/route test environment; same discipline as
// compaction-wire.test.ts).
//
// The history this guards against repeating: story 4.1's ack block shipped
// behind a blanket `provider !== "codex"` guard, justified at the time because
// runCodexTurn took no systemPrompt — nothing composed for the appendix could
// reach a Codex model, so acking on a Codex turn would have marked a wake
// delivered having been delivered zero times. Five days later the harness-port
// commit wired the SAME appendix into Codex as `instructions`, and the guard
// silently inverted its own purpose: a Codex session now RECEIVED the completed
// Ultra runs block on every turn but never acked it, so the model was told the
// same outcome forever while the client's pending-wake badge never cleared.
// UI and model permanently disagreed, in both directions at once.
//
// The durable rule, which these scans pin: delivery is decided PER RUN by
// asking the composed prompt itself (appendixCarriesUltraWake), never per
// provider by a condition that has to be remembered when a provider's wiring
// changes.

// bun provides "bun:test" at runtime; @types/bun isn't a dependency of this Next
// app, so the web tsconfig (which includes **/*.ts) can't resolve it.
// @ts-expect-error no @types/bun in this workspace
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";

const route = readFileSync(new URL("../app/api/chat/route.ts", import.meta.url), "utf8");

describe("the wake ack is gated on delivery, not on the provider", () => {
  test("the ack block carries no provider condition", () => {
    // The stale guard, spelled exactly as it was — its reappearance in any
    // form around the ack is the regression.
    expect(route).not.toContain('sessionId && provider !== "codex"');
    expect(route).toContain('if (typeof sessionId === "string" && sessionId) {');
  });

  test("every acked run was first found in the composed appendix", () => {
    // The per-run gate that replaced the provider guard: the ids acked are
    // exactly the ids the prompt provably carries.
    expect(route).toContain(
      "appendixCarriesUltraWake(sessionProfile.systemPromptAppendix, runId)",
    );
    expect(route).toContain("ackUltraWakes(sessionId, carried)");
  });

  test("Codex actually receives the appendix the ack is measured against", () => {
    // What made the old guard wrong: the same string the delivery gate scans
    // is handed to the Codex turn as instructions. If this wiring is ever
    // removed, the per-run gate above still acks nothing (the appendix would
    // not be composed into the Codex prompt in the first place only if the
    // composer changes too — the gate asks the string, so it cannot drift).
    expect(route).toContain("instructions: sessionProfile.systemPromptAppendix");
  });
});
